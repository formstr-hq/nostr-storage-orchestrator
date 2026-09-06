//! pgwire server glue: startup auth, simple + extended query handling.
//!
//! Both protocols funnel into `execute_sql`, which routes to the DDL manager,
//! the write buffer, or the read engine. Extended-protocol bookkeeping
//! (portal store, parse/bind/describe/close messages) is reused from pgwire's
//! default trait implementations; we only supply `do_query` for both
//! protocols and a parameter-aware `QueryParser`.

use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use futures::{Sink, SinkExt, StreamExt};
use pgwire::api::auth::StartupHandler;
use pgwire::api::auth::cleartext::CleartextPasswordAuthStartupHandler;
use pgwire::api::auth::{AuthSource, DefaultServerParameterProvider, LoginInfo, Password};
use pgwire::api::copy::CopyHandler;
use pgwire::api::portal::{Format, Portal};
use pgwire::api::query::{ExtendedQueryHandler, SimpleQueryHandler};
use pgwire::api::results::{DescribePortalResponse, DescribeStatementResponse, FieldFormat, FieldInfo, QueryResponse, Response};
use pgwire::api::stmt::{QueryParser, StoredStatement};
use pgwire::api::store::PortalStore;
use pgwire::api::{ClientInfo, ClientPortalStore, PgWireServerHandlers, Type};
use pgwire::error::{ErrorInfo, PgWireError, PgWireResult};
use pgwire::messages::extendedquery::Sync as PgSync;
use pgwire::messages::response::ReadyForQuery;
use pgwire::messages::{PgWireBackendMessage, PgWireFrontendMessage};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::central::{CatalogStore, CentralStore};
use crate::error::GatewayError;
use crate::provider::ProviderClient;
use crate::readengine::ReadEngine;
use crate::registry::ProviderRegistry;
use crate::schema::SchemaManager;
use crate::sqlanalyze::{self, AnalyzedStatement, StatementKind};

#[derive(Clone)]
pub struct GatewayHandlers {
    pub store: Arc<CentralStore>,
    pub catalog: Arc<CatalogStore>,
    pub registry: Arc<ProviderRegistry>,
    pub provider: ProviderClient,
    pub schema: Arc<SchemaManager>,
    pub read: Arc<ReadEngine>,
    /// Serializes write-path buffer mutations globally: enqueue + placement
    /// upsert must be atomic from the client's perspective.
    pub write_lock: Arc<Mutex<()>>,
    pub auth_password: Option<String>,
    pub broad_writes_enabled: bool,
}

pub enum Outcome {
    /// Materialized row set.
    Rows(Vec<Column>, Vec<Vec<Option<String>>>, usize),
    /// Command completion tag, with affected row count.
    Command(String, usize),
    /// Session command handled locally (BEGIN/SET/SHOW...).
    Session,
}

#[derive(Clone, Debug)]
pub struct Column {
    pub name: String,
    pub type_oid: u32,
}

/// Describe-timeout: the shape probe must never hang a client on slow
/// providers. Cheap by design (registry metadata + catalog prepare only).
const DESCRIBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

impl GatewayHandlers {
    /// Column shape for a SELECT without touching providers: the registry's
    /// declared columns. Fully async — must never block the runtime.
    async fn describe_columns_for_read(&self, sql: &str) -> Vec<Column> {
        match sqlanalyze::read_table_name(sql) {
            Some(table) => {
                let deadline = tokio::time::timeout(DESCRIBE_TIMEOUT, self.read.table(&table)).await;
                match deadline {
                    Ok(Ok(table_def)) => table_columns_as_columns(&table_def),
                    _ => vec![],
                }
            }
            None => vec![],
        }
    }
    fn error(&self, error: &GatewayError) -> PgWireError {
        let code = match error {
            GatewayError::UnknownTable(_) => "42P01",
            GatewayError::WriteRequiresPk(_) | GatewayError::UnsupportedSql(_) => "0A000",
            GatewayError::NoProviders => "08006",
            _ => "XX000",
        };
        PgWireError::UserError(Box::new(ErrorInfo::new(
            "ERROR".to_string(),
            code.to_string(),
            error.to_wire_message(),
        )))
    }

    /// Runs one SQL statement. `bound_row_id` carries the primary-key literal
    /// for extended-protocol writes (resolved from bound parameters); simple
    /// queries carry literals inline.
    pub async fn execute_sql(&self, sql: &str, bound_row_id: Option<&str>) -> Result<Outcome, GatewayError> {
        self.execute_sql_bound(sql, bound_row_id, &[]).await
    }

