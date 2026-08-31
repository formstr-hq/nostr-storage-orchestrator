use std::str::FromStr;

use nostr::{
    key::Keys,
    nips::nip98::{HttpData, HttpMethod, Sha256Hash},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

use crate::capacity::Capacity;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PingBody {
    blossom_port: u16,
    relay_port: u16,
    reported_total_bytes: String,
    reported_free_bytes: String,
}

pub async fn send(
    http: &reqwest::Client,
    url: &Url,
    keys: &Keys,
    blossom_port: u16,
    relay_port: u16,
    capacity: Capacity,
) -> Result<(), String> {
    let body = serde_json::to_vec(&PingBody {
        blossom_port,
        relay_port,
        reported_total_bytes: capacity.total.to_string(),
        reported_free_bytes: capacity.free.to_string(),
    })
    .map_err(|error| format!("could not serialize ping: {error}"))?;
    let digest = Sha256::digest(&body);
    let hash = Sha256Hash::from_str(&format!("{digest:x}"))
        .map_err(|_| "could not construct NIP-98 payload hash".to_string())?;
    let authorization = HttpData::new(url.clone(), HttpMethod::POST)
        .payload(hash)
        .to_authorization(keys)
        .await
        .map_err(|error| format!("could not sign NIP-98 ping: {error}"))?;
    let response = http
        .post(url.clone())
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("ping request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "control plane rejected ping with HTTP {}",
            response.status()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_capacities_are_decimal_strings() {
        let value = serde_json::to_value(PingBody {
            blossom_port: 3000,
            relay_port: 7777,
            reported_total_bytes: 42_u64.to_string(),
            reported_free_bytes: 20_u64.to_string(),
        })
        .unwrap();
        assert_eq!(value["reportedTotalBytes"], "42");
        assert_eq!(value["reportedFreeBytes"], "20");
        assert!(value.get("tunnelIp").is_none());
    }
}
