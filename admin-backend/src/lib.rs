use std::{
    collections::{HashMap, HashSet},
    env,
    net::SocketAddr,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{
        HeaderMap, Method, StatusCode,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose};
use nostr::{
    event::{Event, EventId},
    key::PublicKey,
    nips::{
        nip19::{FromBech32, ToBech32},
        nip98::{HttpMethod, verify_auth_header},
    },
    types::Timestamp,
};
use serde::{Deserialize, Serialize};
use tokio::{process::Command, sync::Mutex, time::timeout};
use tower_http::cors::{AllowOrigin, CorsLayer};
use url::Url;

const DEFAULT_PORT: u16 = 3002;
const DEFAULT_NVPN_CONFIG: &str = "/data/config/nvpn/config.toml";
const DEFAULT_NVPN_BIN: &str = "nvpn";
const MAX_BODY_BYTES: usize = 4 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
const REPLAY_WINDOW: Duration = Duration::from_secs(90);

#[derive(Clone)]
pub struct AppState {
    allowed_pubkeys: Arc<HashSet<PublicKey>>,
    public_base: Arc<str>,
    used_auth_events: Arc<StdMutex<HashMap<EventId, Instant>>>,
    nvpn: Nvpn,
}

#[derive(Clone)]
struct Nvpn {
    bin: Arc<PathBuf>,
    config: Arc<PathBuf>,
    command_lock: Arc<Mutex<()>>,
    command_timeout: Duration,
}

#[derive(Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    allowed_pubkeys: HashSet<PublicKey>,
    public_base: String,
    nvpn_bin: PathBuf,
    nvpn_config: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = match env::var("ADMIN_API_PORT") {
            Ok(value) => value
                .parse::<u16>()
                .map_err(|_| "ADMIN_API_PORT must be a valid TCP port".to_string())?,
            Err(env::VarError::NotPresent) => DEFAULT_PORT,
            Err(env::VarError::NotUnicode(_)) => {
                return Err("ADMIN_API_PORT must be valid UTF-8".to_string());
            }
        };

        let allowed = env::var("ADMIN_ALLOWED_PUBKEYS")
            .map_err(|_| "ADMIN_ALLOWED_PUBKEYS is required".to_string())?;
        let allowed_pubkeys = parse_allowlist(&allowed)?;

        let configured_public_url = match env::var("ADMIN_PUBLIC_URL") {
            Ok(value) => Some(value),
            Err(env::VarError::NotPresent) => None,
            Err(env::VarError::NotUnicode(_)) => {
                return Err("ADMIN_PUBLIC_URL must be valid UTF-8".to_string());
            }
        };
        let public_base = parse_public_base(
            configured_public_url.as_deref(),
            port,
            !cfg!(debug_assertions),
        )?;

        Ok(Self {
            listen_addr: SocketAddr::from(([0, 0, 0, 0], port)),
            allowed_pubkeys,
            public_base,
            nvpn_bin: env::var_os("NVPN_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_NVPN_BIN)),
            nvpn_config: env::var_os("NVPN_CONFIG")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_NVPN_CONFIG)),
        })
    }

    pub fn into_state(self) -> AppState {
        AppState {
            allowed_pubkeys: Arc::new(self.allowed_pubkeys),
            public_base: self.public_base.into(),
            used_auth_events: Arc::new(StdMutex::new(HashMap::new())),
            nvpn: Nvpn {
                bin: Arc::new(self.nvpn_bin),
                config: Arc::new(self.nvpn_config),
                command_lock: Arc::new(Mutex::new(())),
                command_timeout: COMMAND_TIMEOUT,
            },
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/status", get(status))
        .route("/v1/invites", post(create_invite))
        .route("/v1/devices", post(add_device))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(cors())
        .with_state(state)
}

/// Permit browser clients from any origin.
///
/// The admin client ships as a web build as well as a native one, and an
/// operator may serve it from anywhere, so there is no origin list to keep.
/// This is safe because authority here comes from a NIP-98 `Authorization`
/// header the caller must sign with an allowlisted key — never from an ambient
/// cookie. Credentials are therefore left off (and must be, alongside
/// `AllowOrigin::any`), so a hostile page can reach these routes but cannot
/// authenticate to them: `authorize` still checks the signature, the URL, the
/// timestamp, replay, and `ADMIN_ALLOWED_PUBKEYS`.
fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods([Method::GET, Method::POST])
        // NIP-98 makes every request non-simple, so each one is preflighted.
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .max_age(Duration::from_secs(600))
}