    /// Full binding: params are text-format values (None = NULL), indexed
    /// from $1. Only used by the catalog path today.
    pub async fn execute_sql_bound(
        &self,
        sql: &str,
        bound_row_id: Option<&str>,
        params: &[Option<String>],
    ) -> Result<Outcome, GatewayError> {
        if sqlanalyze::is_session_command(sql) {
            return Ok(Outcome::Session);
        }
        // Catalog introspection & bookkeeping (pg_catalog, information_schema,
        // knex_migrations...) never touches providers: it is answered from a
        // real local catalog schema on the orchestrator.
        if let Some(outcome) = self.catalog_request(sql, params).await? {
            return Ok(outcome);
        }
        // pk-aware analysis: resolve the table's declared pk (registry) so
        // point-write/read detection and conflict targets use the real pk
        // (e.g. users.pubkey), falling back to `id` for unregistered tables.
        let table_name_for_pk = sqlanalyze::write_or_read_table(sql)
            .or_else(|| sqlanalyze::read_table_name(sql));
        let pk_column: Option<String> = match table_name_for_pk.as_deref() {
            Some(table) => match self.store.get_table(table).await {
                Ok(Some(table_def)) => Some(sqlanalyze::pk_column_of(&table_def)),
                _ => None,
            },
            None => None,
        };
        let analyzed = match sqlanalyze::analyze_with_pk(sql, pk_column.as_deref()) {
            Ok(analyzed) => analyzed,
            Err(parse_error) => {
                // Multi-statement / exotic DDL batches (e.g. knex ALTER
                // batches) fail to parse; fall through to the verbatim DDL
                // fallback when enabled, otherwise surface the error.
                let broad_dml = {
                    let lower = sql.trim().to_ascii_lowercase();
                    (lower.starts_with("delete") || lower.starts_with("update") || lower.starts_with("with"))
                        && self.broad_writes_enabled
                };
                if self.broad_writes_enabled && (is_ddl_text(sql) || broad_dml) {
                    return self.fallback_ddl(AnalyzedStatement::Read { sql: String::new() }, sql, params).await;
                }
                return Err(parse_error);
            }
        };
        match analyzed {
            AnalyzedStatement::Read { .. } => {
                // Point reads (single equality on pk) route to one provider;
                // everything else fans out.
                //
                // Prefer the analyzer's literal extraction over `bound_row_id`
                // when params were inlined: the bound value is the raw wire
                // bytes (binary pks are not UTF-8) while the inlined SQL
                // carries the canonical hex form — they must match for the
                // placement lookup.
                let point = if !params.is_empty() {
                    sqlanalyze::point_read_row_id_with_pk(sql, pk_column.as_deref().unwrap_or(sqlanalyze::PK_COLUMN))
                        .ok()
                        .flatten()
                } else {
                    bound_row_id
                        .map(|id| id.to_string())
                        .or_else(|| {
                            sqlanalyze::point_read_row_id_with_pk(sql, pk_column.as_deref().unwrap_or(sqlanalyze::PK_COLUMN))
                                .ok()
                                .flatten()
                        })
                };
                let pk_name = pk_column.clone().unwrap_or_else(|| sqlanalyze::PK_COLUMN.to_string());
                let result = match point {
                    Some(row_id) => {
                        let effective_sql = if params.is_empty() {
                            sql.to_string()
                        } else {
                            inline_params(sql, params)?
                        };
                        self.read.point_read(&effective_sql, &row_id, &pk_name).await
                    }
                    None => {
                        let effective_sql = if params.is_empty() {
                            sql.to_string()
                        } else {
                            inline_params(sql, params)?
                        };
                        self.read.fanout_read(&effective_sql, &pk_name).await
                    },
                }?;
                let table = sqlanalyze::read_table_name(sql).unwrap_or_default();
                let columns = apply_provider_oids(
                    infer_columns(&result.rows, &table),
                    &result.columns,
                );
                let count = result.rows.len();
                let rows = result
                    .rows
                    .iter()
                    .map(|row| {
                        columns
                            .iter()
                            .map(|column| {
                                row.get(&column.name).and_then(value_to_wire_text)
                            })
                            .collect::<Vec<Option<String>>>()
                    })
                    .collect();
                Ok(Outcome::Rows(columns, rows, count))
            }
            AnalyzedStatement::Ddl { kind, table, sql } => {
                // Non-additive alterations (DROP COLUMN, ALTER TYPE) fall
                // through to the verbatim DDL fallback when enabled.
                if sqlanalyze::is_additive_ddl(&kind, sql.as_str()).is_err() {
                    let sql_owned = sql.clone();
                    let analyzed_copy = AnalyzedStatement::Ddl {
                        kind: StatementKind::Alter,
                        table: table.clone(),
                        sql: sql_owned.clone(),
                    };
                    return self.fallback_ddl(analyzed_copy, sql_owned.as_str(), params).await;
                }
                // Index DDL doesn't register tables; it propagates + mirrors.
                if kind != StatementKind::CreateIndex {
                    self.schema.handle_ddl(kind.clone(), &table, &sql).await?;
                } else {
                    self.schema.propagate_ddl(&sql).await?;
                }
                // Mirror the DDL to the catalog schema so introspection sees it.
                if let Err(error) = self.catalog.apply_ddl(&sql).await {
                    tracing::warn!("catalog ddl mirror failed: {error}");
                }
                let tag = match kind {
                    StatementKind::Create => "CREATE TABLE",
                    StatementKind::CreateIndex => "CREATE INDEX",
                    StatementKind::Alter => "ALTER TABLE",
                    StatementKind::Drop => "DROP TABLE",
                    _ => "DDL",
                };
                Ok(Outcome::Command(tag.to_string(), 0))
            }
            AnalyzedStatement::Write { kind, table, row_id, sql, row_id_placeholder, generate_row_id, returning, broad, conflict_columns } => {
                // Bulk ops (migration backfills): apply the statement
                // verbatim to EVERY active provider so replicas stay
                // identical; no buffer, no placement bookkeeping.
                if broad {
                    return self.apply_broad_write(kind, &table, sql.as_str(), params).await;
                }
                // Resolve the pk: bound param > literal > gateway allocation.
                let row_id = if let Some(placeholder) = row_id_placeholder.as_deref() {
                    bound_row_id
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| {
                            format!("\x1ePARAM:{placeholder}")
                        })
                } else if generate_row_id {
                    String::new() // allocated below under the write lock
                } else {
                    row_id
                };
                let is_bound_placeholder = row_id_placeholder.is_some() && bound_row_id.is_none();

                let _guard = self.write_lock.lock().await;
                let table_def = self.read.table(&table).await?;
                // The table's declared pk governs everything downstream:
                // materialization, placement key, conflict target, reads.
                let pk_name = sqlanalyze::pk_column_of(&table_def);

                // Authoritative execution: run the INSERT against the
                // orchestrator PG, which owns the mesh tables (mirrored DDL) and
                // resolves ids/defaults/sequences/now(). The returned row is the
                // image replicated verbatim to every provider — no gateway-side
                // row materialization, no column mapping.
                let captured = match kind {
                    StatementKind::Insert => {
                        if is_bound_placeholder {
                            return Err(GatewayError::UnsupportedSql(
                                "bound-parameter writes are not supported yet; inline the values".to_string(),
                            ));
                        }
                        let capture_sql = sqlanalyze::insert_capture_sql(sql.as_str())?;
                        let mut rows = self.store.execute_capture(&capture_sql).await?;
                        if rows.is_empty() {
                            // ON CONFLICT DO NOTHING and friends: nothing written.
                            return Ok(Outcome::Command("INSERT".to_string(), 0));
                        }
                        Some(rows.remove(0))
                    }
                    _ => None,
                };
                let row_id = match &captured {
                    Some(row) => row
                        .get(&pk_name)
                        .and_then(value_to_wire_text)
                        .ok_or_else(|| GatewayError::UnsupportedSql(format!(
                            "table has no primary-key column; expected \"{pk_name}\""
                        )))?,
                    None => {
                        if is_bound_placeholder {
                            return Err(GatewayError::UnsupportedSql(
                                "bound-parameter writes are not supported yet; inline the values".to_string(),
                            ));
                        }
                        row_id
                    }
                };

                let providers = self.registry.providers();
                // Exclusive database-node placement: exactly one node owns the
                // row, chosen by hash(pk) for an even spread and sticky-reused
                // if the row is already placed. Mirrors the dispatcher.
                let existing = self
                    .store
                    .get_placement(&table, &row_id)
                    .await?
                    .map(|(replicas, _)| replicas)
                    .unwrap_or_default();
                let replicas = match crate::registry::select_owner(&row_id, &providers, &existing) {
                    Some(owner) => vec![owner],
                    None => return Err(GatewayError::NoProviders),
                };
                let op_name = match kind {
                    StatementKind::Insert => "INSERT",
                    StatementKind::Update => "UPDATE",
                    StatementKind::Delete => "DELETE",
                    _ => return Err(GatewayError::UnsupportedSql("unexpected write kind".to_string())),
                };
                // INSERTs buffer the full materialized row (read-your-writes +
                // identical replicas); UPDATE/DELETE apply by row id on
                // providers, so the payload keeps the statement.
                let mut payload = captured
                    .or_else(|| Some(serde_json::json!({ "sql": sql })));
                // Carry the conflict target for the provider's upsert.
                // Default: the table's declared pk — the upsert must key on
                // the real pk (e.g. users.pubkey), not an assumed `id`.
                let conflict_target = conflict_columns
                    .clone()
                    .filter(|columns| !columns.is_empty())
                    .unwrap_or_else(|| vec![pk_name.clone()]);
                if let Some(object) = payload.as_mut().and_then(|value| value.as_object_mut()) {
                    object.insert(
                        "_conflictColumns".to_string(),
                        serde_json::json!(conflict_target),
                    );
                }
                let op_id = ulid::Ulid::new().to_string();
                self.store
                    .enqueue_write_op(&op_id, &table, op_name, &row_id, payload.as_ref())
                    .await?;
                self.store
                    .upsert_placement(&table, &row_id, &replicas, "PENDING")
                    .await?;
                match returning {
                    Some(returned_columns) if !returned_columns.is_empty() => {
                        // Gateway-synthesized RETURNING: it knows every value.
                        let all_columns = table_columns_as_columns(&table_def);
                        let selected: Vec<Column> = all_columns
                            .iter()
                            .filter(|column| returned_columns.iter().any(|name| name.eq_ignore_ascii_case(&column.name)))
                            .cloned()
                            .collect();
                        let full_row = payload_row_to_wire(&payload, &table_def);
                        let indexes: Vec<usize> = selected
                            .iter()
                            .map(|column| {
                                all_columns
                                    .iter()
                                    .position(|candidate| candidate.name == column.name)
                                    .unwrap_or(usize::MAX)
                            })
                            .collect();
                        let row: Vec<Option<String>> = indexes
                            .iter()
                            .map(|index| full_row.get(*index).cloned().unwrap_or(None))
                            .collect();
                        Ok(Outcome::Rows(selected, vec![row], 1))
                    }
                    Some(_) => {
                        // RETURNING * — return all registry columns.
                        let columns = table_columns_as_columns(&table_def);
                        let row = payload_row_to_wire(&payload, &table_def);
                        Ok(Outcome::Rows(columns, vec![row], 1))
                    }
                    None => Ok(Outcome::Command(op_name.to_string(), 1)),
                }
            }
            other => self.fallback_ddl(other, sql, params).await,
        }
    }

    /// Fallback for DDL the strict analyzer rejects (multi-statement ALTER
    /// batches, ALTER COLUMN TYPE, etc.). Executed verbatim on every provider
    /// (schema transformation) and mirrored to the catalog. Only when broad
    /// writes are enabled; otherwise the analyzer error surfaces.
    async fn fallback_ddl(
        &self,
        analyzed: AnalyzedStatement,
        sql: &str,
        params: &[Option<String>],
    ) -> Result<Outcome, GatewayError> {
        // Only DDL-shaped statements get the fallback; DML errors propagate.
        let lower = sql.trim().to_ascii_lowercase();
        let is_ddl = lower.starts_with("create")
            || lower.starts_with("alter")
            || lower.starts_with("drop")
            || lower.starts_with("delete")
            || lower.starts_with("update")
            || lower.starts_with("with");
        if !is_ddl {
            return Err(analyze_error(sql));
        }
        if !self.broad_writes_enabled {
            return Err(analyze_error(sql));
        }
        let effective_sql = if params.is_empty() {
            sql.to_string()
        } else {
            inline_params(sql, params)?
        };
        for provider in &self.registry.providers() {
            let op = crate::provider::WriteOpPayload {
                id: ulid::Ulid::new().to_string(),
                table_name: String::new(),
                op: "RAW".to_string(),
                row_id: String::new(),
                row: Some(serde_json::json!({ "sql": effective_sql })),
                conflict_columns: None,
            };
            self.provider
                .apply(&provider.url, &crate::provider::ApplyRequest { ops: vec![op] })
                .await
                .map_err(|error| GatewayError::provider(error.to_string()))?;
        }
        if let Err(error) = self.catalog.apply_ddl(&effective_sql).await {
            tracing::warn!("catalog ddl mirror failed: {error}");
        }
        Ok(Outcome::Command("DDL".to_string(), 0))
    }

    /// Applies a broad UPDATE/DELETE verbatim on every provider (RAW op).
    /// Used by migration backfills; requires PG_ENABLE_BROAD_WRITES.
    async fn apply_broad_write(
        &self,
        kind: StatementKind,
        _table: &str,
        sql: &str,
        params: &[Option<String>],
    ) -> Result<Outcome, GatewayError> {
        if !self.broad_writes_enabled {
            return Err(GatewayError::WriteRequiresPk(
                "bulk UPDATE/DELETE without a pk predicate is not supported by mesh-PG".to_string(),
            ));
        }
        let providers = self.registry.providers();
        if providers.is_empty() {
            return Err(GatewayError::NoProviders);
        }
        let effective_sql = if params.is_empty() {
            sql.to_string()
        } else {
            inline_params(sql, params)?
        };
        // Apply to the authoritative buffer (orchestrator PG) too. Otherwise a
        // broad UPDATE/DELETE only lands on providers and the buffer diverges:
        // stale rows linger, re-inserts hit duplicate-key, and the
        // read-your-writes overlay can resurrect deleted rows. Triggers fire
        // here as well, keeping derived tables (event_tags) consistent.
        self.store.execute_capture(&effective_sql).await?;
        for provider in &providers {
            let op = crate::provider::WriteOpPayload {
                id: ulid::Ulid::new().to_string(),
                table_name: String::new(),
                op: "RAW".to_string(),
                row_id: String::new(),
                row: Some(serde_json::json!({ "sql": effective_sql })),
                conflict_columns: None,
            };
            self.provider
                .apply(&provider.url, &crate::provider::ApplyRequest { ops: vec![op] })
                .await
                .map_err(|error| GatewayError::provider(error.to_string()))?;
        }
        let verb = match kind {
            StatementKind::Update => "UPDATE",
            StatementKind::Delete => "DELETE",
            _ => "OK",
        };
        Ok(Outcome::Command(verb.to_string(), 0))
    }
}

