//! Schema manager: intercepts DDL, versions it in the registry, and
//! propagates migrations to all active providers (plus late joiners).

use std::sync::Arc;
use std::time::Duration;
use crate::sqlanalyze;

use ulid::Ulid;

use crate::central::{CentralStore, PendingMigration};
use crate::error::{GatewayError, Result};
use crate::provider::ProviderClient;
use crate::registry::ProviderRegistry;
use crate::sqlanalyze::StatementKind;

pub struct SchemaManager {
    store: Arc<CentralStore>,
    registry: Arc<ProviderRegistry>,
    provider: ProviderClient,
}

impl SchemaManager {
    pub fn new(store: Arc<CentralStore>, registry: Arc<ProviderRegistry>, provider: ProviderClient) -> Self {
        Self { store, registry, provider }
    }

    /// Applies an incoming DDL statement: validates the subset, records the
    /// migration PENDING, pushes to currently-active providers, then flips
    /// the registry state to APPLIED (per active cohort).
    pub async fn handle_ddl(&self, kind: StatementKind, table: &str, sql: &str) -> Result<()> {
        sqlanalyze::is_additive_ddl(&kind, sql)?;
        let migration_id = Ulid::new().to_string();
        match kind {
            StatementKind::Create => {
                if self.store.get_table(table).await?.is_some() {
                    return Err(GatewayError::UnsupportedSql(format!(
                        "table \"{table}\" already exists in the mesh registry"
                    )));
                }
                let columns = sqlanalyze::extract_create_columns(sql)?;
                self.store
                    .create_table(table, columns, 1, sql, &migration_id)
                    .await?;
                tracing::info!("registered mesh table {table}");
            }
            StatementKind::Alter | StatementKind::Drop => {
                // Keep the registry descriptor in sync with ADD COLUMNs:
                // describe builds RowDescription from it, so a stale
                // descriptor desyncs column counts on the wire.
                let added = sqlanalyze::extract_add_columns(sql)?;
                if !added.is_empty() {
                    self.store.add_table_columns(table, &added).await?;
                }
                // Bump the registry version with a new PENDING migration.
                self.store.append_migration(sql, &migration_id).await?;
            }
            _ => unreachable!("only DDL kinds reach handle_ddl"),
        }
        self.propagate_now(&migration_id).await?;
        Ok(())
    }

    /// Propagates a DDL statement (e.g. CREATE INDEX) to all active
    /// providers without touching the table registry.
    pub async fn propagate_ddl(&self, sql: &str) -> Result<()> {
        let migration_id = Ulid::new().to_string();
        self.store.append_migration(sql, &migration_id).await?;
        self.propagate_now(&migration_id).await?;
        Ok(())
    }

    /// Pushes PENDING migrations to every active provider immediately.
    async fn propagate_now(&self, migration_id: &str) -> Result<()> {
        let migrations = self.pending_migrations_from(migration_id).await?;
        if migrations.is_empty() {
            return Ok(());
        }
        let providers = self.registry.providers();
        for provider in &providers {
            match self.provider.schema(&provider.url, &migrations).await {
                Ok(version) => {
                    self.store.record_migration_state(&provider.npub, version).await?;
                    tracing::info!("provider {} accepted schema version {version}", provider.npub);
                }
                Err(error) => {
                    tracing::warn!(
                        "provider {} rejected migrations: {} (will retry on handshake)",
                        provider.npub,
                        error
                    );
                }
            }
        }
        // The migration is APPLIED once the active cohort acked (best-effort
        // in v0: stragglers catch up via catch_up_provider on reconnect).
        self.store.mark_migration_applied(migration_id).await?;
        Ok(())
    }

    async fn pending_migrations_from(&self, _migration_id: &str) -> Result<Vec<PendingMigration>> {
        self.store.pending_migrations().await
    }

    /// Late-joiner / recovered-provider catch-up: called on registry
    /// refresh. Sends every migration the provider has not acked yet.
    pub async fn catch_up_provider(&self, npub: &str, url: &str) -> Result<()> {
        let current = self.store.provider_schema_version(npub).await?;
        let migrations = self.store.migrations_since(current).await?;
        if migrations.is_empty() {
            return Ok(());
        }
        let version = self.provider.schema(url, &migrations).await?;
        self.store.record_migration_state(npub, version).await?;
        tracing::info!("provider {npub} caught up to schema version {version}");
        Ok(())
    }

    /// Runs one catch-up sweep over the active roster.
    pub async fn catch_up_sweep(&self) {
        for provider in self.registry.providers() {
            if let Err(error) = self.catch_up_provider(&provider.npub, &provider.url).await {
                tracing::debug!("schema catch-up for {} failed: {error}", provider.npub);
            }
        }
    }

    pub async fn spawn_catch_up_loop(self: Arc<Self>, interval: Duration) {
        loop {
            self.catch_up_sweep().await;
            tokio::time::sleep(interval).await;
        }
    }
}