fn parse_allowlist(raw: &str) -> Result<HashSet<PublicKey>, String> {
    let mut allowed = HashSet::new();
    for (index, entry) in raw.split(',').enumerate() {
        let entry = entry.trim();
        if entry.is_empty() {
            return Err(format!(
                "ADMIN_ALLOWED_PUBKEYS entry {} is empty",
                index + 1
            ));
        }

        let key = PublicKey::parse(entry).map_err(|_| {
            format!(
                "ADMIN_ALLOWED_PUBKEYS entry {} is not an npub or hex public key",
                index + 1
            )
        })?;
        let canonical_npub = key
            .to_bech32()
            .expect("PublicKey NIP-19 encoding is infallible");
        let is_npub = entry == canonical_npub;
        let is_hex = entry.len() == 64 && entry.eq_ignore_ascii_case(&key.to_hex());
        if !is_npub && !is_hex {
            return Err(format!(
                "ADMIN_ALLOWED_PUBKEYS entry {} must be an npub or 64-character hex key",
                index + 1
            ));
        }
        allowed.insert(key);
    }

    if allowed.is_empty() {
        return Err("ADMIN_ALLOWED_PUBKEYS must contain at least one key".to_string());
    }
    Ok(allowed)
}

fn parse_public_base(value: Option<&str>, port: u16, production: bool) -> Result<String, String> {
    let value = match value {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        Some(_) => return Err("ADMIN_PUBLIC_URL cannot be empty".to_string()),
        None if production => {
            return Err("ADMIN_PUBLIC_URL is required in release builds".to_string());
        }
        None => format!("http://localhost:{port}"),
    };

    let url =
        Url::parse(&value).map_err(|_| "ADMIN_PUBLIC_URL must be an absolute URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "ADMIN_PUBLIC_URL must be an http(s) base URL without credentials, query, or fragment"
                .to_string(),
        );
    }

    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StatusResponse>, ApiError> {
    authorize(&state, &headers, "/v1/status", HttpMethod::GET, None, false)?;
    let output = state
        .nvpn
        .run(&[
            "status",
            "--config",
            &state.nvpn.config.to_string_lossy(),
            "--json",
        ])
        .await?;
    Ok(Json(parse_status(&output)?))
}

async fn create_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<InviteResponse>, ApiError> {
    authorize(
        &state,
        &headers,
        "/v1/invites",
        HttpMethod::POST,
        Some(&body),
        true,
    )?;
    ensure_empty_json_body(&body)?;

    let output = state
        .nvpn
        .run(&[
            "create-invite",
            "--config",
            &state.nvpn.config.to_string_lossy(),
        ])
        .await?;
    let invite = extract_invite(&output)?;
    Ok(Json(InviteResponse { invite }))
}

async fn add_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<DeviceResponse>, ApiError> {
    authorize(
        &state,
        &headers,
        "/v1/devices",
        HttpMethod::POST,
        Some(&body),
        true,
    )?;

    let request: DeviceRequest =
        serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest("invalid JSON body"))?;
    let npub = parse_device_npub(&request.npub)?;
    state.nvpn.add_device_and_reload(&npub).await?;
    Ok(Json(DeviceResponse { npub, added: true }))
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    method: HttpMethod,
    body: Option<&[u8]>,
    consume: bool,
) -> Result<PublicKey, ApiError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let url =
        Url::parse(&format!("{}{path}", state.public_base)).map_err(|_| ApiError::Internal)?;
    let pubkey = verify_auth_header(auth_header, &url, method, Timestamp::now(), body)
        .map_err(|_| ApiError::Unauthorized)?;
    if !state.allowed_pubkeys.contains(&pubkey) {
        return Err(ApiError::Forbidden);
    }
    if consume {
        consume_auth_event(state, auth_header)?;
    }
    Ok(pubkey)
}

