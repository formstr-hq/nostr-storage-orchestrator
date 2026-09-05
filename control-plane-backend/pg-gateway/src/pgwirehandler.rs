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
use pgwire::api::results::{FieldFormat, FieldInfo, QueryResponse, Response};
use pgwire::api::stmt::QueryParser;
use pgwire::api::store::PortalStore;
use pgwire::api::{ClientInfo, ClientPortalStore, PgWireServerHandlers, Type};
use pgwire::error::{ErrorInfo, PgWireError, PgWireResult};
use pgwire::messages::extendedquery::Sync as PgSync;
use pgwire::messages::response::ReadyForQuery;
use pgwire::messages::{PgWireBackendMessage, PgWireFrontendMessage};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::central::CentralStore;
use crate::error::GatewayError;
use crate::provider::ProviderClient;
use crate::readengine::ReadEngine;
use crate::registry::ProviderRegistry;
use crate::schema::SchemaManager;
use crate::sqlanalyze::{self, AnalyzedStatement, StatementKind};

#[derive(Clone)]
pub struct GatewayHandlers {
    pub store: Arc<CentralStore>,
    pub registry: Arc<ProviderRegistry>,
    pub provider: ProviderClient,
    pub schema: Arc<SchemaManager>,
    pub read: Arc<ReadEngine>,
    /// Serializes write-path buffer mutations globally: enqueue + placement
    /// upsert must be atomic from the client's perspective.
    pub write_lock: Arc<Mutex<()>>,
    pub auth_password: Option<String>,
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
}

impl GatewayHandlers {
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
        if sqlanalyze::is_session_command(sql) {
            return Ok(Outcome::Session);
        }
        let analyzed = sqlanalyze::analyze(sql)?;
        match analyzed {
            AnalyzedStatement::Read { .. } => {
                // Point reads (single equality on pk) route to one provider;
                // everything else fans out.
                let point = bound_row_id
                    .map(|id| id.to_string())
                    .or_else(|| sqlanalyze::point_read_row_id(sql).ok().flatten());
                let result = match point {
                    Some(row_id) => self.read.point_read(sql, &row_id).await,
                    None => self.read.fanout_read(sql).await,
                }?;
                let table = sqlanalyze::read_table_name(sql).unwrap_or_default();
                let columns = infer_columns(&result.rows, &table);
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
                self.schema.handle_ddl(kind.clone(), &table, &sql).await?;
                let tag = match kind {
                    StatementKind::Create => "CREATE TABLE",
                    StatementKind::Alter => "ALTER TABLE",
                    StatementKind::Drop => "DROP TABLE",
                    _ => "DDL",
                };
                Ok(Outcome::Command(tag.to_string(), 0))
            }
            AnalyzedStatement::Write { kind, table, row_id, sql, row_id_placeholder, generate_row_id, returning } => {
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

                // Build the full row image (gateway-materialized values):
                // supplied columns from the statement, generated columns from
                // the central allocator. This is what makes every replica
                // receive an identical row.
                let materialized = match kind {
                    StatementKind::Insert => {
                        Some(
                            materialize_insert_row(
                                sql.as_str(),
                                &table_def,
                                generate_row_id && !is_bound_placeholder,
                                &row_id,
                                self.store.as_ref(),
                            )
                            .await?,
                        )
                    }
                    _ => None,
                };
                let row_id = match (&materialized, generate_row_id, is_bound_placeholder) {
                    (Some(row), true, false) => row
                        .get(sqlanalyze::PK_COLUMN)
                        .and_then(value_to_wire_text)
                        .ok_or_else(|| GatewayError::UnsupportedSql(
                            "table has no primary-key column; add an `id` column".to_string(),
                        ))?,
                    _ => {
                        if is_bound_placeholder {
                            return Err(GatewayError::UnsupportedSql(
                                "bound-parameter writes are not supported yet; inline the values".to_string(),
                            ));
                        }
                        row_id
                    }
                };

                let providers = self.registry.providers();
                let target_count = (table_def.replica_count.max(1) as usize).max(1);
                // Placement: reuse existing (still-active) replicas, top up
                // with fresh providers. Mirrors the dispatcher's policy.
                let mut replicas = self
                    .store
                    .get_placement(&table, &row_id)
                    .await?
                    .map(|(replicas, _)| replicas)
                    .unwrap_or_default();
                for provider in &providers {
                    if replicas.len() >= target_count {
                        break;
                    }
                    if !replicas.contains(&provider.npub) {
                        replicas.push(provider.npub.clone());
                    }
                }
                if replicas.is_empty() {
                    return Err(GatewayError::NoProviders);
                }
                let op_name = match kind {
                    StatementKind::Insert => "INSERT",
                    StatementKind::Update => "UPDATE",
                    StatementKind::Delete => "DELETE",
                    _ => return Err(GatewayError::UnsupportedSql("unexpected write kind".to_string())),
                };
                // INSERTs buffer the full materialized row (read-your-writes +
                // identical replicas); UPDATE/DELETE apply by row id on
                // providers, so the payload keeps the statement.
                let payload = materialized
                    .or_else(|| Some(serde_json::json!({ "sql": sql })));
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
        }
    }
}