fn infer_columns(rows: &[Value], _table: &str) -> Vec<Column> {
    let mut columns: Vec<Column> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(object) = row.as_object() {
            for key in object.keys() {
                if seen.insert(key.clone()) {
                    columns.push(Column { name: key.clone(), type_oid: Type::TEXT.oid() });
                }
            }
        }
    }
    columns
}

/// Merges provider-declared OIDs into the inferred column list.
fn apply_provider_oids(mut columns: Vec<Column>, provider: &[crate::provider::QueryColumn]) -> Vec<Column> {
    for provider_column in provider {
        if let Some(column) = columns.iter_mut().find(|column| column.name == provider_column.name) {
            column.type_oid = provider_column.oid;
        }
    }
    columns
}

fn value_to_wire_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(if *flag { "t" } else { "f" }.to_string()),
        other => Some(other.to_string()),
    }
}

#[derive(Debug)]
pub struct FixedAuthSource {
    pub password: Option<String>,
}

#[async_trait]
impl AuthSource for FixedAuthSource {
    async fn get_password(&self, _login: &LoginInfo) -> PgWireResult<Password> {
        match &self.password {
            Some(password) => Ok(Password::new(None, Vec::from(password.clone()))),
            // No password configured: return an unmatchable secret so auth
            // always fails instead of accepting an empty password. Startup also
            // refuses to run without PG_GATEWAY_PASSWORD; this is defense in depth.
            None => Ok(Password::new(None, ulid::Ulid::new().to_string().into_bytes())),
        }
    }
}