fn consume_auth_event(state: &AppState, auth_header: &str) -> Result<(), ApiError> {
    let encoded = auth_header
        .strip_prefix("Nostr ")
        .ok_or(ApiError::Unauthorized)?;
    let decoded = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::Unauthorized)?;
    let event = Event::from_json(decoded).map_err(|_| ApiError::Unauthorized)?;

    let now = Instant::now();
    let mut used = state
        .used_auth_events
        .lock()
        .map_err(|_| ApiError::Internal)?;
    used.retain(|_, used_at| now.duration_since(*used_at) <= REPLAY_WINDOW);
    if used.insert(event.id, now).is_some() {
        return Err(ApiError::Replay);
    }
    Ok(())
}

fn ensure_empty_json_body(body: &[u8]) -> Result<(), ApiError> {
    if body.is_empty() {
        return Ok(());
    }
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| ApiError::BadRequest("invalid JSON body"))?;
    if value == serde_json::json!({}) {
        Ok(())
    } else {
        Err(ApiError::BadRequest("expected an empty JSON object"))
    }
}

fn parse_device_npub(value: &str) -> Result<String, ApiError> {
    let key = PublicKey::from_bech32(value)
        .map_err(|_| ApiError::BadRequest("npub must be a full NIP-19 public key"))?;
    let canonical = key
        .to_bech32()
        .expect("PublicKey NIP-19 encoding is infallible");
    if value != canonical {
        return Err(ApiError::BadRequest(
            "npub must be a full canonical NIP-19 public key",
        ));
    }
    Ok(canonical)
}

impl Nvpn {
    async fn run(&self, args: &[&str]) -> Result<Vec<u8>, ApiError> {
        let _guard = self.command_lock.lock().await;
        self.run_locked(args).await
    }

    async fn add_device_and_reload(&self, npub: &str) -> Result<(), ApiError> {
        let _guard = self.command_lock.lock().await;
        let config = self.config.to_string_lossy();
        self.run_locked(&[
            "add-device",
            "--config",
            &config,
            "--device",
            npub,
            "--publish",
        ])
        .await?;
        self.run_locked(&["reload", "--config", &config]).await?;
        Ok(())
    }

    async fn run_locked(&self, args: &[&str]) -> Result<Vec<u8>, ApiError> {
        let mut command = Command::new(self.bin.as_ref());
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().map_err(|_| ApiError::NvpnUnavailable)?;
        let output = timeout(self.command_timeout, child.wait_with_output())
            .await
            .map_err(|_| ApiError::NvpnTimeout)?
            .map_err(|_| ApiError::NvpnUnavailable)?;
        if !output.status.success() {
            return Err(ApiError::NvpnUnavailable);
        }
        Ok(output.stdout)
    }
}

#[derive(Debug, Deserialize)]
struct NvpnStatus {
    daemon: NvpnDaemon,
}

#[derive(Debug, Deserialize)]
struct NvpnDaemon {
    state: Option<NvpnDaemonState>,
}

