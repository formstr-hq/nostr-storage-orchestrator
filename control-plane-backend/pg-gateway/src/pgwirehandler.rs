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
            AnalyzedStatement::Write { kind, table, row_id, sql } => {
                let row_id = match bound_row_id {
                    Some(value) => value.to_string(),
                    None => row_id,
                };
                let _guard = self.write_lock.lock().await;
                let table_def = self.read.table(&table).await?;
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
                // INSERT payloads must be full rows so the buffer can serve
                // read-your-writes before dispatch; UPDATE/DELETE apply by
                // row id on providers, so the payload keeps the statement.
                let payload = if kind == StatementKind::Insert {
                    Some(sqlanalyze::insert_row_payload(sql.as_str())?)
                } else {
                    Some(serde_json::json!({ "sql": sql }))
                };
                let op_id = ulid::Ulid::new().to_string();
                self.store
                    .enqueue_write_op(&op_id, &table, op_name, &row_id, payload.as_ref())
                    .await?;
                self.store
                    .upsert_placement(&table, &row_id, &replicas, "PENDING")
                    .await?;
                Ok(Outcome::Command(op_name.to_string(), 1))
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