/// Text-format field set for materialized rows: every column is TEXT, which
/// any pg client accepts, and matches how providers return JSON values.
fn text_fields(columns: &[Column]) -> Vec<FieldInfo> {
    columns
        .iter()
        .map(|column| {
            let pg_type = Type::from_oid(column.type_oid).unwrap_or(Type::TEXT);
            FieldInfo::new(column.name.clone().into(), None, None, pg_type, FieldFormat::Text)
        })
        .collect()
}

fn rows_response(columns: &[Column], rows: Vec<Vec<Option<String>>>, _count: usize) -> PgWireResult<Response> {
    let schema = Arc::new(text_fields(columns));
    let schema_ref = schema.clone();
    let stream = futures::stream::iter(rows).map(move |row| {
        let mut encoder = pgwire::api::results::DataRowEncoder::new(schema_ref.clone());
        for (index, value) in row.iter().enumerate() {
            let declared_type = schema_ref
                .get(index)
                .map(|field| field.datatype().clone())
                .unwrap_or(Type::TEXT);
            match value {
                Some(text) => {
                    // A TEXT-declared field must not encode a str as bytea
                    // (node-pg's text parser would read the raw length byte
                    // as data). Encode per declared type.
                    match declared_type {
                        Type::BYTEA => {
                            let hex = text.trim_start_matches("\\x");
                            let bytes: Vec<u8> = (0..hex.len() / 2)
                                .filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
                                .collect();
                            encoder.encode_field(&bytes)?;
                        }
                        _ => encoder.encode_field(&text)?,
                    }
                }
                None => encoder.encode_field(&None::<String>)?,
            }
        }
        Ok(encoder.take_row())
    });
    Ok(Response::Query(QueryResponse::new(schema, stream)))
}

