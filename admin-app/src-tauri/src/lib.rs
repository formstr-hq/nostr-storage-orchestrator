use std::sync::Mutex;

use bitcoin_hashes::sha256;
use nostr::key::{Keys, PublicKey, SecretKey};
use nostr::nips::nip19::{FromBech32, ToBech32};
use nostr::nips::nip49::{EncryptedSecretKey, KeySecurity};
use nostr::nips::nip98::{HttpData, HttpMethod, Sha256Hash};
use reqwest::redirect::Policy;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use url::Url;
use zeroize::Zeroizing;

const STATUS_PATH: &str = "/v1/status";
const INVITES_PATH: &str = "/v1/invites";
const DEVICES_PATH: &str = "/v1/devices";
const NIP49_LOG_N: u8 = 16;

struct ActiveHost {
    host_url: Url,
    keys: Keys,
}

struct AppState {
    active: Mutex<Option<ActiveHost>>,
    client: reqwest::Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnlockResult {
    host_url: String,
    npub: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedKey {
    ncryptsec: String,
    npub: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Peer {
    npub: String,
    tunnel_ip: Option<String>,
    connected: bool,
    last_seen: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    connected_count: usize,
    peers: Vec<Peer>,
}

fn normalize_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    let mut url =
        Url::parse(trimmed).map_err(|_| "Enter a valid absolute HTTPS URL".to_string())?;

    if url.scheme() != "https" {
        return Err("Host URLs must use HTTPS".to_string());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Host URL must not contain credentials".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Host URL must not contain a query or fragment".to_string());
    }

    let normalized_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if normalized_path.is_empty() {
        "/"
    } else {
        &normalized_path
    });
    Ok(url)
}

fn display_base_url(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

fn endpoint(base: &Url, path: &str) -> Result<Url, String> {
    let base = format!("{}/", display_base_url(base));
    Url::parse(&base)
        .and_then(|url| url.join(path.trim_start_matches('/')))
        .map_err(|_| "Could not construct the host API URL".to_string())
}

fn active_host(state: &AppState) -> Result<(Url, Keys), String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "Key state is unavailable".to_string())?;
    let host = active
        .as_ref()
        .ok_or_else(|| "Host is locked. Unlock it to continue".to_string())?;
    Ok((host.host_url.clone(), host.keys.clone()))
}

async fn authorization(
    keys: &Keys,
    url: &Url,
    method: HttpMethod,
    body: Option<&[u8]>,
) -> Result<String, String> {
    let mut data = HttpData::new(url.clone(), method);
    if let Some(body) = body {
        let digest = sha256::Hash::hash(body);
        data = data.payload(Sha256Hash::from_byte_array(digest.to_byte_array()));
    }
    data.to_authorization(keys)
        .await
        .map_err(|_| "Could not sign the authorization request".to_string())
}

async fn success_response(response: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let message = response
        .json::<Value>()
        .await
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("Host request failed with HTTP {status}"));
    Err(message)
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    success_response(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|_| "Host returned an invalid JSON response".to_string())
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

fn parse_status(value: Value) -> Result<HostStatus, String> {
    let peers_value = value
        .get("peers")
        .and_then(Value::as_array)
        .ok_or_else(|| "Host status did not include a peer list".to_string())?;
    let peers: Vec<Peer> = peers_value.iter().filter_map(peer_from_value).collect();
    let connected_count = value
        .get("connected_clients")
        .and_then(Value::as_u64)
        .map(|count| count as usize)
        .ok_or_else(|| "Host status did not include connected_clients".to_string())?;
    Ok(HostStatus {
        connected_count,
        peers,
    })
}

#[tauri::command]
fn normalize_host_url(url: String) -> Result<String, String> {
    normalize_url(&url).map(|url| display_base_url(&url))
}

#[tauri::command]
async fn generate_host_key(passphrase: String) -> Result<GeneratedKey, String> {
    tauri::async_runtime::spawn_blocking(move || generate_host_key_blocking(passphrase))
        .await
        .map_err(|_| "Key generation task failed".to_string())?
}

fn generate_host_key_blocking(passphrase: String) -> Result<GeneratedKey, String> {
    let passphrase = Zeroizing::new(passphrase);
    if passphrase.is_empty() {
        return Err("Passphrase cannot be empty".to_string());
    }
    let secret_key = SecretKey::generate();
    let keys = Keys::new(secret_key.clone());
    let encrypted =
        EncryptedSecretKey::new(&secret_key, &passphrase, NIP49_LOG_N, KeySecurity::Unknown)
            .map_err(|_| "Could not encrypt the new key".to_string())?;
    let ncryptsec = encrypted
        .to_bech32()
        .map_err(|_| "Could not encode the encrypted key".to_string())?;
    let npub = keys
        .public_key()
        .to_bech32()
        .map_err(|_| "Could not encode the public key".to_string())?;
    Ok(GeneratedKey { ncryptsec, npub })
}

