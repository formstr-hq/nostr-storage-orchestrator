pub mod health;
pub mod invites;
pub mod me;
pub mod members;
pub mod roster;
pub mod status;
pub mod storage;
mod storage_types;

use axum::{
    Router,
    routing::{get, post},
};
use nostr::{
    key::PublicKey,
    nips::nip19::{FromBech32, ToBech32},
};

use crate::{AppState, error::ApiError};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health::health))
        .route("/v1/me", get(me::me))
        .route("/v1/status", get(status::status))
        .route("/v1/roster", get(roster::roster))
        .route("/v1/members", get(members::list).post(members::upsert))
        .route("/v1/members/remove", post(members::remove))
        .route("/v1/invites", post(invites::create))
        .route("/v1/storages", get(storage::list))
        .route("/v1/storage", post(storage::link))
        .route("/v1/storage/ping", post(storage::ping))
        .route("/v1/storage/{npub}/capacity", post(storage::capacity))
        .route("/v1/storage/{npub}/remove", post(storage::remove))
}

pub fn canonical_npub(value: &str) -> Result<String, ApiError> {
    let key = PublicKey::from_bech32(value)
        .map_err(|_| ApiError::bad_request("npub must be a full NIP-19 public key"))?;
    let canonical = key.to_bech32().expect("public key encoding is infallible");
    if value != canonical {
        return Err(ApiError::bad_request(
            "npub must be a full canonical NIP-19 public key",
        ));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::key::PublicKey;

    const HEX: &str = "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4";

    #[test]
    fn only_canonical_full_npub_is_accepted() {
        let npub = PublicKey::parse(HEX).unwrap().to_bech32().unwrap();
        assert_eq!(canonical_npub(&npub).unwrap(), npub);
        assert!(canonical_npub(HEX).is_err());
        assert!(canonical_npub("npub1short").is_err());
    }
}
