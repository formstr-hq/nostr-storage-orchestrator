//! Read engine: point queries route via the placement index to one provider;
//! broader SELECTs fan out to every active provider and merge. Buffered
//! (not-yet-dispatched) writes are overlaid so clients get read-your-writes.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::central::{CentralStore, MeshTable};
use crate::error::{GatewayError, Result};
use crate::provider::ProviderClient;
use crate::registry::ProviderRegistry;

/// Per-provider read timeout: a slow/hung provider drops out of a fan-out
/// (the query returns partial) instead of stalling the client. Point reads
/// fall through to the next replica on timeout.
pub(crate) const PROVIDER_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub struct ReadEngine {
    store: Arc<CentralStore>,
    registry: Arc<ProviderRegistry>,
    pub(crate) provider: ProviderClient,
}

#[derive(Debug, Clone)]
pub struct ReadResult {
    pub rows: Vec<Value>,
    /// True when only a subset of providers answered a fan-out query.
    pub partial: bool,
    /// Provider-declared column types from the first answering provider.
    pub columns: Vec<crate::provider::QueryColumn>,
}

impl ReadEngine {
    pub fn new(store: Arc<CentralStore>, registry: Arc<ProviderRegistry>, provider: ProviderClient) -> Self {
        Self { store, registry, provider }
    }

    pub async fn table(&self, name: &str) -> Result<MeshTable> {
        self.store
            .get_table(name)
            .await?
            .ok_or_else(|| GatewayError::UnknownTable(name.to_string()))
    }

    /// Executes a read. `row_id` is Some for point queries (WHERE pk = ...).
    pub async fn execute(&self, sql: &str, row_id: Option<&str>, pk_column: &str) -> Result<ReadResult> {
        match row_id {
            Some(row_id) => self.point_read(sql, row_id, pk_column).await,
            None => self.fanout_read(sql, pk_column).await,
        }
    }

    pub async fn point_read(&self, sql: &str, row_id: &str, pk_column: &str) -> Result<ReadResult> {
        // The read-your-writes overlay: a pending INSERT/UPDATE in the buffer
        // is authoritative until the dispatcher flushes it.
        let table_name = sql_table_name(sql)?;
        let pending = self.store.pending_rows(&table_name).await?;
        if let Some((_, Some(row))) = pending.iter().find(|(id, _)| id == row_id) {
            return Ok(ReadResult { rows: vec![row.clone()], partial: false, columns: vec![] });
        }

        // The replica filter below needs the pk column in the result set to
        // verify the returned row is the requested one. Providers return the
        // statement verbatim, so a narrow projection (knex `first('col')`)
        // would drop the pk — rewrite to fetch it alongside.
        let effective_sql = if projection_has_column(sql, pk_column) {
            sql.to_string()
        } else {
            add_column_to_projection(sql, pk_column)?
        };

        let Some((replicas, _)) = self.store.get_placement(&table_name, row_id).await? else {
            // Row never placed: fall through to a fan-out read, which also
            // covers tables whose placement entries predate this gateway.
            let result = self.fanout_read(&effective_sql, pk_column).await?;
            let rows = result
                .rows
                .into_iter()
                .filter(|row| {
                    row.get(pk_column).and_then(value_as_string).as_deref() == Some(row_id)
                })
                .collect();
            return Ok(ReadResult { rows, partial: result.partial, columns: result.columns });
        };

        for replica in &replicas {
            let Some(provider) = self.registry.resolve(replica) else {
                continue;
            };
            let replica_started = std::time::Instant::now();
            match tokio::time::timeout(
                PROVIDER_READ_TIMEOUT,
                self.provider.query_with_columns(&provider.url, &effective_sql),
            )
            .await
            {
                Ok(Ok((rows, columns))) => {
                    tracing::info!(
                        target: "query_metrics",
                        route = "point_read",
                        provider = %replica,
                        rows = rows.len(),
                        duration_ms = replica_started.elapsed().as_millis() as u64,
                        "provider read"
                    );
                    let rows = rows
                        .into_iter()
                        .filter(|row| {
                            row.get(pk_column).and_then(value_as_string).as_deref() == Some(row_id)
                        })
                        .collect();
                    return Ok(ReadResult { rows, partial: false, columns });
                }
                Ok(Err(error)) => {
                    tracing::warn!(
                        target: "query_metrics",
                        route = "point_read",
                        provider = %replica,
                        duration_ms = replica_started.elapsed().as_millis() as u64,
                        error = %error,
                        "provider read failed"
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        target: "query_metrics",
                        route = "point_read",
                        provider = %replica,
                        duration_ms = replica_started.elapsed().as_millis() as u64,
                        "provider read timed out"
                    );
                }
            }
        }
        Err(GatewayError::NoProviders)
    }