#[async_trait]
impl SimpleQueryHandler for GatewayHandlers {
    async fn do_query<C>(&self, _client: &mut C, query: &str) -> PgWireResult<Vec<Response>>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        match self.execute_sql(query, None).await {
            Ok(Outcome::Session) => {
                // BEGIN/COMMIT/SET etc. ack as a no-op statement.
                Ok(vec![Response::Execution(pgwire::api::results::Tag::new("OK"))])
            }
            Ok(Outcome::Command(tag, count)) => Ok(vec![Response::Execution(
                pgwire::api::results::Tag::new(&tag).with_rows(count),
            )]),
            Ok(Outcome::Rows(columns, rows, count)) => {
                Ok(vec![rows_response(&columns, rows, count)?])
            }
            Err(error) => Err(self.error(&error)),
        }
    }
}

/// Parameter-aware parser: stores the SQL plus a lightweight analysis so
/// binds can resolve `WHERE id = $1` to the bound literal.
#[derive(Debug, Clone)]
pub struct MeshStatement {
    pub sql: String,
    pub placeholder: Option<String>,
}

#[async_trait]
impl QueryParser for StatementParser {
    type Statement = MeshStatement;

    async fn parse_sql<C>(
        &self,
        _client: &C,
        sql: &str,
        _types: &[Option<Type>],
    ) -> PgWireResult<Option<Self::Statement>>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        let placeholder = sqlanalyze::pk_placeholder(sql);
        Ok(Some(MeshStatement { sql: sql.to_owned(), placeholder }))
    }

    fn get_parameter_types(&self, stmt: &Self::Statement) -> PgWireResult<Vec<Type>> {
        match stmt.placeholder {
            Some(_) => Ok(vec![Type::TEXT]),
            None => Ok(vec![]),
        }
    }

    fn get_result_schema(
        &self,
        _stmt: &Self::Statement,
        _column_format: Option<&Format>,
    ) -> PgWireResult<Vec<FieldInfo>> {
        // Columns are materialized at Execute time (RowDescription is sent
        // from do_query's response); Describe answers with NoData, which
        // psql and most drivers accept.
        Ok(vec![])
    }
}

pub struct StatementParser {
    #[allow(dead_code)]
    pub handlers: GatewayHandlers,
}

async fn bound_row_id(portal: &Portal<MeshStatement>) -> Option<String> {
    let placeholder = portal.statement.statement.placeholder.as_ref()?;
    // Parameters are wire-encoded bytes; text format for TEXT is the literal.
    let index: usize = placeholder
        .trim_start_matches('$')
        .parse()
        .ok()?;
    let raw = portal.parameters.get(index.wrapping_sub(1))?.as_ref()?;
    Some(String::from_utf8_lossy(raw).to_string())
}

#[async_trait]
impl ExtendedQueryHandler for GatewayHandlers {
    type Statement = MeshStatement;
    type QueryParser = StatementParser;

    fn query_parser(&self) -> Arc<Self::QueryParser> {
        Arc::new(StatementParser { handlers: self.clone() })
    }

