//! Provider roster: polls db-api's /storages/active-pg every few seconds,
//! same pattern as ServerRegistry in proxy/blossom/src/servers.ts. The
//! gateway always targets providers through tunnelIp + pgAgentPort, never
//! client-supplied URLs.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;

use crate::central::ActivePgStorage;

#[derive(Clone)]
pub struct ProviderRegistry {
    inner: Arc<RwLock<Vec<ActivePgStorage>>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(Vec::new())) }
    }

    pub async fn spawn_refresh(self: &Arc<Self>, db_api_url: String, poll: Duration) {
        loop {
            match refresh_once(&db_api_url).await {
                Ok(providers) => {
                    *self.inner.write() = providers;
                }
                Err(error) => {
                    tracing::debug!("pg registry refresh failed (retaining last roster): {error}");
                }
            }
            tokio::time::sleep(poll).await;
        }
    }

    pub fn providers(&self) -> Vec<ActivePgStorage> {
        self.inner.read().clone()
    }

    pub fn resolve(&self, npub: &str) -> Option<ActivePgStorage> {
        self.inner.read().iter().find(|provider| provider.npub == npub).cloned()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

async fn refresh_once(db_api_url: &str) -> std::result::Result<Vec<ActivePgStorage>, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Record {
        npub: String,
        tunnel_ip: String,
        pg_agent_port: i32,
    }

    let url = format!("{db_api_url}/storages/active-pg");
    let response = reqwest::get(&url)
        .await
        .map_err(|error| format!("{url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} returned {}", response.status()));
    }
    let records: Vec<Record> = response.json().await.map_err(|error| format!("{url}: {error}"))?;
    Ok(records
        .into_iter()
        .filter_map(|record| {
            let port = u16::try_from(record.pg_agent_port).ok()?;
            Some(ActivePgStorage {
                npub: record.npub,
                url: format!("http://{}:{port}", record.tunnel_ip),
            })
        })
        .collect())
}

/// Exclusive database-node placement: the single node that owns a row.
///
/// Sticky — if the row already has a still-active owner, keep it so a row never
/// migrates on its own. Otherwise pick deterministically by hash(row_id) over
/// the roster sorted by npub, so events spread evenly and the choice is stable
/// and independent of the order providers happen to be polled in.
pub fn select_owner(
    row_id: &str,
    providers: &[ActivePgStorage],
    existing: &[String],
) -> Option<String> {
    if let Some(owner) = existing
        .iter()
        .find(|npub| providers.iter().any(|provider| &provider.npub == *npub))
    {
        return Some(owner.clone());
    }
    if providers.is_empty() {
        return None;
    }
    let mut npubs: Vec<&str> = providers.iter().map(|provider| provider.npub.as_str()).collect();
    npubs.sort_unstable();
    let index = (fnv1a(row_id) % npubs.len() as u64) as usize;
    Some(npubs[index].to_string())
}

/// Stable, seedless 64-bit hash (FNV-1a). Used only for even placement spread,
/// so it needs determinism across restarts, not cryptographic strength.
fn fnv1a(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
