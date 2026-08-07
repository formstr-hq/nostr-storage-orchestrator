use admin_backend::{Config, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // RUST_LOG overrides this; the default is quiet on library noise but shows
    // per-request spans and every nvpn/authorization decision this service makes.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new("info,admin_backend=debug,tower_http=info")
        }))
        .init();

    let config = Config::from_env().map_err(|message| format!("configuration error: {message}"))?;
    let listen_addr = config.listen_addr;
    tracing::info!(%listen_addr, "admin-backend starting");
    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    axum::serve(listener, router(config.into_state()))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
