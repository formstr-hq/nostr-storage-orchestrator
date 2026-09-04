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
