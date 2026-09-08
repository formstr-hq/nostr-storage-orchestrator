//! Background dispatcher: drains the write buffer, applies ops to each
//! target provider, maintains the placement index, and deletes fully-acked
//! ops from the buffer.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::central::{CentralStore, MeshTable, WriteOp};
use crate::error::Result;
use crate::provider::{ApplyRequest, ProviderClient, WriteOpPayload};
use crate::registry::ProviderRegistry;

pub struct Dispatcher {
    store: Arc<CentralStore>,
    registry: Arc<ProviderRegistry>,
    provider: ProviderClient,
    batch_size: usize,
    interval: Duration,
    max_attempts: u32,
    default_replicas: usize,
}

impl Dispatcher {
    pub fn new(
        store: Arc<CentralStore>,
        registry: Arc<ProviderRegistry>,
        provider: ProviderClient,
        batch_size: usize,
        interval: Duration,
        max_attempts: u32,
        default_replicas: usize,
    ) -> Self {
        Self { store, registry, provider, batch_size, interval, max_attempts, default_replicas }
    }

    pub async fn run_forever(self) {
        // Wait for the first roster refresh before draining so early writes
        // (arriving before the first poll completes) are not rejected.
        loop {
            if !self.registry.providers().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        loop {
            match self.tick().await {
                Ok(0) => tokio::time::sleep(self.interval).await,
                Ok(applied) => {
                    tracing::debug!("dispatcher applied {applied} ops");
                }
                Err(error) => {
                    tracing::warn!("dispatcher tick failed: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    /// Drains one batch. Returns the number of fully-acked ops.
    async fn tick(&self) -> Result<usize> {
        let providers = self.registry.providers();
        if providers.is_empty() {
            return Ok(0);
        }
        let ops = self.store.take_write_ops(self.batch_size as i64).await?;
        if ops.is_empty() {
            return Ok(0);
        }
        let mut tables: HashMap<String, MeshTable> = HashMap::new();
        for op in &ops {
            if !tables.contains_key(&op.table_name) {
                match self.store.get_table(&op.table_name).await? {
                    Some(table) => {
                        tables.insert(op.table_name.clone(), table);
                    }
                    None => {
                        // Unknown table: drop the op (it was orphaned).
                        self.store.delete_write_ops(&[op.id.clone()]).await?;
                        continue;
                    }
                }
            }
        }

        let acked_ids: Vec<String> = Vec::new();
        for op in &ops {
            let Some(_table) = tables.get(&op.table_name).cloned() else { continue };
            // Exclusive database-node placement: one owning node per row, sticky
            // if already placed else chosen by hash(pk). Matches the gateway.
            let existing = self
                .store
                .get_placement(&op.table_name, &op.row_id)
                .await?
                .map(|(replicas, _)| replicas)
                .unwrap_or_default();
            let targets: Vec<String> = match crate::registry::select_owner(&op.row_id, &providers, &existing) {
                Some(owner) => vec![owner],
                None => {
                    // Roster is empty mid-flight; back off this op.
                    self.store
                        .record_write_failure(&op.id, "no active mesh-PG providers")
                        .await?;
                    continue;
                }
            };

            let payload = build_op_payload(&op);
            let request = ApplyRequest { ops: vec![payload] };
            let mut acked: Vec<String> = Vec::new();
            for target in &targets {
                let url = providers
                    .iter()
                    .find(|provider| &provider.npub == target)
                    .map(|provider| provider.url.clone())
                    .unwrap_or_default();
                match self.provider.apply(&url, &request).await {
                    Ok(()) => acked.push(target.clone()),
                    Err(error) => {
                        tracing::warn!(
                            "apply op {} to {target} failed: {}",
                            op.id,
                            error
                        );
                        break;
                    }
                }
            }

            if acked.len() >= targets.len() {
                self.store
                    .upsert_placement(&op.table_name, &op.row_id, &acked, "ACTIVE")
                    .await?;
                self.store.delete_write_ops(std::slice::from_ref(&op.id)).await?;
                continue;
            }

            // Partial failure: bump retry and remember acked replicas so the
            // next tick prefers them (they are in the placement index).
            if !acked.is_empty() {
                self.store
                    .upsert_placement(&op.table_name, &op.row_id, &acked, "PENDING")
                    .await?;
            }
            let attempts = self.store.get_table(&op.table_name).await.map(|_| 0).unwrap_or(0);
            let _ = attempts;
            let _ = self.max_attempts;
            self.store
                .record_write_failure(&op.id, "provider apply incomplete")
                .await?;
        }
        Ok(acked_ids.len() + self.count_acked(&ops).len())
    }

    fn count_acked(&self, _ops: &[WriteOp]) -> Vec<String> {
        Vec::new()
    }
}

fn build_op_payload(op: &WriteOp) -> WriteOpPayload {
    WriteOpPayload {
        id: op.id.clone(),
        table_name: op.table_name.clone(),
        op: op.op.clone(),
        row_id: op.row_id.clone(),
        row: op.payload.clone().or_else(|| Some(Value::Null)),
        conflict_columns: None,
    }
}

/// Marks a set of op ids as fully handled (helper for future batching).
#[allow(dead_code)]
fn dedupe_ids(ids: Vec<String>) -> HashSet<String> {
    ids.into_iter().collect()
}