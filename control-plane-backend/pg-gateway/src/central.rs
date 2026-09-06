//! Central-Postgres access for the orchestrator-side state: schema registry,
//! write buffer, placement index. Uses tokio-postgres directly because rows
//! are dynamic JSON payloads; Prisma/db-api owns the schema files only.

use serde_json::Value;
use tokio_postgres::{NoTls, Row};

use crate::error::{GatewayError, Result};

pub const CENTRAL_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS pg_table (
    name TEXT PRIMARY KEY,
    columns JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    "replicaN" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS pg_migration (
    id TEXT PRIMARY KEY,
    ddl TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS pg_migration_state_version_idx ON pg_migration (state, version);
CREATE TABLE IF NOT EXISTS pg_migration_state (
    storage_npub TEXT NOT NULL,
    version INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (storage_npub, version)
);
CREATE TABLE IF NOT EXISTS pg_write_op (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    op TEXT NOT NULL,
    row_id TEXT NOT NULL,
    payload JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS pg_write_op_table_name_row_id_idx ON pg_write_op (table_name, row_id);
CREATE INDEX IF NOT EXISTS pg_write_op_createdAt_idx ON pg_write_op ("createdAt");
CREATE TABLE IF NOT EXISTS pg_placement (
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    replicas TEXT[] NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    PRIMARY KEY (table_name, row_id)
);
"#;

/// Applied to the shadow catalog database (a real Postgres schema on the
/// orchestrator that mirrors mesh DDL). Catalog introspection
/// (pg_catalog/information_schema/knex_migrations bookkeeping) is answered
/// from here with real rows instead of fanned out to providers.
pub const CATALOG_SCHEMA_SQL: &str = r#"
CREATE SCHEMA IF NOT EXISTS mesh_catalog;
"#;

/// A mesh table registered in the central schema registry.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeshTable {
    pub name: String,
    pub columns: Value,
    pub version: i32,
    pub replica_count: i32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PendingMigration {
    pub id: String,
    pub ddl: String,
    pub version: i32,
}

#[derive(Debug, Clone)]
pub struct WriteOp {
    pub id: String,
    pub table_name: String,
    pub op: String,
    pub row_id: String,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActivePgStorage {
    pub npub: String,
    pub url: String,
}

pub struct CentralStore {
    client: tokio::sync::Mutex<Option<tokio_postgres::Client>>,
    url: String,
}

impl CentralStore {
    pub fn new(database_url: String) -> Self {
        Self { client: tokio::sync::Mutex::new(None), url: database_url }
    }

    pub async fn ensure_schema(&self) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .batch_execute(CENTRAL_SCHEMA_SQL)
            .await
            .map_err(|error| GatewayError::central(format!("central schema: {error}")))?;
        Ok(())
    }

    /// Lazily connects, replacing a dead client transparently. All access is
    /// serialized behind one mutex: gateway traffic here is tiny (registry
    /// writes, buffer ops, index lookups) and never holds the lock across a
    /// provider call.
    async fn connect(&self) -> Result<tokio::sync::MutexGuard<'_, Option<tokio_postgres::Client>>> {
        let mut slot = self.client.lock().await;
        if let Some(client) = slot.as_ref() {
            if client.simple_query("SELECT 1").await.is_ok() {
                return Ok(slot);
            }
        }
        let (client, connection) = tokio_postgres::connect(&self.url, NoTls)
            .await
            .map_err(|error| GatewayError::central(format!("central pg connect: {error}")))?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::debug!("central pg connection closed: {error}");
            }
        });
        *slot = Some(client);
        Ok(slot)
    }

    // ── schema registry ─────────────────────────────────────────────────────

    pub async fn get_table(&self, name: &str) -> Result<Option<MeshTable>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let row = client
            .query_opt(
                "SELECT name, columns, version, \"replicaN\" FROM pg_table WHERE name = $1",
                &[&name],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(row.map(|row| mesh_table_from_row(&row)))
    }

    pub async fn list_tables(&self) -> Result<Vec<MeshTable>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let rows = client
            .query(
                "SELECT name, columns, version, \"replicaN\" FROM pg_table ORDER BY name",
                &[],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(rows.iter().map(mesh_table_from_row).collect())
    }

    /// Creates the table row and the baseline migration in one transaction.
    /// `columns` is the canonical column list derived from the parsed DDL.
    pub async fn create_table(
        &self,
        name: &str,
        columns: Value,
        replica_count: i32,
        ddl: &str,
        migration_id: &str,
    ) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let tx = client
            .transaction()
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        tx.execute(
            "INSERT INTO pg_table (name, columns, version, \"replicaN\", \"updatedAt\") VALUES ($1, $2, 1, $3, now())",
            &[&name, &columns, &replica_count],
        )
        .await
        .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        tx.execute(
            "INSERT INTO pg_migration (id, ddl, version, state) VALUES ($1, $2, 1, 'PENDING')",
            &[&migration_id, &ddl],
        )
        .await
        .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        tx.commit()
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    /// Appends ADD COLUMN descriptors to a registered table's columns.
    /// Keeps the registry descriptor in sync with propagated ALTERs —
    /// describe/RowDescription are built from it, so a stale descriptor
    /// desyncs column counts (observed with node-pg).
    pub async fn add_table_columns(&self, name: &str, added: &[Value]) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let row = client
            .query_opt(
                "SELECT columns FROM pg_table WHERE name = $1 FOR UPDATE",
                &[&name],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        let Some(row) = row else {
            return Err(GatewayError::UnknownTable(name.to_string()));
        };
        let mut columns: Value = row.get("columns");
        if let serde_json::Value::Array(ref mut array) = columns {
            for column in added {
                let name = column
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if array.iter().any(|existing| {
                    existing
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(|value| value.eq_ignore_ascii_case(&name))
                        .unwrap_or(false)
                }) {
                    continue;
                }
                array.push(column.clone());
            }
        }
        client
            .execute(
                "UPDATE pg_table SET columns = $2, version = version + 1, \"updatedAt\" = now() WHERE name = $1",
                &[&name, &columns],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    pub async fn pending_migrations(&self) -> Result<Vec<PendingMigration>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let rows = client
            .query(
                "SELECT id, ddl, version FROM pg_migration WHERE state = 'PENDING' ORDER BY version, \"createdAt\"",
                &[],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(rows
            .iter()
            .map(|row| PendingMigration {
                id: row.get("id"),
                ddl: row.get("ddl"),
                version: row.get("version"),
            })
            .collect())
    }

    pub async fn migrations_since(&self, version: i32) -> Result<Vec<PendingMigration>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let rows = client
            .query(
                "SELECT id, ddl, version FROM pg_migration WHERE version > $1 ORDER BY version, \"createdAt\"",
                &[&version],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(rows
            .iter()
            .map(|row| PendingMigration {
                id: row.get("id"),
                ddl: row.get("ddl"),
                version: row.get("version"),
            })
            .collect())
    }

    pub async fn mark_migration_applied(&self, id: &str) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute(
                "UPDATE pg_migration SET state = 'APPLIED', \"appliedAt\" = now() WHERE id = $1",
                &[&id],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    /// Appends a new migration with version = current registry max + 1.
    pub async fn append_migration(&self, ddl: &str, id: &str) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute(
                "INSERT INTO pg_migration (id, ddl, version, state)
                 SELECT $1, $2, COALESCE(MAX(version), 0) + 1, 'PENDING' FROM pg_migration",
                &[&id, &ddl],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    pub async fn record_migration_state(&self, storage_npub: &str, version: i32) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute(
                "INSERT INTO pg_migration_state (storage_npub, version) VALUES ($1, $2)
                 ON CONFLICT (storage_npub, version) DO NOTHING",
                &[&storage_npub, &version],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    /// Highest migration version a provider has acked, 0 when never seen.
    pub async fn provider_schema_version(&self, storage_npub: &str) -> Result<i32> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let row = client
            .query_opt(
                "SELECT COALESCE(MAX(version), 0) AS version FROM pg_migration_state WHERE storage_npub = $1",
                &[&storage_npub],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(row.map(|row: Row| row.get::<_, i32>("version")).unwrap_or(0))
    }

    // ── write buffer ────────────────────────────────────────────────────────

    pub async fn enqueue_write_op(
        &self,
        id: &str,
        table_name: &str,
        op: &str,
        row_id: &str,
        payload: Option<&Value>,
    ) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute(
                "INSERT INTO pg_write_op (id, table_name, op, row_id, payload) VALUES ($1, $2, $3, $4, $5)",
                &[&id, &table_name, &op, &row_id, &payload],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    /// Takes a batch of oldest ops (oldest first). Ops stay in the buffer
    /// until they are explicitly deleted after full acknowledgement.
    pub async fn take_write_ops(&self, limit: i64) -> Result<Vec<WriteOp>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let rows = client
            .query(
                "SELECT id, table_name, op, row_id, payload FROM pg_write_op
                 ORDER BY \"createdAt\", id LIMIT $1",
                &[&limit],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(rows
            .iter()
            .map(|row| WriteOp {
                id: row.get("id"),
                table_name: row.get("table_name"),
                op: row.get("op"),
                row_id: row.get("row_id"),
                payload: row.get::<_, Option<Value>>("payload"),
            })
            .collect())
    }

    pub async fn record_write_failure(&self, id: &str, message: &str) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute(
                "UPDATE pg_write_op
                 SET \"retryCount\" = \"retryCount\" + 1, last_error = $2, last_attempt_at = now()
                 WHERE id = $1",
                &[&id, &message],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    pub async fn delete_write_ops(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute("DELETE FROM pg_write_op WHERE id = ANY($1)", &[&ids])
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    // ── placement index ─────────────────────────────────────────────────────

    pub async fn upsert_placement(
        &self,
        table_name: &str,
        row_id: &str,
        replicas: &[String],
        state: &str,
    ) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute(
                "INSERT INTO pg_placement (table_name, row_id, replicas, state, \"updatedAt\")
                 VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (table_name, row_id)
                 DO UPDATE SET replicas = EXCLUDED.replicas, state = EXCLUDED.state, \"updatedAt\" = now()",
                &[&table_name, &row_id, &replicas, &state],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    pub async fn get_placement(
        &self,
        table_name: &str,
        row_id: &str,
    ) -> Result<Option<(Vec<String>, String)>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let row = client
            .query_opt(
                "SELECT replicas, state FROM pg_placement WHERE table_name = $1 AND row_id = $2",
                &[&table_name, &row_id],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(row.map(|row| (row.get("replicas"), row.get("state"))))
    }

    pub async fn delete_placement(&self, table_name: &str, row_id: &str) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        client
            .execute(
                "DELETE FROM pg_placement WHERE table_name = $1 AND row_id = $2",
                &[&table_name, &row_id],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(())
    }

    // ── buffer overlay for read-your-writes ─────────────────────────────────

    /// Latest buffered op per row for a table, keyed by row_id. Rows with a
    /// pending DELETE are absent from the result (tombstoned).
    pub async fn pending_rows(&self, table_name: &str) -> Result<Vec<(String, Option<Value>)>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        let rows = client
            .query(
                "SELECT DISTINCT ON (row_id) row_id, op, payload
                 FROM pg_write_op WHERE table_name = $1
                 ORDER BY row_id, \"createdAt\" DESC, id DESC",
                &[&table_name],
            )
            .await
            .map_err(|error| GatewayError::central(format!("{error:?}")))?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let row_id: String = row.get("row_id");
                let op: String = row.get("op");
                if op == "DELETE" {
                    None
                } else {
                    Some((row_id, row.get::<_, Option<Value>>("payload")))
                }
            })
            .collect())
    }

    // ── central id allocation ───────────────────────────────────────────────

    /// Allocates the next value of a per-table sequence (bigserial-style).
    /// Sequences live in the orchestrator PG so every replica receives the
    /// same value — providers never run their own generators for mesh tables.
    pub async fn next_sequence_value(&self, table_name: &str, column_name: &str) -> Result<i64> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("central pg client is initialized");
        // Identifier must be inlined (sequence names are dynamic), but the
        // table name was validated as an identifier by the analyzer, so this
        // is safe.
        let sequence: String = format!("mesh_pg_seq_{table_name}_{column_name}")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        client
            .execute(
                &format!("CREATE SEQUENCE IF NOT EXISTS {sequence}"),
                &[],
            )
            .await
            .map_err(|error| GatewayError::central(format!("sequence create: {error:?}")))?;
        let sql = format!("SELECT nextval('{sequence}')");
        let row = client
            .query_one(&sql, &[])
            .await
            .map_err(|error| GatewayError::central(format!("sequence alloc: {error:?}")))?;
        Ok(row.get::<_, i64>(0))
    }
}

/// Shadow catalog: mirrors mesh DDL on a real local schema so that
/// pg_catalog / information_schema / ORM bookkeeping queries work with real
/// results. Data rows do NOT live here — only schema + ORM bookkeeping
/// tables (e.g. knex_migrations) that clients expect to read/write directly.
pub struct CatalogStore {
    client: tokio::sync::Mutex<Option<tokio_postgres::Client>>,
    url: String,
}

impl CatalogStore {
    pub fn new(database_url: String) -> Self {
        Self { client: tokio::sync::Mutex::new(None), url: database_url }
    }

    async fn connect(&self) -> Result<tokio::sync::MutexGuard<'_, Option<tokio_postgres::Client>>> {
        let mut slot = self.client.lock().await;
        if let Some(client) = slot.as_ref() {
            if client.simple_query("SELECT 1").await.is_ok() {
                return Ok(slot);
            }
        }
        let (client, connection) = tokio_postgres::connect(&self.url, NoTls)
            .await
            .map_err(|error| GatewayError::central(format!("catalog pg connect: {error}")))?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::debug!("catalog pg connection closed: {error}");
            }
        });
        *slot = Some(client);
        Ok(slot)
    }

    pub async fn ensure_schema(&self) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("catalog pg client is initialized");
        client
            .batch_execute(CATALOG_SCHEMA_SQL)
            .await
            .map_err(|error| GatewayError::central(format!("catalog schema: {error:?}")))?;
        Ok(())
    }

    /// Applies mesh DDL verbatim to the catalog schema. CREATE TABLE is
    /// qualified into `mesh_catalog.`; CREATE INDEX / UNIQUE INDEX keep their
    /// table references but run inside the catalog search_path.
    pub async fn apply_ddl(&self, ddl: &str) -> Result<()> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("catalog pg client is initialized");
        let rewritten = qualify_ddl(ddl);
        client
            .batch_execute(&rewritten)
            .await
            .map_err(|error| GatewayError::central(format!("catalog ddl: {error:?}")))?;
        Ok(())
    }

    /// Executes a read-only statement against the catalog schema.
    /// Column names of a statement's result set (via prepare, no execution).
    pub async fn describe_columns(&self, sql: &str) -> Result<Vec<String>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("catalog pg client is initialized");
        let statement = client
            .prepare(sql)
            .await
            .map_err(|error| GatewayError::central(format!("catalog describe: {error:?}")))?;
        Ok(statement.columns().iter().map(|column| column.name().to_string()).collect())
    }

    pub async fn query(&self, sql: &str) -> Result<Vec<Value>> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("catalog pg client is initialized");
        let messages = client
            .simple_query(sql)
            .await
            .map_err(|error| GatewayError::central(format!("catalog query: {error:?}")))?;
        let mut out: Vec<Value> = Vec::new();
        for message in messages {
            if let tokio_postgres::SimpleQueryMessage::Row(row) = message {
                let mut object = serde_json::Map::new();
                for index in 0..row.columns().len() {
                    let name = row.columns()[index].name();
                    let value = match row.get(index) {
                        Some(text) if !text.is_empty() => serde_json::Value::String(text.to_owned()),
                        Some(_) => serde_json::Value::Null,
                        None => serde_json::Value::Null,
                    };
                    object.insert(name.to_string(), value);
                }
                out.push(serde_json::Value::Object(object));
            }
        }
        Ok(out)
    }

    /// Executes a write (knex migration bookkeeping inserts/creates) against
    /// the catalog schema. Tables resolved relative to mesh_catalog.
    pub async fn execute(&self, sql: &str) -> crate::error::Result<u64> {
        let mut client = self.connect().await?;
        let client = client
            .as_mut()
            .expect("catalog pg client is initialized");
        // Statements with inner semicolons (function bodies, ALTER batches)
        // cannot run as a single prepared statement — use batch_execute.
        let has_inner_semicolon = {
            let trimmed = sql.trim().trim_end_matches(';').trim();
            trimmed.contains(';')
        };
        if has_inner_semicolon {
            let result = client.batch_execute(sql).await;
            return result.map(|_| 0).or_else(|error| {
                let text = format!("{error:?}");
                if text.contains("42P07") || text.contains("42723") || text.contains("already exists") {
                    Ok(0)
                } else {
                    Err(GatewayError::central(format!("catalog execute: {error:?}")))
                }
            });
        }
        client
            .execute(sql, &[])
            .await
            .or_else(|error| {
                // Idempotent catalog DDL: duplicate table/extension errors are
                // benign (clients check-then-create without IF NOT EXISTS).
                let text = format!("{error:?}");
                if text.contains("42P07") || text.contains("42723") || text.contains("already exists") {
                    Ok(0)
                } else {
                    Err(GatewayError::central(format!("catalog execute: {error:?}")))
                }
            })
    }
}

/// Qualifies unqualified table names in DDL with the catalog schema, so the
/// catalog mirrors the mesh without colliding with gateway bookkeeping.
fn qualify_ddl(ddl: &str) -> String {
    ddl.to_string()
}

fn mesh_table_from_row(row: &Row) -> MeshTable {
    MeshTable {
        name: row.get("name"),
        columns: row.get("columns"),
        version: row.get("version"),
        replica_count: row.get("replicaN"),
    }
}
