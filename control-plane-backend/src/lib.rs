mod auth;
mod config;
mod db_client;
mod error;
mod nvpn;
mod routes;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{
        Method,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
};
use nostr::event::EventId;
use tokio::sync::Mutex;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};
use tracing::{error, info};

pub use config::Config;
use db_client::DbClient;
use error::ApiError;
use nvpn::{Nvpn, PeerCache};

const MAX_BODY_BYTES: usize = 4 * 1024;

#[derive(Clone)]
pub struct AppState {
    public_base: Arc<str>,
    mesh_base: Arc<str>,
    bootstrap_admins: Arc<Vec<String>>,
    used_auth_events: Arc<StdMutex<HashMap<EventId, Instant>>>,
    db: DbClient,
    nvpn: Nvpn,
    private_cidr: ipnet::IpNet,
    active_freshness: Duration,
    pending_reap_grace: Duration,
    peer_cache_ttl: Duration,
    peer_cache: Arc<Mutex<Option<PeerCache>>>,
    admin_mutation_lock: Arc<Mutex<()>>,
}

impl AppState {
    pub async fn initialize(&self) -> Result<(), ApiError> {
        let members = self.db.list_members().await?;
        if members.is_empty() {
            for npub in self.bootstrap_admins.iter() {
                self.db
                    .put_member(npub, db_client::MemberRole::Admin, None)
                    .await?;
            }
            if !self.bootstrap_admins.is_empty() {
                info!(
                    count = self.bootstrap_admins.len(),
                    "seeded bootstrap administrators"
                );
            }
        }
        Ok(())
    }

    pub fn spawn_pending_reaper(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = routes::storage::reap_pending(&state).await {
                    error!(%error, "pending storage reap failed");
                }
            }
        });
    }
}

pub fn router(state: AppState) -> Router {
    routes::router()
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(cors())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .max_age(Duration::from_secs(600))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use ipnet::IpNet;
    use tower::ServiceExt;

    use super::*;

    fn state() -> AppState {
        AppState {
            public_base: Arc::from("https://admin.example.com"),
            mesh_base: Arc::from("http://10.44.0.1:3002"),
            bootstrap_admins: Arc::new(Vec::new()),
            used_auth_events: Arc::new(StdMutex::new(HashMap::new())),
            db: DbClient::new("http://127.0.0.1:1".to_string()),
            nvpn: Nvpn::new(PathBuf::from("unused"), PathBuf::from("unused")),
            private_cidr: "10.44.0.0/16".parse::<IpNet>().unwrap(),
            active_freshness: Duration::from_secs(960),
            pending_reap_grace: Duration::from_secs(86_400),
            peer_cache_ttl: Duration::from_secs(15),
            peer_cache: Arc::new(Mutex::new(None)),
            admin_mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    #[tokio::test]
    async fn health_is_public_and_protected_routes_require_auth() {
        let app = router(state());
        let health = app
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        let protected = app
            .oneshot(Request::get("/v1/status").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(protected.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn nip98_routes_allow_browser_preflight_but_devices_are_removed() {
        let app = router(state());
        let preflight = app
            .clone()
            .oneshot(
                Request::options("/v1/storage")
                    .header("origin", "https://operator.example")
                    .header("access-control-request-method", "POST")
                    .header("access-control-request-headers", "authorization")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::OK);
        assert_eq!(
            preflight
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "*"
        );
        let removed = app
            .oneshot(Request::post("/v1/devices").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(removed.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn request_body_is_bounded() {
        let response = router(state())
            .oneshot(
                Request::post("/v1/storage")
                    .body(Body::from(vec![b'x'; MAX_BODY_BYTES + 1]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
