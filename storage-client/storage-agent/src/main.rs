mod capacity;
mod config;
mod health;
mod identity;
mod mesh;
mod report;

use std::env;

use config::Config;
use nostr::nips::nip19::ToBech32;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), String> {
    if env::args().nth(1).as_deref() == Some("healthcheck") {
        let port = env::var("AGENT_HEALTH_PORT")
            .unwrap_or_else(|_| "3010".to_string())
            .parse()
            .map_err(|_| "AGENT_HEALTH_PORT must be a TCP port".to_string())?;
        return health::check(port).await;
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,storage_agent=debug")),
        )
        .init();

    let config = Config::from_env().map_err(|error| format!("configuration error: {error}"))?;
    let (keys, storage_npub) = identity::load(&config.secret_path, &config.marker_path)?;
    let host_npub = config
        .host_npub
        .to_bech32()
        .map_err(|_| "could not encode control-plane host npub".to_string())?;
    tracing::info!(%storage_npub, %host_npub, url = %config.control_url, "storage-agent starting");

    let health = health::HealthState::new();
    let health_server = health.clone();
    let health_port = config.health_port;
    tokio::spawn(async move {
        if let Err(error) = health::serve(health_port, health_server).await {
            tracing::error!(%error, "health listener stopped");
        }
    });

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("could not build HTTP client: {error}"))?;
    loop {
        let result =
            capacity::measure([config.blossom_path.as_path(), config.relay_path.as_path()])
                .and_then(|capacity| {
                    if capacity.free > capacity.total {
                        Err("measured free capacity exceeded total capacity".to_string())
                    } else {
                        Ok(capacity)
                    }
                });
        let success = match result {
            Ok(capacity) => report::send(
                &http,
                &config.control_url,
                &keys,
                config.blossom_port,
                config.relay_port,
                capacity,
            )
            .await
            .map(|_| {
                tracing::info!(
                    total_bytes = capacity.total,
                    free_bytes = capacity.free,
                    "storage report accepted"
                );
            }),
            Err(error) => Err(error),
        };
        health.set_ping(success.is_ok());
        let delay = match success {
            Ok(()) => config.ping_interval,
            Err(error) => {
                tracing::warn!(%error, retry_secs = config.retry_interval.as_secs(), "storage report failed");
                config.retry_interval
            }
        };
        tokio::time::sleep(delay).await;
    }
}
