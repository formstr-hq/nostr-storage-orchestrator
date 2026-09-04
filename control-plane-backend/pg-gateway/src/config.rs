use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    /// pgwire listen address for mesh-PG clients.
    pub listen_addr: String,
    /// db-api base URL (roster + Prisma-managed pg_* tables).
    pub db_api_url: String,
    /// Central Postgres (write buffer, placement index, schema registry).
    /// Built from POSTGRES_* unless DATABASE_URL is set.
    pub central_database_url: String,
    /// How often the provider registry re-polls /storages/active-pg.
    pub registry_poll: Duration,
    /// Worker poll cadence for buffered write ops.
    pub dispatch_interval: Duration,
    /// Max ops per /pg/apply batch.
    pub dispatch_batch_size: usize,
    /// Consecutive provider failures before an op's replica is replaced.
    pub max_provider_attempts: u32,
    /// Per-provider HTTP timeout.
    pub provider_timeout: Duration,
    /// Fan-out read per-provider timeout.
    pub fanout_timeout: Duration,
    /// Bearer token required by /pg/* endpoints on providers.
    pub provider_token: Option<String>,
    /// pgwire auth: fixed password when set, otherwise cleartext-accept-any.
    pub gateway_password: Option<String>,
    /// Replica count used when a table does not override it.
    pub default_replica_count: usize,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            listen_addr: std::env::var("PG_GATEWAY_LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:5432".to_string()),
            db_api_url: std::env::var("DB_API_URL")
                .unwrap_or_else(|_| format!("http://127.0.0.1:{}", port_env("DB_API_PORT", 4000)))
                .trim_end_matches('/')
                .to_string(),
            central_database_url: central_database_url()?,
            registry_poll: Duration::from_secs(u64_env("PG_REGISTRY_POLL_SECS", 15)),
            dispatch_interval: Duration::from_millis(u64_env("PG_DISPATCH_INTERVAL_MS", 200)),
            dispatch_batch_size: usize_env("PG_DISPATCH_BATCH_SIZE", 100),
            max_provider_attempts: u32_env("PG_MAX_PROVIDER_ATTEMPTS", 3),
            provider_timeout: Duration::from_secs(u64_env("PG_PROVIDER_TIMEOUT_SECS", 10)),
            fanout_timeout: Duration::from_secs(u64_env("PG_FANOUT_TIMEOUT_SECS", 10)),
            provider_token: nonempty_env("PG_PROVIDER_TOKEN"),
            gateway_password: nonempty_env("PG_GATEWAY_PASSWORD"),
            default_replica_count: usize_env("PG_DEFAULT_REPLICA_COUNT", 1),
        })
    }
}

fn port_env(name: &str, default: u16) -> u16 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn u64_env(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn u32_env(name: &str, default: u32) -> u32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn usize_env(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Connection info is derived from POSTGRES_* unless DATABASE_URL is set,
/// mirroring packages/db/src/prisma.ts so no password ever needs URL-encoding.
fn central_database_url() -> Result<String, String> {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        if !url.trim().is_empty() {
            return Ok(url);
        }
    }
    let host = std::env::var("POSTGRES_HOST").unwrap_or_else(|_| "localhost".to_string());
    let port = std::env::var("POSTGRES_PORT").unwrap_or_else(|_| "5432".to_string());
    let user = std::env::var("POSTGRES_USER").map_err(|_| "POSTGRES_USER is required".to_string())?;
    let password =
        std::env::var("POSTGRES_PASSWORD").map_err(|_| "POSTGRES_PASSWORD is required".to_string())?;
    let db = std::env::var("POSTGRES_DB").map_err(|_| "POSTGRES_DB is required".to_string())?;
    Ok(format!("host={host} port={port} user={user} password={password} dbname={db}"))
}