fn infer_columns(rows: &[Value], _table: &str) -> Vec<Column> {
    let mut columns: Vec<Column> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(object) = row.as_object() {
            for key in object.keys() {
                if seen.insert(key.clone()) {
                    columns.push(Column { name: key.clone() });
                }
            }
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
        Ok(Password::new(None, Vec::from(self.password.clone().unwrap_or_default())))
    }
}

/// Text-format field set for materialized rows: every column is TEXT, which
/// any pg client accepts, and matches how providers return JSON values.
fn text_fields(columns: &[Column]) -> Vec<FieldInfo> {
    columns
        .iter()
        .map(|column| FieldInfo::new(column.name.clone().into(), None, None, Type::TEXT, FieldFormat::Text))
        .collect()
}

fn rows_response(columns: &[Column], rows: Vec<Vec<Option<String>>>, _count: usize) -> PgWireResult<Response> {
    let schema = Arc::new(text_fields(columns));
    let schema_ref = schema.clone();
    let stream = futures::stream::iter(rows).map(move |row| {
        let mut encoder = pgwire::api::results::DataRowEncoder::new(schema_ref.clone());
        for value in &row {
            match value {
                Some(text) => encoder.encode_field(&text)?,
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
        match self.execute_sql(sql, row_id.as_deref()).await {
            Ok(Outcome::Session) => Ok(Response::Execution(pgwire::api::results::Tag::new("OK"))),
            Ok(Outcome::Command(tag, count)) => {
                Ok(Response::Execution(pgwire::api::results::Tag::new(&tag).with_rows(count)))
            }
            Ok(Outcome::Rows(columns, rows, count)) => rows_response(&columns, rows, count),
            Err(error) => Err(self.error(&error)),
        }
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

fn table_columns_as_columns(table: &crate::central::MeshTable) -> Vec<Column> {
    table
        .columns
        .as_array()
        .map(|array| {
            array
                .iter()
                .filter_map(|column| column.get("name").and_then(|name| name.as_str()))
                .map(|name| Column { name: name.to_string() })
                .collect()
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

/// Builds the complete INSERT row: literal columns from the statement plus
/// gateway-materialized generated columns (SERIAL -> central sequence,
/// UUID -> uuid v4, NOW -> gateway clock). Providers never generate values
/// for mesh tables, so every replica receives an identical row.
async fn materialize_insert_row(
    sql: &str,
    table: &crate::central::MeshTable,
    generate_row_id: bool,
    row_id: &str,
    store: &CentralStore,
) -> Result<Value, GatewayError> {
    let serde_json::Value::Object(mut row) = sqlanalyze::insert_row_payload(sql)? else {
        return Err(GatewayError::UnsupportedSql(
            "INSERT row payload must be an object".to_string(),
        ));
    };
    let columns = table
        .columns
        .as_array()
        .cloned()
        .unwrap_or_default();
    // Supplied-but-generated check: a client-provided value always wins.
    for column in &columns {
        let name = column.get("name").and_then(|value| value.as_str()).unwrap_or_default();
        let default = column.get("default");
        let is_generated = matches!(
            default.map(|value| value.as_str().unwrap_or_default()),
            Some("SERIAL") | Some("UUID") | Some("NOW")
        );
        if row.get(name).map(|value| !value.is_null()).unwrap_or(false) {
            continue;
        }
        if !is_generated {
            // Nullable / literal-default columns stay absent (provider's
            // column default applies; it is deterministic).
            continue;
        }
        let generated = match default.and_then(|value| value.as_str()).unwrap_or_default() {
            "SERIAL" => {
                let value = store
                    .next_sequence_value(&table.name, name)
                    .await?;
                serde_json::json!(value)
            }
            "UUID" => serde_json::json!(ulid::Ulid::new().to_string()),
            "NOW" => serde_json::json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            _ => continue,
        };
        row.insert(name.to_string(), generated);
    }
    if generate_row_id && row.get(sqlanalyze::PK_COLUMN).map(|value| value.is_null()).unwrap_or(true) {
        // The pk column itself is generated: allocate per its descriptor
        // (serial -> sequence, else ULID).
        let pk_column = columns
            .iter()
            .find(|column| column.get("primaryKey").and_then(|value| value.as_bool()).unwrap_or(false));
        let generated = match pk_column
            .and_then(|column| column.get("default"))
            .map(|value| value.as_str().unwrap_or_default())
        {
            Some("SERIAL") => {
                let value = store
                    .next_sequence_value(&table.name, sqlanalyze::PK_COLUMN)
                    .await?;
                serde_json::json!(value)
            }
            _ => serde_json::json!(ulid::Ulid::new().to_string()),
        };
        row.insert(sqlanalyze::PK_COLUMN.to_string(), generated);
    }
    let _ = row_id;
    Ok(serde_json::Value::Object(row))
}