    async fn do_query<C>(
        &self,
        _client: &mut C,
        portal: &Portal<Self::Statement>,
        _max_rows: usize,
    ) -> PgWireResult<Response>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Self::Statement>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let row_id = bound_row_id(portal).await;
        let sql = &portal.statement.statement.sql;
        // Binary-safe inlining up front: BYTEA params (nostr pubkeys/ids)
        // become hex escape literals; UTF-8 params inline as text literals.
        let effective_sql = if portal.parameters.is_empty() {
            sql.to_string()
        } else {
            match inline_params_bytes(sql, &portal.parameters) {
                Ok(inlined) => inlined,
                Err(error) => return Err(self.error(&error)),
            }
        };
        match self.execute_sql_bound(&effective_sql, row_id.as_deref(), &portal.parameters.iter().map(|_| None::<String>).collect::<Vec<_>>()).await {
            Ok(Outcome::Session) => Ok(Response::Execution(pgwire::api::results::Tag::new("OK"))),
            Ok(Outcome::Command(tag, count)) => {
                Ok(Response::Execution(pgwire::api::results::Tag::new(&tag).with_rows(count)))
            }
            Ok(Outcome::Rows(columns, rows, count)) => rows_response(&columns, rows, count),
            Err(error) => Err(self.error(&error)),
        }
    }

    /// Describes a statement (pre-bind): dry-run with NULL params inlined to
    /// learn the real column set. Column names/types don't depend on param
    /// values, so this matches what Execute will return.
    async fn do_describe_statement<C>(
        &self,
        _client: &mut C,
        target: &StoredStatement<Self::Statement>,
    ) -> PgWireResult<DescribeStatementResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Self::Statement>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let sql = &target.statement.sql;
        let schema = if is_catalog_statement(sql) {
            // Real metadata from the catalog connection's prepare(): exact
            // column names even for zero-row results.
            match self.catalog.describe_columns(sql).await {
                Ok(names) => text_fields(
                    &names.into_iter().map(|name| Column { name, type_oid: Type::TEXT.oid() }).collect::<Vec<Column>>(),
                ),
                Err(_) => vec![],
            }
        } else {
            match sqlanalyze::select_projection(sql) {
                // `select *`: registry columns are the exact projection.
                Some(None) => {
                    let columns = self.describe_columns_for_read(sql).await;
                    text_fields(&columns)
                }
                // Named column projection: map to registry types so the
                // Describe arity matches Execute's DataRow.
                Some(Some(names)) => {
                    let table = sqlanalyze::read_table_name(sql).unwrap_or_default();
                    let all = match self.store.get_table(&table).await {
                        Ok(Some(table_def)) => table_columns_as_columns(&table_def),
                        _ => vec![],
                    };
                    let fields: Vec<Column> = names
                        .iter()
                        .map(|name| {
                            all.iter()
                                .find(|column| column.name.eq_ignore_ascii_case(name))
                                .cloned()
                                .unwrap_or(Column { name: name.clone(), type_oid: Type::TEXT.oid() })
                        })
                        .collect();
                    text_fields(&fields)
                }
                // Unparseable: NoData (drivers use Execute's description).
                None => vec![],
            }
        };
        let param_types: Vec<Type> = target
            .parameter_types
            .iter()
            .map(|pt| pt.clone().unwrap_or(Type::UNKNOWN))
            .collect();
        Ok(DescribeStatementResponse::new(param_types, schema))
    }

    /// Describes a portal by executing it: the gateway materializes real
    /// columns (catalog queries and provider fan-outs), so introspection
    /// matches the actual rows. Cheap for catalog queries; fan-outs use
    /// LIMIT-less dry runs only when cheap — here we just run it, matching
    /// what Execute would return.
    async fn do_describe_portal<C>(
        &self,
        _client: &mut C,
        target: &Portal<Self::Statement>,
    ) -> PgWireResult<DescribePortalResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Self::Statement>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let sql = &target.statement.statement.sql;
        if is_catalog_statement(sql) {
            match self.catalog.describe_columns(sql).await {
                Ok(names) => {
                    let fields = text_fields(
                        &names.into_iter().map(|name| Column { name, type_oid: Type::TEXT.oid() }).collect::<Vec<Column>>(),
                    );
                    return Ok(DescribePortalResponse::new(fields));
                }
                Err(_) => return Ok(DescribePortalResponse::new(vec![])),
            }
        }
        // Projection-aware shape: `select *` maps to the registry columns;
        // named projections map each name to its registry type. The Describe
        // answer must match Execute's DataRow arity — node-pg parses
        // positionally.
        let columns = match sqlanalyze::select_projection(sql) {
            Some(None) => self.describe_columns_for_read(sql).await,
            Some(Some(names)) => {
                let table = sqlanalyze::read_table_name(sql).unwrap_or_default();
                let all = match self.store.get_table(&table).await {
                    Ok(Some(table_def)) => table_columns_as_columns(&table_def),
                    _ => vec![],
                };
                names
                    .iter()
                    .map(|name| {
                        all.iter()
                            .find(|column| column.name.eq_ignore_ascii_case(name))
                            .cloned()
                            .unwrap_or(Column { name: name.clone(), type_oid: Type::TEXT.oid() })
                    })
                    .collect()
            }
            None => vec![],
        };
        Ok(DescribePortalResponse::new(text_fields(&columns)))
    }

    async fn on_sync<C>(&self, client: &mut C, _message: PgSync) -> PgWireResult<()>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Self::Statement>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        client.portal_store().rm_portal("POSTGRESQL_DEFAULT_NAME");
        client
            .send(PgWireBackendMessage::ReadyForQuery(ReadyForQuery::new(
                client.transaction_status(),
            )))
            .await?;
        client.flush().await?;
        Ok(())
    }
}

#[async_trait]
impl StartupHandler for GatewayHandlers {
    async fn on_startup<C>(&self, _client: &mut C, _message: PgWireFrontendMessage) -> PgWireResult<()>
    where
        C: ClientInfo + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        unreachable!("startup is delegated to CleartextPasswordAuthStartupHandler")
    }
}

#[async_trait]
impl CopyHandler for GatewayHandlers {
    async fn on_copy_data<C>(&self, _client: &mut C, _copy_data: pgwire::messages::copy::CopyData) -> PgWireResult<()>
    where
        C: ClientInfo + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::Error: Debug,
    {
        Err(PgWireError::UserError(Box::new(ErrorInfo::new(
            "ERROR".to_string(),
            "0A000".to_string(),
            "COPY is not supported by the mesh-PG gateway".to_string(),
        ))))
    }

    async fn on_copy_done<C>(&self, _client: &mut C, _copy_done: pgwire::messages::copy::CopyDone) -> PgWireResult<()>
    where
        C: ClientInfo + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::Error: Debug,
    {
        Ok(())
    }

