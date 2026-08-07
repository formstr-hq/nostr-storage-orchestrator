//! Business logic for the Nostr Storage Orchestrator admin client.
//!
//! This crate performs no I/O. It owns every security-relevant decision — key
//! generation, NIP-49 encryption and decryption, NIP-98 authorization signing,
//! host URL normalization, and response parsing — so that the Tauri and
//! WebAssembly bindings are reduced to transport plus marshalling.
//!
//! All cryptography comes from maintained libraries: `nostr` (pinned 0.45) for
//! key handling, NIP-49, Bech32 and event signing, and `bitcoin_hashes` (the
//! implementation `nostr` itself uses) for payload digests.

use std::fmt;

use bitcoin_hashes::sha256;
use nostr::key::{Keys, PublicKey, SecretKey};
use nostr::nips::nip19::{FromBech32, ToBech32};
use nostr::nips::nip49::{EncryptedSecretKey, KeySecurity};
use nostr::nips::nip98::{HttpData, HttpMethod, Sha256Hash};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;
use zeroize::Zeroizing;

pub const STATUS_PATH: &str = "/v1/status";
pub const INVITES_PATH: &str = "/v1/invites";
pub const DEVICES_PATH: &str = "/v1/devices";
// Not DELETE: nostr::nips::nip98::HttpMethod only covers GET/POST/PUT/PATCH,
// so this mutation is POST too, same as DEVICES_PATH and INVITES_PATH.
pub const DEVICES_REMOVE_PATH: &str = "/v1/devices/remove";

/// scrypt cost ceiling for NIP-49, about 64 MiB. Keys this crate generates use
/// it, and imported credentials may not exceed it, so an untrusted `ncryptsec`
/// cannot exhaust a mobile process during unlock.
pub const NIP49_LOG_N: u8 = 16;

/// An operator-facing error. The message is shown verbatim in the UI, so it
/// never carries key material or internal detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError(String);

impl CoreError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }

    pub fn into_message(self) -> String {
        self.0
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CoreError {}

impl From<CoreError> for String {
    fn from(error: CoreError) -> Self {
        error.0
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

/// The HTTP methods this client issues. Kept separate from `nip98::HttpMethod`
/// so bindings can marshal a request without depending on `nostr`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }

    fn nip98(self) -> HttpMethod {
        match self {
            Method::Get => HttpMethod::GET,
            Method::Post => HttpMethod::POST,
        }
    }
}

/// A request that has already been signed. The caller's only remaining job is
/// to send it verbatim: changing the URL, method, or body invalidates the
/// NIP-98 authorization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedRequest {
    pub url: String,
    pub method: Method,
    pub authorization: String,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    pub ncryptsec: String,
    pub npub: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    pub host_url: String,
    pub npub: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub npub: String,
    pub tunnel_ip: Option<String>,
    pub connected: bool,
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub connected_count: usize,
    pub peers: Vec<Peer>,
}

// ---------------------------------------------------------------------------
// Host URLs
// ---------------------------------------------------------------------------

/// Parse and normalize a host base URL, rejecting anything that could redirect
/// a signed authorization somewhere unintended.
pub fn normalize_url(input: &str) -> Result<Url> {
    let trimmed = input.trim();
    let mut url =
        Url::parse(trimmed).map_err(|_| CoreError::new("Enter a valid absolute HTTPS URL"))?;

    if url.scheme() != "https" {
        return Err(CoreError::new("Host URLs must use HTTPS"));
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::new("Host URL must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(CoreError::new(
            "Host URL must not contain a query or fragment",
        ));
    }

    let normalized_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if normalized_path.is_empty() {
        "/"
    } else {
        &normalized_path
    });
    Ok(url)
}

