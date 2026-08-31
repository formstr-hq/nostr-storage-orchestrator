use std::{net::IpAddr, time::Duration};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    db_client::{StorageDb, StorageLifecycle},
    error::ApiError,
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PublicLifecycle {
    Linked,
    Removed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PublicLiveness {
    Pending,
    Active,
    Unreachable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    npub: String,
    owner_npub: String,
    tunnel_ip: Option<String>,
    blossom_port: Option<u16>,
    relay_port: Option<u16>,
    declared_capacity_bytes: Option<String>,
    reported_total_bytes: Option<String>,
    reported_free_bytes: Option<String>,
    lifecycle: PublicLifecycle,
    liveness: PublicLiveness,
    last_ping_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkRequest {
    pub npub: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PingRequest {
    pub blossom_port: u64,
    pub relay_port: u64,
    pub reported_total_bytes: String,
    pub reported_free_bytes: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapacityRequest {
    pub declared_capacity_bytes: String,
}

#[derive(Serialize)]
pub struct PingResponse {
    pub accepted: bool,
    pub liveness: PublicLiveness,
}

#[derive(Serialize)]
pub struct RemoveResponse {
    pub npub: String,
    pub removed: bool,
}

impl StorageView {
    pub fn new(storage: StorageDb, freshness: Duration) -> Self {
        let liveness = liveness(&storage, freshness, Utc::now());
        Self {
            npub: storage.npub,
            owner_npub: storage.owner_npub,
            tunnel_ip: storage.tunnel_ip,
            blossom_port: storage.blossom_port,
            relay_port: storage.relay_port,
            declared_capacity_bytes: storage.declared_capacity_bytes,
            reported_total_bytes: storage.reported_total_bytes,
            reported_free_bytes: storage.reported_free_bytes,
            lifecycle: match storage.lifecycle {
                StorageLifecycle::Linked => PublicLifecycle::Linked,
                StorageLifecycle::Removed => PublicLifecycle::Removed,
            },
            liveness,
            last_ping_at: storage.last_ping_at,
            created_at: storage.created_at,
        }
    }
}

pub fn liveness(storage: &StorageDb, freshness: Duration, now: DateTime<Utc>) -> PublicLiveness {
    match storage.last_ping_at {
        None => PublicLiveness::Pending,
        Some(last) if now.signed_duration_since(last).to_std().unwrap_or_default() <= freshness => {
            PublicLiveness::Active
        }
        Some(_) => PublicLiveness::Unreachable,
    }
}

pub fn valid_port(value: u64) -> Result<u16, ApiError> {
    if !(1024..=65_535).contains(&value) {
        return Err(ApiError::bad_request(
            "storage ports must be between 1024 and 65535",
        ));
    }
    Ok(value as u16)
}

pub fn decimal_u64(value: &str, field: &str) -> Result<u64, ApiError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError::bad_request(format!(
            "{field} must be a decimal string"
        )));
    }
    value
        .parse()
        .map_err(|_| ApiError::bad_request(format!("{field} is too large")))
}

pub fn parse_tunnel_ip(value: &str) -> Result<IpAddr, ApiError> {
    value
        .split('/')
        .next()
        .unwrap_or_default()
        .parse()
        .map_err(|_| ApiError::unprocessable("host nvpn status returned an invalid tunnel IP"))
}

pub fn ensure_empty_body(body: &[u8]) -> Result<(), ApiError> {
    if body.is_empty()
        || serde_json::from_slice::<serde_json::Value>(body).ok() == Some(serde_json::json!({}))
    {
        Ok(())
    } else {
        Err(ApiError::bad_request("expected an empty JSON object"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_validation_checks_ports_capacity_and_host_ip() {
        assert_eq!(valid_port(1024).unwrap(), 1024);
        assert!(valid_port(1023).is_err());
        assert_eq!(decimal_u64("184", "bytes").unwrap(), 184);
        assert!(decimal_u64("1.5", "bytes").is_err());
        assert_eq!(
            parse_tunnel_ip("10.44.0.2/32").unwrap().to_string(),
            "10.44.0.2"
        );
    }

    #[test]
    fn public_storage_enums_are_lowercase() {
        assert_eq!(
            serde_json::to_string(&PublicLifecycle::Linked).unwrap(),
            "\"linked\""
        );
        assert_eq!(
            serde_json::to_string(&PublicLiveness::Unreachable).unwrap(),
            "\"unreachable\""
        );
    }
}