    async fn on_copy_fail<C>(&self, _client: &mut C, fail: pgwire::messages::copy::CopyFail) -> PgWireError
    where
        C: ClientInfo + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::Error: Debug,
    {
        PgWireError::UserError(Box::new(ErrorInfo::new(
            "ERROR".to_string(),
            "0A000".to_string(),
            format!("COPY is not supported by the mesh-PG gateway: {}", fail.message),
        )))
    }
}

impl PgWireServerHandlers for GatewayHandlers {
    fn simple_query_handler(&self) -> Arc<impl SimpleQueryHandler> {
        Arc::new(self.clone())
    }

    fn extended_query_handler(&self) -> Arc<impl ExtendedQueryHandler> {
        Arc::new(self.clone())
    }

    fn startup_handler(&self) -> Arc<impl StartupHandler> {
        Arc::new(CleartextPasswordAuthStartupHandler::new(
            FixedAuthSource { password: self.auth_password.clone() },
            DefaultServerParameterProvider::default(),
        ))
    }

    fn copy_handler(&self) -> Arc<impl CopyHandler> {
        Arc::new(self.clone())
    }

}

/// Maps a registry column descriptor's PG type name to its wire type OID.
/// node-pg (and every driver) parses RowDescription by OID; declaring
/// everything TEXT crashes clients on real types (bytea, timestamptz...).
fn pg_type_oid(declared: &str) -> Option<u32> {
    let name = declared.trim().to_ascii_uppercase();
    let base = name
        .split(|c: char| c == '(' || c == ')')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    match base.as_str() {
        "BOOLEAN" | "BOOL" => Some(Type::BOOL.oid()),
        "BYTEA" => Some(Type::BYTEA.oid()),
        "CHAR" | "BPCHAR" => Some(Type::BPCHAR.oid()),
        "NAME" => Some(Type::NAME.oid()),
        "INT8" | "BIGINT" | "BIGSERIAL" => Some(Type::INT8.oid()),
        "INT2" | "SMALLINT" | "SMALLSERIAL" => Some(Type::INT2.oid()),
        "INT4" | "INTEGER" | "INT" | "SERIAL" => Some(Type::INT4.oid()),
        "TEXT" => Some(Type::TEXT.oid()),
        "VARCHAR" => Some(Type::VARCHAR.oid()),
        "FLOAT4" | "REAL" => Some(Type::FLOAT4.oid()),
        "FLOAT8" | "DOUBLE PRECISION" => Some(Type::FLOAT8.oid()),
        "NUMERIC" | "DECIMAL" => Some(Type::NUMERIC.oid()),
        "TIMESTAMP" => Some(Type::TIMESTAMP.oid()),
        "TIMESTAMPTZ" | "TIMESTAMP WITH TIME ZONE" => Some(Type::TIMESTAMPTZ.oid()),
        "DATE" => Some(Type::DATE.oid()),
        "TIME" => Some(Type::TIME.oid()),
        "JSON" => Some(Type::JSON.oid()),
        "JSONB" => Some(Type::JSONB.oid()),
        "UUID" => Some(Type::UUID.oid()),
        "INET" => Some(Type::INET.oid()),
        "OID" => Some(Type::OID.oid()),
        _ => None,
    }
}

fn table_columns_as_columns(table: &crate::central::MeshTable) -> Vec<Column> {
    table
        .columns
        .as_array()
        .map(|array| {
            array
                .iter()
                .filter_map(|column| {
                    let name = column.get("name").and_then(|name| name.as_str())?;
                    let declared = column.get("type").and_then(|value| value.as_str()).unwrap_or("");
                    let type_oid = pg_type_oid(declared).unwrap_or(Type::TEXT.oid());
                    Some(Column { name: name.to_string(), type_oid })
                })
                .collect::<Vec<Column>>()
        })
        .unwrap_or_default()
}

fn payload_row_to_wire(payload: &Option<Value>, table: &crate::central::MeshTable) -> Vec<Option<String>> {
    let row = payload.as_ref().and_then(|value| value.as_object());
    table_columns_as_columns(table)
        .iter()
        .map(|column| {
            row.and_then(|object| object.get(&column.name))
                .and_then(value_to_wire_text)
        })
        .collect()
}

/// True for statements that reference catalogs or ORM bookkeeping tables and
/// must be served from the local catalog database.
fn is_catalog_statement(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    let trimmed = lower.trim().trim_end_matches(';').trim();
    // Only genuine gateway-internal bookkeeping is catalog-only: knex's
    // migration tables and pg_catalog/information_schema introspection.
    // Extensions, functions, and triggers all operate on mesh tables and MUST
    // live on every provider — providers run real SQL (column defaults like
    // uuid_generate_v4(), and triggers that derive dependent rows on apply,
    // e.g. nostream's process_event_tags -> event_tags). Routing any of those
    // catalog-only left providers unable to apply rows. They now fall through
    // to the verbatim DDL path (fallback_ddl -> all providers + catalog mirror).
    // knex bookkeeping DDL: creates/drops of its own bookkeeping tables.
    ((trimmed.starts_with("create table")
            || trimmed.starts_with("drop table")
            || trimmed.starts_with("create index")
            || trimmed.starts_with("create unique index"))
            && (lower.contains("knex_migrations")))
        || lower.contains("pg_catalog.")
        || lower.contains("information_schema.")
        || lower.contains("knex_migrations")
        || lower.contains("to_regclass")
        || lower.contains("pg_class")
        || lower.contains("pg_namespace")
        || lower.contains("pg_attribute")
        || lower.contains("pg_index")
        || lower.contains("pg_constraint")
        || lower.contains("pg_type")
}