pub fn display_base_url(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// Normalize a host URL and return its canonical string form.
pub fn normalize_host_url(input: &str) -> Result<String> {
    normalize_url(input).map(|url| display_base_url(&url))
}

fn endpoint(base: &Url, path: &str) -> Result<Url> {
    let base = format!("{}/", display_base_url(base));
    Url::parse(&base)
        .and_then(|url| url.join(path.trim_start_matches('/')))
        .map_err(|_| CoreError::new("Could not construct the host API URL"))
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

fn encrypt_secret_key(secret_key: &SecretKey, passphrase: &str) -> Result<GeneratedKey> {
    let keys = Keys::new(secret_key.clone());
    let encrypted =
        EncryptedSecretKey::new(secret_key, passphrase, NIP49_LOG_N, KeySecurity::Unknown)
            .map_err(|_| CoreError::new("Could not encrypt the key"))?;
    let ncryptsec = encrypted
        .to_bech32()
        .map_err(|_| CoreError::new("Could not encode the encrypted key"))?;
    let npub = encode_npub(&keys.public_key())?;
    Ok(GeneratedKey { ncryptsec, npub })
}

fn encode_npub(public_key: &PublicKey) -> Result<String> {
    public_key
        .to_bech32()
        .map_err(|_| CoreError::new("Could not encode the public key"))
}

/// Generate a fresh Nostr key and return it NIP-49 encrypted. The plaintext
/// secret key never leaves this function.
///
/// This is CPU-bound (scrypt at `NIP49_LOG_N`); callers must run it off the UI
/// thread.
pub fn generate_key(passphrase: &str) -> Result<GeneratedKey> {
    let passphrase = Zeroizing::new(passphrase.to_owned());
    if passphrase.is_empty() {
        return Err(CoreError::new("Passphrase cannot be empty"));
    }
    encrypt_secret_key(&SecretKey::generate(), &passphrase)
}

/// Encrypt an existing plaintext `nsec` under a passphrase, returning the
/// NIP-49 credential and its npub.
///
/// The `nsec` is accepted once, in memory, and is zeroized on return; only the
/// resulting `ncryptsec` is ever suitable for storage. Like [`generate_key`],
/// this is CPU-bound and must run off the UI thread.
pub fn encrypt_nsec(nsec: &str, passphrase: &str) -> Result<GeneratedKey> {
    let nsec = Zeroizing::new(nsec.trim().to_owned());
    let passphrase = Zeroizing::new(passphrase.to_owned());
    if passphrase.is_empty() {
        return Err(CoreError::new("Passphrase cannot be empty"));
    }
    if !nsec.starts_with("nsec1") {
        return Err(CoreError::new(
            "Enter a secret key in nsec1... form, not hex or an npub",
        ));
    }
    let secret_key = SecretKey::from_bech32(nsec.as_str())
        .map_err(|_| CoreError::new("Enter a valid nsec secret key"))?;
    encrypt_secret_key(&secret_key, &passphrase)
}

/// Decrypt a NIP-49 credential into usable keys.
///
/// Rejects credentials above [`NIP49_LOG_N`] so an untrusted high-cost
/// `ncryptsec` cannot exhaust the process. CPU-bound; run it off the UI thread.
pub fn unlock_keys(ncryptsec: &str, passphrase: &str) -> Result<Keys> {
    let passphrase = Zeroizing::new(passphrase.to_owned());
    let encrypted = EncryptedSecretKey::from_bech32(ncryptsec.trim())
        .map_err(|_| CoreError::new("Invalid ncryptsec credential"))?;
    let secret_key = encrypted
        .decrypt_with_max_log_n(&passphrase, NIP49_LOG_N)
        .map_err(|_| CoreError::new("Incorrect passphrase or unsupported ncryptsec cost"))?;
    Ok(Keys::new(secret_key))
}

/// Validate a device public key and return its canonical npub encoding.
pub fn canonical_npub(input: &str) -> Result<String> {
    let candidate = input.trim();
    if !candidate.starts_with("npub1") {
        return Err(CoreError::new(
            "Device must be an npub, not a hex public key",
        ));
    }
    let public_key =
        PublicKey::from_bech32(candidate).map_err(|_| CoreError::new("Enter a valid Nostr npub"))?;
    encode_npub(&public_key)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// An unlocked host: a normalized base URL bound to the operator's keys.
///
/// Holding a `Session` is what "unlocked" means. Dropping every clone is what
/// "locked" means — the decrypted key exists nowhere else.
#[derive(Clone)]
pub struct Session {
    host_url: Url,
    keys: Keys,
}

impl Session {
    /// Unlock `ncryptsec` with `passphrase` and bind it to `host_url`.
    pub fn open(host_url: &str, ncryptsec: &str, passphrase: &str) -> Result<Self> {
        let host_url = normalize_url(host_url)?;
        let keys = unlock_keys(ncryptsec, passphrase)?;
        Ok(Self { host_url, keys })
    }

    pub fn host_url(&self) -> String {
        display_base_url(&self.host_url)
    }

    pub fn npub(&self) -> Result<String> {
        encode_npub(&self.keys.public_key())
    }

    pub fn unlock_result(&self) -> Result<UnlockResult> {
        Ok(UnlockResult {
            host_url: self.host_url(),
            npub: self.npub()?,
        })
    }

    async fn sign(&self, path: &str, method: Method, body: Option<Vec<u8>>) -> Result<SignedRequest> {
        let url = endpoint(&self.host_url, path)?;
        let mut data = HttpData::new(url.clone(), method.nip98());
        if let Some(body) = body.as_deref() {
            let digest = sha256::Hash::hash(body);
            data = data.payload(Sha256Hash::from_byte_array(digest.to_byte_array()));
        }
        let authorization = data
            .to_authorization(&self.keys)
            .await
            .map_err(|_| CoreError::new("Could not sign the authorization request"))?;
        Ok(SignedRequest {
            url: url.to_string(),
            method,
            authorization,
            body,
        })
    }

    pub async fn status_request(&self) -> Result<SignedRequest> {
        self.sign(STATUS_PATH, Method::Get, None).await
    }

    pub async fn invite_request(&self) -> Result<SignedRequest> {
        self.sign(INVITES_PATH, Method::Post, Some(b"{}".to_vec()))
            .await
    }

    /// Sign a device approval. `npub` is validated and canonicalized first, so
    /// the signed payload hash always covers the exact bytes that are sent.
    pub async fn device_request(&self, npub: &str) -> Result<SignedRequest> {
        let npub = canonical_npub(npub)?;
        let body = serde_json::to_vec(&json!({ "npub": npub }))
            .map_err(|_| CoreError::new("Could not prepare the device request"))?;
        self.sign(DEVICES_PATH, Method::Post, Some(body)).await
    }

    /// Sign a device removal. Same body shape and validation as
    /// [`Session::device_request`]; only the path differs.
    pub async fn device_removal_request(&self, npub: &str) -> Result<SignedRequest> {
        let npub = canonical_npub(npub)?;
        let body = serde_json::to_vec(&json!({ "npub": npub }))
            .map_err(|_| CoreError::new("Could not prepare the device request"))?;
        self.sign(DEVICES_REMOVE_PATH, Method::Post, Some(body))
            .await
    }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/// Turn a raw HTTP response into JSON, surfacing the host's own error message
/// when the status is not successful.
fn interpret(status: u16, body: &[u8]) -> Result<Value> {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    if (200..300).contains(&status) {
        return parsed.ok_or_else(|| CoreError::new("Host returned an invalid JSON response"));
    }

    let message = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("Host request failed with HTTP {status}"));
    Err(CoreError::new(message))
}

fn peer_from_value(value: &Value) -> Option<Peer> {
    let npub = value
        .get("fips_endpoint_npub")
        .and_then(Value::as_str)?
        .to_string();
    let tunnel_ip = value
        .get("tunnel_ip")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let connected = value
        .get("reachable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(Peer {
        npub,
        tunnel_ip,
        connected,
        last_seen: None,
    })
}

pub fn status_response(status: u16, body: &[u8]) -> Result<HostStatus> {
    let value = interpret(status, body)?;
    let peers_value = value
        .get("peers")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::new("Host status did not include a peer list"))?;
    let peers: Vec<Peer> = peers_value.iter().filter_map(peer_from_value).collect();
    let connected_count = value
        .get("connected_clients")
        .and_then(Value::as_u64)
        .map(|count| count as usize)
        .ok_or_else(|| CoreError::new("Host status did not include connected_clients"))?;
    Ok(HostStatus {
        connected_count,
        peers,
    })
}

pub fn invite_response(status: u16, body: &[u8]) -> Result<String> {
    let value = interpret(status, body)?;
    value
        .get("invite")
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| CoreError::new("Host response did not include an invite"))
}

