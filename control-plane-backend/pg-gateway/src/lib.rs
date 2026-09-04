pub mod central;
mod config;
mod dispatcher;
pub mod error;
mod pgwirehandler;
mod provider;
mod readengine;
mod registry;
mod schema;
pub mod sqlanalyze;

use std::sync::Arc;

use config::Config;
use pgwirehandler::GatewayHandlers;
use provider::ProviderClient;
use readengine::ReadEngine;
use registry::ProviderRegistry;
use schema::SchemaManager;
use tokio::net::TcpListener;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,pg_gateway=debug")),
        )
        .init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async_main())?;
    Ok(())
}

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env().map_err(|message| format!("configuration error: {message}"))?;
    tracing::info!(listen = %config.listen_addr, "pg-gateway starting");

    let store = Arc::new(central::CentralStore::new(config.central_database_url.clone()));
    store
        .ensure_schema()
        .await
        .map_err(|error| format!("central schema bootstrap failed: {error}"))?;
    tracing::info!("central mesh-PG schema ensured");

    let provider_client = ProviderClient::new(config.provider_timeout, config.provider_token.clone());
    let registry = Arc::new(ProviderRegistry::new());
    {
        let registry = registry.clone();
        let db_api_url = config.db_api_url.clone();
        let poll = config.registry_poll;
        tokio::spawn(async move { registry.spawn_refresh(db_api_url, poll).await });
    }

    let schema = Arc::new(SchemaManager::new(store.clone(), registry.clone(), provider_client.clone()));
    {
        let schema = schema.clone();
        let interval = config.registry_poll;
        tokio::spawn(async move { schema.spawn_catch_up_loop(interval).await });
    }

    let read = Arc::new(ReadEngine::new(store.clone(), registry.clone(), provider_client.clone()));
    let dispatcher = dispatcher::Dispatcher::new(
        store.clone(),
        registry.clone(),
        provider_client.clone(),
        config.dispatch_batch_size,
        config.dispatch_interval,
        config.max_provider_attempts,
        config.default_replica_count,
    );
    tokio::spawn(dispatcher.run_forever());

    let handlers = GatewayHandlers {
        store,
        registry,
        provider: provider_client,
        schema,
        read,
        write_lock: Arc::new(tokio::sync::Mutex::new(())),
        auth_password: config.gateway_password.clone(),
    };

    let listener = TcpListener::bind(&config.listen_addr).await?;
    tracing::info!(listen = %config.listen_addr, "pg-gateway listening");
    loop {
        let (socket, peer) = listener.accept().await?;
        let handlers = handlers.clone();
        tokio::spawn(async move {
            tracing::debug!(%peer, "client connected");
            if let Err(error) = pgwire::tokio::process_socket(socket, None, handlers).await {
                tracing::debug!(%peer, "client connection ended: {error}");
            }
        });
    }
}