impl GatewayHandlers {
    /// Returns Some(outcome) when the statement was handled by the catalog.
    async fn catalog_request(&self, sql: &str, params: &[Option<String>]) -> Result<Option<Outcome>, GatewayError> {
        if !is_catalog_statement(sql) {
            tracing::debug!("not catalog: {}", sql);
            return Ok(None);
        }
        tracing::debug!("catalog route: {}", sql);
        // DDL: CREATE TABLE/INDEX referencing catalog bookkeeping or
        // extension setup (CREATE EXTENSION) runs only on the catalog.
        let trimmed = sql.trim().trim_end_matches(';').to_ascii_lowercase();
        if trimmed.starts_with("create extension")
            || trimmed.starts_with("create index")
            || trimmed.starts_with("create unique index")
            || trimmed.starts_with("create table")
            || trimmed.starts_with("drop table")
            || trimmed.starts_with("insert into")
            || trimmed.starts_with("update ")
            || trimmed.starts_with("delete from")
        {
            // Qualify bare bookkeeping table names into the catalog schema.
            let rewritten = qualify_catalog_sql(sql);
            let affected = if params.is_empty() {
                self.catalog.execute(&rewritten).await?
            } else {
                self.catalog
                    .execute(&inline_params(&rewritten, params)?)
                    .await?
            };
            // Clients (knex) read rowCount from the command tag to detect
            // how many rows a lock UPDATE touched — "OK" would read as 0.
            let verb = trimmed
                .split_whitespace()
                .next()
                .unwrap_or("OK")
                .to_ascii_uppercase();
            return Ok(Some(Outcome::Command(verb, affected as usize)));
        }
        let effective_sql = if params.is_empty() {
            qualify_catalog_sql(sql)
        } else {
            qualify_catalog_sql(&inline_params(sql, params)?)
        };
        // DDL that slipped past the write branch (multi-statement bodies,
        // describe dry-runs) executes on the catalog instead of reading.
        let ddlish = effective_sql.trim().to_ascii_lowercase();
        if ddlish.starts_with("create")
            || ddlish.starts_with("drop")
            || ddlish.starts_with("alter")
        {
            self.catalog.execute(&effective_sql).await?;
            return Ok(Some(Outcome::Command("OK".to_string(), 1)));
        }
        tracing::debug!("catalog read effective_sql={}", effective_sql);
        let rows = self.catalog.query(&effective_sql).await?;
        let columns = infer_columns(&rows, "");
        let count = rows.len();
        let wire_rows = rows
            .iter()
            .map(|row| {
                columns
                    .iter()
                    .map(|column| row.get(&column.name).and_then(value_to_wire_text))
                    .collect::<Vec<Option<String>>>()
            })
            .collect();
        Ok(Some(Outcome::Rows(columns, wire_rows, count)))
    }
}

/// Replaces $N placeholders with inlined text literals for the catalog path.
/// The catalog is a local trust boundary (gateway-owned), so naive inlining
/// is acceptable; params arrive as text from the wire.
fn inline_params(sql: &str, params: &[Option<String>]) -> Result<String, GatewayError> {
    let mut result = sql.to_string();
    for (index, param) in params.iter().enumerate().rev() {
        let placeholder = format!("${}", index + 1);
        let literal = match param {
            Some(text) => format!("'{}'", text.replace('\'', "''")),
            None => "NULL".to_string(),
        };
        result = result.replace(&placeholder, &literal);
    }
    Ok(result)
}

/// Binary-safe inlining: params arrive as raw wire bytes; when they are not
/// valid UTF-8 (e.g. BYTEA pubkeys from nostr), emit a hex escape literal.
pub fn inline_params_bytes(sql: &str, params: &[Option<bytes::Bytes>]) -> Result<String, GatewayError> {
    let mut result = sql.to_string();
    for (index, param) in params.iter().enumerate().rev() {
        let placeholder = format!("${}", index + 1);
        let literal = match param {
            Some(bytes) => match std::str::from_utf8(bytes) {
                Ok(text) => format!("'{}'", text.replace('\'', "''")),
                Err(_) => {
                    // decode('\x..','hex') is unambiguous for both Postgres
                    // and sqlparser (E-string escapes mangle multi-byte hex
                    // sequences; observed with \x79be.. pubkeys).
                    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                    format!("decode('{hex}','hex')::bytea")
                }
            },
            None => "NULL".to_string(),
        };
        result = result.replace(&placeholder, &literal);
    }
    Ok(result)
}

/// Naive qualification of bare table names for catalog bookkeeping SQL
/// (knex emits `insert into "knex_migrations"`, `select * from
/// "knex_migrations"` etc. with quoted identifiers).
fn qualify_catalog_sql(sql: &str) -> String {
    // Only qualify the known bookkeeping tables; catalog-prefixed queries
    // already carry their own qualification.
    let mut result = sql.to_string();
    for table in ["knex_migrations_lock", "knex_migrations"] {
        let quoted = format!("\"{table}\"");
        if result.contains(&quoted) && !result.contains(&format!("mesh_catalog.{quoted}")) {
            result = result.replace(&quoted, &format!("mesh_catalog.{}", quoted));
        }
    }
    result
}

/// Re-runs the analyzer to surface its original error for non-DDL fallbacks.
fn analyze_error(sql: &str) -> GatewayError {
    sqlanalyze::analyze(sql).unwrap_err()
}

/// Cheap DDL detection without parsing (used when the parser itself fails).
fn is_ddl_text(sql: &str) -> bool {
    let lower = sql.trim().to_ascii_lowercase();
    lower.starts_with("create")
        || lower.starts_with("alter")
        || lower.starts_with("drop")
}