/// Device approval carries no payload worth reading, so any 2xx is success —
/// including an empty body a JSON parse would reject.
pub fn device_response(status: u16, body: &[u8]) -> Result<()> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    interpret(status, body).map(|_| ())
}

/// Error message for a transport-level failure, so every binding reports
/// unreachable hosts identically.
pub fn transport_error() -> CoreError {
    CoreError::new("Could not reach the host")
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::nips::nip98::verify_auth_header;
    use nostr::types::Timestamp;

    const PASSPHRASE: &str = "correct horse battery staple";

    fn session() -> Session {
        let generated = generate_key(PASSPHRASE).unwrap();
        Session::open("https://storage.example", &generated.ncryptsec, PASSPHRASE).unwrap()
    }

    #[test]
    fn nip49_roundtrip_uses_crate_implementation() {
        let secret = SecretKey::generate();
        let encrypted =
            EncryptedSecretKey::new(&secret, PASSPHRASE, NIP49_LOG_N, KeySecurity::Unknown)
                .unwrap();
        let encoded = encrypted.to_bech32().unwrap();
        let decrypted = EncryptedSecretKey::from_bech32(&encoded)
            .unwrap()
            .decrypt_with_max_log_n(PASSPHRASE, NIP49_LOG_N)
            .unwrap();

        assert_eq!(secret, decrypted);
        assert!(encoded.starts_with("ncryptsec1"));
    }

    #[test]
    fn generated_key_unlocks_with_its_passphrase() {
        let generated = generate_key(PASSPHRASE).unwrap();
        assert!(generated.ncryptsec.starts_with("ncryptsec1"));
        assert!(generated.npub.starts_with("npub1"));

        let keys = unlock_keys(&generated.ncryptsec, PASSPHRASE).unwrap();
        assert_eq!(keys.public_key().to_bech32().unwrap(), generated.npub);
        assert!(unlock_keys(&generated.ncryptsec, "wrong").is_err());
        assert!(generate_key("").is_err());
    }

    #[test]
    fn imported_nsec_encrypts_to_a_credential_for_the_same_key() {
        let secret = SecretKey::generate();
        let nsec = secret.to_bech32().unwrap();
        let expected_npub = Keys::new(secret).public_key().to_bech32().unwrap();

        let imported = encrypt_nsec(&nsec, PASSPHRASE).unwrap();
        assert_eq!(imported.npub, expected_npub);
        assert!(imported.ncryptsec.starts_with("ncryptsec1"));

        let keys = unlock_keys(&imported.ncryptsec, PASSPHRASE).unwrap();
        assert_eq!(keys.public_key().to_bech32().unwrap(), expected_npub);
    }

    #[test]
    fn imported_nsec_rejects_non_nsec_input() {
        let secret = SecretKey::generate();
        assert!(encrypt_nsec(&secret.to_secret_hex(), PASSPHRASE).is_err());
        assert!(encrypt_nsec(&Keys::new(secret).public_key().to_bech32().unwrap(), PASSPHRASE).is_err());
        assert!(encrypt_nsec("nsec1notvalid", PASSPHRASE).is_err());
        assert!(encrypt_nsec("nsec1anything", "").is_err());
    }

    #[tokio::test]
    async fn nip98_header_interoperates_with_nostr_verifier_and_payload() {
        let keys = Keys::generate();
        let url = Url::parse("https://storage.example/v1/devices").unwrap();
        let body = br#"{"npub":"npub1example"}"#;
        let digest = sha256::Hash::hash(body);
        let data = HttpData::new(url.clone(), HttpMethod::POST)
            .payload(Sha256Hash::from_byte_array(digest.to_byte_array()));
        let auth = data.to_authorization(&keys).await.unwrap();

        let verified =
            verify_auth_header(&auth, &url, HttpMethod::POST, Timestamp::now(), Some(body))
                .unwrap();
        assert_eq!(verified, keys.public_key());
        assert!(
            verify_auth_header(&auth, &url, HttpMethod::POST, Timestamp::now(), Some(b"{}"))
                .is_err()
        );
    }

    #[tokio::test]
    async fn signed_requests_verify_against_their_own_url_and_body() {
        let session = session();
        let npub = session.npub().unwrap();
        let public_key = PublicKey::from_bech32(&npub).unwrap();

        let status = session.status_request().await.unwrap();
        assert_eq!(status.url, "https://storage.example/v1/status");
        assert_eq!(status.method, Method::Get);
        assert!(status.body.is_none());
        assert_eq!(
            verify_auth_header(
                &status.authorization,
                &Url::parse(&status.url).unwrap(),
                HttpMethod::GET,
                Timestamp::now(),
                None
            )
            .unwrap(),
            public_key
        );

        let device = session.device_request(&npub).await.unwrap();
        assert_eq!(device.url, "https://storage.example/v1/devices");
        let body = device.body.clone().unwrap();
        assert_eq!(
            verify_auth_header(
                &device.authorization,
                &Url::parse(&device.url).unwrap(),
                HttpMethod::POST,
                Timestamp::now(),
                Some(&body)
            )
            .unwrap(),
            public_key
        );
        // A different body must not validate against the same header.
        assert!(verify_auth_header(
            &device.authorization,
            &Url::parse(&device.url).unwrap(),
            HttpMethod::POST,
            Timestamp::now(),
            Some(b"{}")
        )
        .is_err());
    }

    #[tokio::test]
    async fn device_request_canonicalizes_and_rejects_bad_npubs() {
        let session = session();
        let npub = session.npub().unwrap();
        let request = session.device_request(&format!("  {npub}  ")).await.unwrap();
        let body: Value = serde_json::from_slice(&request.body.unwrap()).unwrap();
        assert_eq!(body["npub"], Value::String(npub));

        assert!(session.device_request("deadbeef").await.is_err());
        assert!(session.device_request("npub1invalid").await.is_err());
    }

    #[tokio::test]
    async fn device_removal_request_targets_the_remove_path() {
        let session = session();
        let npub = session.npub().unwrap();
        let request = session.device_removal_request(&npub).await.unwrap();
        assert_eq!(request.url, "https://storage.example/v1/devices/remove");
        let body: Value = serde_json::from_slice(&request.body.unwrap()).unwrap();
        assert_eq!(body["npub"], Value::String(npub));

        assert!(session.device_removal_request("npub1invalid").await.is_err());
    }

    #[test]
    fn normalizes_https_host_urls() {
        assert_eq!(
            normalize_host_url("  https://storage.example///  ").unwrap(),
            "https://storage.example"
        );
        assert_eq!(
            normalize_host_url("https://storage.example/control/").unwrap(),
            "https://storage.example/control"
        );
        assert!(normalize_host_url("http://storage.example").is_err());
        assert!(normalize_host_url("https://user:secret@storage.example").is_err());
        assert!(normalize_host_url("https://storage.example?debug=1").is_err());
    }

    #[test]
    fn endpoints_are_appended_to_a_base_path() {
        let base = normalize_url("https://storage.example/control").unwrap();
        assert_eq!(
            endpoint(&base, STATUS_PATH).unwrap().as_str(),
            "https://storage.example/control/v1/status"
        );
    }

    #[test]
    fn parses_status_payloads() {
        let body = br#"{"connected_clients":2,"peers":[
            {"fips_endpoint_npub":"npub1a","tunnel_ip":"10.0.0.2","reachable":true},
            {"fips_endpoint_npub":"npub1b","reachable":false},
            {"tunnel_ip":"10.0.0.9"}
        ]}"#;
        let status = status_response(200, body).unwrap();
        assert_eq!(status.connected_count, 2);
        // The third entry has no npub and is dropped rather than guessed at.
        assert_eq!(status.peers.len(), 2);
        assert_eq!(status.peers[0].tunnel_ip.as_deref(), Some("10.0.0.2"));
        assert!(status.peers[0].connected);
        assert!(status.peers[1].tunnel_ip.is_none());
        assert!(!status.peers[1].connected);

        assert!(status_response(200, br#"{"connected_clients":1}"#).is_err());
        assert!(status_response(200, br#"{"peers":[]}"#).is_err());
    }

    #[test]
    fn surfaces_host_error_messages() {
        assert_eq!(
            status_response(403, br#"{"error":"forbidden"}"#)
                .unwrap_err()
                .message(),
            "forbidden"
        );
        assert_eq!(
            invite_response(500, b"not json").unwrap_err().message(),
            "Host request failed with HTTP 500"
        );
        assert_eq!(
            invite_response(200, br#"{"invite":"nvpn-invite"}"#).unwrap(),
            "nvpn-invite"
        );
        assert!(invite_response(200, br#"{}"#).is_err());
        assert!(device_response(204, b"").is_ok());
        assert_eq!(
            device_response(401, br#"{"message":"unauthorized"}"#)
                .unwrap_err()
                .message(),
            "unauthorized"
        );
    }
}