#[tauri::command]
async fn unlock_host(
    host_url: String,
    ncryptsec: String,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<UnlockResult, String> {
    let host_url = normalize_url(&host_url)?;
    let secret_key = tauri::async_runtime::spawn_blocking(move || {
        let passphrase = Zeroizing::new(passphrase);
        let encrypted = EncryptedSecretKey::from_bech32(ncryptsec.trim())
            .map_err(|_| "Invalid ncryptsec credential".to_string())?;
        encrypted
            .decrypt_with_max_log_n(&passphrase, NIP49_LOG_N)
            .map_err(|_| "Incorrect passphrase or unsupported ncryptsec cost".to_string())
    })
    .await
    .map_err(|_| "Key unlock task failed".to_string())??;
    let keys = Keys::new(secret_key);
    let npub = keys
        .public_key()
        .to_bech32()
        .map_err(|_| "Could not encode the public key".to_string())?;
    let normalized = display_base_url(&host_url);

    let mut active = state
        .active
        .lock()
        .map_err(|_| "Key state is unavailable".to_string())?;
    *active = Some(ActiveHost { host_url, keys });
    Ok(UnlockResult {
        host_url: normalized,
        npub,
    })
}

#[tauri::command]
fn lock_host(state: State<'_, AppState>) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Key state is unavailable".to_string())?;
    *active = None;
    Ok(())
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> Result<HostStatus, String> {
    let (host_url, keys) = active_host(&state)?;
    let url = endpoint(&host_url, STATUS_PATH)?;
    let auth = authorization(&keys, &url, HttpMethod::GET, None).await?;
    drop(keys);
    let response = state
        .client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, auth)
        .send()
        .await
        .map_err(|_| "Could not reach the host".to_string())?;
    parse_status(response_json(response).await?)
}

#[tauri::command]
async fn generate_invite(state: State<'_, AppState>) -> Result<String, String> {
    let (host_url, keys) = active_host(&state)?;
    let url = endpoint(&host_url, INVITES_PATH)?;
    let body = b"{}";
    let auth = authorization(&keys, &url, HttpMethod::POST, Some(body)).await?;
    drop(keys);
    let response = state
        .client
        .post(url)
        .header(reqwest::header::AUTHORIZATION, auth)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.as_slice().to_owned())
        .send()
        .await
        .map_err(|_| "Could not reach the host".to_string())?;
    let value = response_json(response).await?;
    value
        .get("invite")
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "Host response did not include an invite".to_string())
}

#[tauri::command]
async fn add_device(npub: String, state: State<'_, AppState>) -> Result<(), String> {
    let candidate = npub.trim();
    if !candidate.starts_with("npub1") {
        return Err("Device must be an npub, not a hex public key".to_string());
    }
    let public_key =
        PublicKey::from_bech32(candidate).map_err(|_| "Enter a valid Nostr npub".to_string())?;
    let canonical_npub = public_key
        .to_bech32()
        .map_err(|_| "Could not encode the device npub".to_string())?;

    let (host_url, keys) = active_host(&state)?;
    let url = endpoint(&host_url, DEVICES_PATH)?;
    let body = serde_json::to_vec(&json!({ "npub": canonical_npub }))
        .map_err(|_| "Could not prepare the device request".to_string())?;
    let auth = authorization(&keys, &url, HttpMethod::POST, Some(&body)).await?;
    drop(keys);
    let response = state
        .client
        .post(url)
        .header(reqwest::header::AUTHORIZATION, auth)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "Could not reach the host".to_string())?;
    success_response(response).await.map(|_| ())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("reqwest client configuration is valid");

    tauri::Builder::default()
        .manage(AppState {
            active: Mutex::new(None),
            client,
        })
        .invoke_handler(tauri::generate_handler![
            normalize_host_url,
            generate_host_key,
            unlock_host,
            lock_host,
            status,
            generate_invite,
            add_device
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::nips::nip98::verify_auth_header;
    use nostr::types::Timestamp;

    #[test]
    fn nip49_roundtrip_uses_crate_implementation() {
        let passphrase = "correct horse battery staple";
        let secret = SecretKey::generate();
        let encrypted =
            EncryptedSecretKey::new(&secret, passphrase, NIP49_LOG_N, KeySecurity::Unknown)
                .unwrap();
        let encoded = encrypted.to_bech32().unwrap();
        let decrypted = EncryptedSecretKey::from_bech32(&encoded)
            .unwrap()
            .decrypt_with_max_log_n(passphrase, NIP49_LOG_N)
            .unwrap();

        assert_eq!(secret, decrypted);
        assert!(encoded.starts_with("ncryptsec1"));
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

    #[test]
    fn normalizes_https_host_urls() {
        assert_eq!(
            display_base_url(&normalize_url("  https://storage.example///  ").unwrap()),
            "https://storage.example"
        );
        assert_eq!(
            display_base_url(&normalize_url("https://storage.example/control/").unwrap()),
            "https://storage.example/control"
        );
        assert!(normalize_url("http://storage.example").is_err());
        assert!(normalize_url("https://user:secret@storage.example").is_err());
        assert!(normalize_url("https://storage.example?debug=1").is_err());
    }
}
