use std::time::{Duration, Instant};

use axum::{
    body::Bytes,
    http::{HeaderMap, header::AUTHORIZATION},
};
use base64::{Engine, engine::general_purpose};
use nostr::{
    event::Event,
    nips::{
        nip19::ToBech32,
        nip98::{HttpMethod, verify_auth_header},
    },
    types::Timestamp,
};
use tracing::warn;
use url::Url;

use crate::{
    AppState,
    db_client::{MemberDb, MemberRole, MemberStatus, StorageDb, StorageLifecycle},
    error::ApiError,
};

const REPLAY_WINDOW: Duration = Duration::from_secs(90);

#[derive(Clone, Copy)]
pub enum Audience {
    Public,
    Mesh,
}

pub fn verify(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    method: HttpMethod,
    body: Option<&Bytes>,
    consume: bool,
    audience: Audience,
) -> Result<String, ApiError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(ApiError::unauthorized)?;
    let base = match audience {
        Audience::Public => &state.public_base,
        Audience::Mesh => &state.mesh_base,
    };
    let url = Url::parse(&format!("{base}{path}"))
        .map_err(|_| ApiError::internal("configured authentication URL is invalid"))?;
    let pubkey = verify_auth_header(
        auth_header,
        &url,
        method,
        Timestamp::now(),
        body.map(Bytes::as_ref),
    )
    .map_err(|error| {
        warn!(path, %error, "NIP-98 signature verification failed");
        ApiError::unauthorized()
    })?;
    if consume {
        consume_event(state, auth_header)?;
    }
    pubkey
        .to_bech32()
        .map_err(|_| ApiError::internal("could not encode signing npub"))
}

pub async fn active_member(state: &AppState, npub: &str) -> Result<MemberDb, ApiError> {
    match state.db.get_member(npub).await? {
        Some(member) if member.status == MemberStatus::Active => Ok(member),
        _ => Err(ApiError::forbidden("an active member is required")),
    }
}

pub async fn admin(state: &AppState, npub: &str) -> Result<MemberDb, ApiError> {
    let member = active_member(state, npub).await?;
    if member.role != MemberRole::Admin {
        return Err(ApiError::forbidden("an active administrator is required"));
    }
    Ok(member)
}

pub async fn linked_storage(state: &AppState, npub: &str) -> Result<StorageDb, ApiError> {
    match state.db.get_storage(npub).await? {
        Some(storage) if storage.lifecycle == StorageLifecycle::Linked => Ok(storage),
        Some(_) => Err(ApiError::forbidden("storage has been removed")),
        None => Err(ApiError::not_found("storage is not linked")),
    }
}

fn consume_event(state: &AppState, auth_header: &str) -> Result<(), ApiError> {
    let encoded = auth_header
        .strip_prefix("Nostr ")
        .ok_or_else(ApiError::unauthorized)?;
    let decoded = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::unauthorized())?;
    let event = Event::from_json(decoded).map_err(|_| ApiError::unauthorized())?;
    let now = Instant::now();
    let mut used = state
        .used_auth_events
        .lock()
        .map_err(|_| ApiError::internal("replay cache lock failed"))?;
    used.retain(|_, used_at| now.duration_since(*used_at) <= REPLAY_WINDOW);
    if used.insert(event.id, now).is_some() {
        return Err(ApiError::conflict("authorization event was already used"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        path::PathBuf,
        sync::{Arc, Mutex as StdMutex},
        time::Duration,
    };

    use ipnet::IpNet;
    use nostr::{
        key::{Keys, SecretKey},
        nips::nip98::HttpData,
    };
    use tokio::sync::Mutex;

    use super::*;
    use crate::{db_client::DbClient, nvpn::Nvpn};

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

    fn keys() -> Keys {
        Keys::new(
            SecretKey::parse("0000000000000000000000000000000000000000000000000000000000000001")
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn signature_is_bound_to_exact_external_url() {
        let keys = keys();
        let auth = HttpData::new(
            Url::parse("https://admin.example.com/v1/status").unwrap(),
            HttpMethod::GET,
        )
        .to_authorization(&keys)
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth.parse().unwrap());
        assert!(
            verify(
                &state(),
                &headers,
                "/v1/status",
                HttpMethod::GET,
                None,
                false,
                Audience::Public
            )
            .is_ok()
        );
        assert!(
            verify(
                &state(),
                &headers,
                "/health",
                HttpMethod::GET,
                None,
                false,
                Audience::Public
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn mutation_event_cannot_be_replayed() {
        use nostr::nips::nip98::Sha256Hash;
        use std::str::FromStr;

        let state = state();
        let body = Bytes::from_static(b"{}");
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
        .to_authorization(&keys())
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth.parse().unwrap());
        assert!(
            verify(
                &state,
                &headers,
                "/v1/invites",
                HttpMethod::POST,
                Some(&body),
                true,
                Audience::Public
            )
            .is_ok()
        );
        assert!(
            verify(
                &state,
                &headers,
                "/v1/invites",
                HttpMethod::POST,
                Some(&body),
                true,
                Audience::Public
            )
            .is_err()
        );
    }
}
