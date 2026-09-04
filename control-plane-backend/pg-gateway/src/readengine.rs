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
use crate::sqlanalyze::PK_COLUMN;

pub struct ReadEngine {
    store: Arc<CentralStore>,
    registry: Arc<ProviderRegistry>,
    provider: ProviderClient,
}

#[derive(Debug, Clone)]
pub struct ReadResult {
    pub rows: Vec<Value>,
    /// True when only a subset of providers answered a fan-out query.
    pub partial: bool,
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

    /// Executes a read. `row_id` is Some for point queries (WHERE id = ...).
    pub async fn execute(&self, sql: &str, row_id: Option<&str>) -> Result<ReadResult> {
        match row_id {
            Some(row_id) => self.point_read(sql, row_id).await,
            None => self.fanout_read(sql).await,
        }
    }

    pub async fn point_read(&self, sql: &str, row_id: &str) -> Result<ReadResult> {
        // The read-your-writes overlay: a pending INSERT/UPDATE in the buffer
        // is authoritative until the dispatcher flushes it.
        let table_name = sql_table_name(sql)?;
        let pending = self.store.pending_rows(&table_name).await?;
        if let Some((_, Some(row))) = pending.iter().find(|(id, _)| id == row_id) {
            return Ok(ReadResult { rows: vec![row.clone()], partial: false });
        }

        let Some((replicas, _)) = self.store.get_placement(&table_name, row_id).await? else {
            // Row never placed: fall through to a fan-out read, which also
            // covers tables whose placement entries predate this gateway.
            let result = self.fanout_read(sql).await?;
            let pk = PK_COLUMN;
            let rows = result
                .rows
                .into_iter()
                .filter(|row| {
                    row.get(pk).and_then(value_as_string).as_deref() == Some(row_id)
                })
                .collect();
            return Ok(ReadResult { rows, partial: result.partial });
        };

        for replica in &replicas {
            let Some(provider) = self.registry.resolve(replica) else {
                continue;
            };
            match self.provider.query(&provider.url, sql).await {
                Ok(rows) => {
                    let rows = rows
                        .into_iter()
                        .filter(|row| {
                            row.get(PK_COLUMN).and_then(value_as_string).as_deref() == Some(row_id)
                        })
                        .collect();
                    return Ok(ReadResult { rows, partial: false });
                }
                Err(error) => {
                    tracing::warn!("point read from {replica} failed: {error}");
                }
            }
        }
        Err(GatewayError::NoProviders)
    }

    pub async fn fanout_read(&self, sql: &str) -> Result<ReadResult> {
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
                (npub, client.query(&url, &sql).await)
            }));
        }
        let mut merged_index: HashMap<String, Value> = HashMap::new();
        let mut answered = 0usize;
        for handle in handles {
            match handle.await {
                Ok((_npub, Ok(rows))) => {
                    answered += 1;
                    for row in rows {
                        let pk = row.get(PK_COLUMN).and_then(value_as_string).unwrap_or_default();
                        merged_index
                            .entry(pk)
                            .or_insert(row);
                    }
                }
                Ok((npub, Err(error))) => {
                    tracing::warn!("fan-out read from {npub} failed: {error}");
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
        // Buffer overlay: pending rows shadow provider rows.
        if let Ok(table_name) = sql_table_name(sql) {
            for (row_id, pending_row) in self.store.pending_rows(&table_name).await? {
                let Some(row) = pending_row else { continue };
                rows.retain(|existing| {
                    existing.get(PK_COLUMN).and_then(value_as_string).as_deref() != Some(row_id.as_str())
                });
                rows.push(row);
            }
        }
        Ok(ReadResult { rows, partial: answered < provider_count })
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

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}