    pub async fn fanout_read(&self, sql: &str, pk_column: &str) -> Result<ReadResult> {
        let fanout_started = std::time::Instant::now();
        let providers = self.registry.providers();
        if providers.is_empty() {
            return Err(GatewayError::NoProviders);
        }
        let provider_count = providers.len();
        let mut handles = Vec::with_capacity(provider_count);
        for provider in providers {
            let client = self.provider.clone();
            let url = provider.url.clone();
            let sql = sql.to_string();
            handles.push(tokio::spawn(async move {
                let npub = provider.npub.clone();
                let provider_started = std::time::Instant::now();
                let result = tokio::time::timeout(
                    PROVIDER_READ_TIMEOUT,
                    client.query_with_columns(&url, &sql),
                )
                .await
                .unwrap_or_else(|_| Err(GatewayError::provider("read timed out")));
                (npub, result, provider_started.elapsed())
            }));
        }
        // Dedup by pk *when the projection includes it* — a JOIN's `events.*`
        // carries the pk, so per-tag duplicate rows collapse. When the pk is not
        // projected (e.g. `SELECT event_content`) we cannot dedup, so rows are
        // kept as-is; that is correct under exclusive placement because a row
        // lives on exactly one node, so there are no cross-node duplicates.
        let mut merged_index: HashMap<String, Value> = HashMap::new();
        let mut extra_rows: Vec<Value> = Vec::new();
        let mut answered = 0usize;
        let mut columns_out: Vec<crate::provider::QueryColumn> = Vec::new();
        for handle in handles {
            match handle.await {
                Ok((npub, Ok((rows, columns)), provider_elapsed)) => {
                    tracing::info!(
                        target: "query_metrics",
                        route = "fanout_read",
                        provider = %npub,
                        rows = rows.len(),
                        duration_ms = provider_elapsed.as_millis() as u64,
                        "provider read"
                    );
                    answered += 1;
                    if columns_out.is_empty() {
                        columns_out = columns;
                    }
                    for row in rows {
                        match row.get(pk_column).and_then(value_as_string) {
                            Some(pk) => {
                                merged_index.entry(pk).or_insert(row);
                            }
                            None => extra_rows.push(row),
                        }
                    }
                }
                Ok((npub, Err(error), provider_elapsed)) => {
                    tracing::warn!(
                        target: "query_metrics",
                        route = "fanout_read",
                        provider = %npub,
                        duration_ms = provider_elapsed.as_millis() as u64,
                        error = %error,
                        "provider read failed"
                    );
                }
                Err(join_error) => {
                    tracing::warn!("fan-out read task failed: {join_error}");
                }
            }
        }
        if answered == 0 {
            return Err(GatewayError::NoProviders);
        }
        let mut rows: Vec<Value> = merged_index.into_values().collect();
        rows.extend(extra_rows);
        // Buffer overlay: pending rows shadow provider rows. Skipped for joins —
        // the overlay keys on the base table's pk and cannot re-check the join
        // predicate against a pending row (would surface non-matching rows).
        if !crate::sqlanalyze::has_join(sql) {
        if let Ok(table_name) = sql_table_name(sql) {
            for (row_id, pending_row) in self.store.pending_rows(&table_name).await? {
                let Some(row) = pending_row else { continue };
                rows.retain(|existing| {
                    existing.get(pk_column).and_then(value_as_string).as_deref() != Some(row_id.as_str())
                });
                rows.push(row);
            }
        }
        }
        tracing::info!(
            target: "query_metrics",
            route = "fanout_read",
            providers_answered = answered,
            providers_total = provider_count,
            rows = rows.len(),
            partial = answered < provider_count,
            duration_ms = fanout_started.elapsed().as_millis() as u64,
            "fan-out read merged"
        );
        Ok(ReadResult { rows, partial: answered < provider_count, columns: columns_out })
    }
}

