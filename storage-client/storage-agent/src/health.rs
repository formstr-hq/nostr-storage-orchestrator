use std::{
    net::Ipv4Addr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use axum::{Json, Router, routing::get};
use serde::Serialize;

#[derive(Clone)]
pub struct HealthState {
    last_ping_ok: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    last_ping_ok: bool,
}

impl HealthState {
    pub fn new() -> Self {
        Self {
            last_ping_ok: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_ping(&self, success: bool) {
        self.last_ping_ok.store(success, Ordering::Relaxed);
    }
}

pub async fn serve(port: u16, state: HealthState) -> Result<(), String> {
    let app = Router::new().route(
        "/health",
        get(move || async move {
            Json(HealthResponse {
                status: "ok",
                last_ping_ok: state.last_ping_ok.load(Ordering::Relaxed),
            })
        }),
    );
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|error| format!("could not bind agent health listener: {error}"))?;
    axum::serve(listener, app)
        .await
        .map_err(|error| format!("agent health server failed: {error}"))
}

pub async fn check(port: u16) -> Result<(), String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("health endpoint returned {}", response.status()))
    }
}