#[derive(Debug, Deserialize)]
struct NvpnDaemonState {
    peers: Vec<NvpnPeer>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct NvpnPeer {
    #[serde(default)]
    fips_endpoint_npub: String,
    tunnel_ip: String,
    reachable: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct StatusResponse {
    known_clients: usize,
    connected_clients: usize,
    peers: Vec<NvpnPeer>,
}

fn parse_status(output: &[u8]) -> Result<StatusResponse, ApiError> {
    let status: NvpnStatus =
        serde_json::from_slice(output).map_err(|_| ApiError::NvpnUnavailable)?;
    let peers = status.daemon.state.ok_or(ApiError::NvpnUnavailable)?.peers;
    Ok(StatusResponse {
        known_clients: peers.len(),
        connected_clients: peers.iter().filter(|peer| peer.reachable).count(),
        peers,
    })
}

#[derive(Debug, Serialize)]
struct InviteResponse {
    invite: String,
}

fn extract_invite(output: &[u8]) -> Result<String, ApiError> {
    let output = std::str::from_utf8(output).map_err(|_| ApiError::NvpnUnavailable)?;
    output
        .split_ascii_whitespace()
        .find(|part| part.starts_with("nvpn://invite/") && part.len() > "nvpn://invite/".len())
        .map(ToOwned::to_owned)
        .ok_or(ApiError::NvpnUnavailable)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceRequest {
    npub: String,
}

#[derive(Debug, Serialize)]
struct DeviceResponse {
    npub: String,
    added: bool,
}

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    Forbidden,
    BadRequest(&'static str),
    NvpnUnavailable,
    NvpnTimeout,
    Replay,
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "authentication failed"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "pubkey is not allowed"),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::NvpnUnavailable => (StatusCode::BAD_GATEWAY, "nVPN operation failed"),
            Self::NvpnTimeout => (StatusCode::GATEWAY_TIMEOUT, "nVPN operation timed out"),
            Self::Replay => (StatusCode::CONFLICT, "authorization event was already used"),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use nostr::{
        key::{Keys, SecretKey},
        nips::nip98::HttpData,
    };
    use tower::ServiceExt;

    const HEX_KEY: &str = "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4";

    fn test_state() -> AppState {
        let allowed_pubkeys = parse_allowlist(HEX_KEY).unwrap();
        Config {
            listen_addr: SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)),
            allowed_pubkeys,
            public_base: "https://admin.example.com".to_string(),
            nvpn_bin: PathBuf::from("does-not-run-in-these-tests"),
            nvpn_config: PathBuf::from(DEFAULT_NVPN_CONFIG),
        }
        .into_state()
    }

    #[test]
    fn allowlist_accepts_hex_and_npub() {
        let key = PublicKey::parse(HEX_KEY).unwrap();
        let npub = key.to_bech32().unwrap();
        let parsed = parse_allowlist(&format!("{HEX_KEY},{npub}")).unwrap();
        assert_eq!(parsed, HashSet::from([key]));
    }

    #[test]
    fn allowlist_rejects_nostr_uri_and_empty_entries() {
        assert!(parse_allowlist(&format!("nostr:{HEX_KEY}")).is_err());
        assert!(parse_allowlist(&format!("{HEX_KEY},")).is_err());
    }

    #[test]
    fn device_requires_a_canonical_full_npub() {
        let key = PublicKey::parse(HEX_KEY).unwrap();
        let npub = key.to_bech32().unwrap();
        assert_eq!(parse_device_npub(&npub).unwrap(), npub);
        assert!(parse_device_npub(HEX_KEY).is_err());
        assert!(parse_device_npub("npub1short").is_err());
    }

    #[test]
    fn public_url_defaults_only_outside_production() {
        assert_eq!(
            parse_public_base(None, 4567, false).unwrap(),
            "http://localhost:4567"
        );
        assert!(parse_public_base(None, 4567, true).is_err());
        assert_eq!(
            parse_public_base(Some("https://example.com/admin/"), 4567, true).unwrap(),
            "https://example.com/admin"
        );
        assert!(parse_public_base(Some("https://user@example.com"), 4567, true).is_err());
    }