fn sql_table_name(sql: &str) -> crate::error::Result<String> {
    let analyzed = crate::sqlanalyze::analyze(sql)?;
    match analyzed {
        crate::sqlanalyze::AnalyzedStatement::Read { .. } => {
            // Re-parse to pull the table (analyze validates it exists).
            let statements = sqlparser::parser::Parser::parse_sql(
                &sqlparser::dialect::GenericDialect {},
                sql,
            )
            .map_err(|error| GatewayError::UnsupportedSql(error.to_string()))?;
            for statement in statements {
                if let sqlparser::ast::Statement::Query(query) = statement {
                    if let sqlparser::ast::SetExpr::Select(select) = query.body.as_ref() {
                        if let Some(from) = select.from.first() {
                            if let sqlparser::ast::TableFactor::Table { name, .. } = &from.relation {
                                return Ok(name.0[0].as_ident().map(|ident| ident.value.clone()).unwrap_or_default());
                            }
                        }
                    }
                }
            }
            Err(GatewayError::UnsupportedSql("could not resolve read table".to_string()))
        }
        _ => Err(GatewayError::UnsupportedSql("expected a read statement".to_string())),
    }
}

/// True when the statement's projection already includes `column` (explicitly
/// or via `*` / `table.*`). Conservative: unknown shapes return true so the
/// statement is executed as-is.
fn projection_has_column(sql: &str, column: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    let Some(select_pos) = lower.find("select") else { return true };
    let Some(from_pos) = lower[select_pos..].find(" from ") else { return true };
    let projection = &lower[select_pos + 6..select_pos + from_pos];
    if projection.contains('*') {
        return true;
    }
    projection
        .split(',')
        .any(|item| {
            let item = item.trim();
            let name = item.rsplit('.').next().unwrap_or(item);
            name.trim() == column
        })
}

/// Rewrites `SELECT <proj> FROM ...` to also project `column`, preserving
/// the original projection so column order/shape stays client-visible.
fn add_column_to_projection(sql: &str, column: &str) -> crate::error::Result<String> {
    let lower = sql.to_ascii_lowercase();
    let select_pos = lower
        .find("select")
        .ok_or_else(|| GatewayError::UnsupportedSql("expected SELECT".to_string()))?;
    let from_offset = lower[select_pos..]
        .find(" from ")
        .ok_or_else(|| GatewayError::UnsupportedSql("expected FROM".to_string()))?
        + select_pos;
    let mut rewritten = String::with_capacity(sql.len() + column.len() + 3);
    rewritten.push_str(&sql[..select_pos + 6]);
    rewritten.push(' ');
    rewritten.push_str(column);
    rewritten.push_str(", ");
    rewritten.push_str(sql[select_pos + 6..from_offset].trim());
    rewritten.push_str(&sql[from_offset..]);
    Ok(rewritten)
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            // pg-agent serializes bytea as "\\x<hex>"; row ids (and wire
            // literals) carry the bare hex, so strip the prefix.
            text.strip_prefix("\\x").map(|rest| rest.to_string()).or_else(|| Some(text.clone()))
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        // pg-agent used to serialize bytea as an array of byte ints;
        // tolerate both forms.
        Value::Array(items) => {
            let hex: Option<String> = items
                .iter()
                .map(|item| item.as_u64().map(|byte| format!("{byte:02x}")))
                .collect();
            hex
        }
        _ => None,
    }
}