    #[test]
    fn status_uses_daemon_state_peers_and_reachability() {
        let response = parse_status(
            br#"{
                "daemon": {
                    "state": {
                        "peers": [
                            {
                                "fips_endpoint_npub": "npub1first",
                                "tunnel_ip": "10.44.0.2/32",
                                "reachable": true,
                                "participant_pubkey": "not-exposed"
                            },
                            {
                                "fips_endpoint_npub": "npub1second",
                                "tunnel_ip": "10.44.0.3/32",
                                "reachable": false
                            }
                        ]
                    }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(response.known_clients, 2);
        assert_eq!(response.connected_clients, 1);
        assert_eq!(response.peers[0].tunnel_ip, "10.44.0.2/32");
    }

    #[test]
    fn invite_extraction_returns_only_the_invite_token() {
        assert_eq!(
            extract_invite(b"notice\nnvpn://invite/abc123\n").unwrap(),
            "nvpn://invite/abc123"
        );
        assert!(extract_invite(b"invite unavailable").is_err());
    }

    #[tokio::test]
    async fn health_is_public_and_protected_route_requires_auth() {
        let app = router(test_state());
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

    /// The web build of the admin client sends a NIP-98 `Authorization` header,
    /// which makes every request non-simple. Without a preflight answer the
    /// browser never issues the real request at all.
    #[tokio::test]
    async fn nip98_requests_are_preflighted_for_any_origin() {
        let app = router(test_state());

        for (path, method) in [("/v1/status", "GET"), ("/v1/devices", "POST")] {
            let preflight = app
                .clone()
                .oneshot(
                    Request::options(path)
                        .header("origin", "https://operator.example")
                        .header("access-control-request-method", method)
                        .header("access-control-request-headers", "authorization")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(preflight.status(), StatusCode::OK, "preflight for {path}");
            let headers = preflight.headers();
            assert_eq!(
                headers.get("access-control-allow-origin").unwrap(),
                "*",
                "any origin may reach {path}"
            );
            assert!(
                headers
                    .get("access-control-allow-headers")
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_ascii_lowercase()
                    .contains("authorization")
            );
            // `allow_credentials` is incompatible with a wildcard origin, and
            // unnecessary: authority comes from the signed header, not a cookie.
            assert!(headers.get("access-control-allow-credentials").is_none());
        }

        // CORS opens the door; it does not unlock it.
        let unauthenticated = app
            .oneshot(
                Request::get("/v1/status")
                    .header("origin", "https://operator.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            unauthenticated
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "*"
        );
    }

    #[tokio::test]
    async fn standard_nip98_header_is_checked_against_the_exact_external_url() {
        let secret =
            SecretKey::parse("0000000000000000000000000000000000000000000000000000000000000001")
                .unwrap();
        let keys = Keys::new(secret);
        let mut state = test_state();
        state.allowed_pubkeys = Arc::new(HashSet::from([keys.public_key()]));
        let auth = HttpData::new(
            Url::parse("https://admin.example.com/v1/status").unwrap(),
            HttpMethod::GET,
        )
        .to_authorization(&keys)
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth.parse().unwrap());

        assert!(authorize(&state, &headers, "/v1/status", HttpMethod::GET, None, false).is_ok());
        assert!(authorize(&state, &headers, "/health", HttpMethod::GET, None, false).is_err());
    }

    #[tokio::test]
    async fn mutation_authorization_event_cannot_be_replayed() {
        use std::str::FromStr;

        use nostr::nips::nip98::Sha256Hash;

        let secret =
            SecretKey::parse("0000000000000000000000000000000000000000000000000000000000000001")
                .unwrap();
        let keys = Keys::new(secret);
        let mut state = test_state();
        state.allowed_pubkeys = Arc::new(HashSet::from([keys.public_key()]));
        let body = b"{}";
        let auth = HttpData::new(
            Url::parse("https://admin.example.com/v1/invites").unwrap(),
            HttpMethod::POST,
        )
        .payload(
            Sha256Hash::from_str(
                "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            )
            .unwrap(),
        )
        .to_authorization(&keys)
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth.parse().unwrap());

        assert!(
            authorize(
                &state,
                &headers,
                "/v1/invites",
                HttpMethod::POST,
                Some(body),
                true
            )
            .is_ok()
        );
        assert!(matches!(
            authorize(
                &state,
                &headers,
                "/v1/invites",
                HttpMethod::POST,
                Some(body),
                true
            ),
            Err(ApiError::Replay)
        ));
    }

    #[tokio::test]
    async fn request_body_is_bounded() {
        let response = router(test_state())
            .oneshot(
                Request::post("/v1/devices")
                    .body(Body::from(vec![b'x'; MAX_BODY_BYTES + 1]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
