use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::error::ApiError;

#[derive(Clone)]
pub struct DbClient {
    base: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum MemberRole {
    Client,
    Admin,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum MemberStatus {
    Active,
    Revoked,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum StorageLifecycle {
    Linked,
    Removed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDb {
    pub npub: String,
    pub role: MemberRole,
    pub status: MemberStatus,
    pub added_by_npub: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub storage_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDb {
    pub npub: String,
    pub owner_npub: String,
    pub tunnel_ip: Option<String>,
    pub blossom_port: Option<u16>,
    pub relay_port: Option<u16>,
    pub declared_capacity_bytes: Option<String>,
    pub reported_total_bytes: Option<String>,
    pub reported_free_bytes: Option<String>,
    pub lifecycle: StorageLifecycle,
    pub last_ping_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanConfig {
    pub replica_count: u64,
}

impl DbClient {
    pub fn new(base: String) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("reqwest client configuration is valid"),
        }
    }

    pub async fn get_member(&self, npub: &str) -> Result<Option<MemberDb>, ApiError> {
        self.get_optional(&format!("/members/{npub}")).await
    }

    pub async fn list_members(&self) -> Result<Vec<MemberDb>, ApiError> {
        self.send_json(Method::GET, "/members", None).await
    }

    pub async fn put_member(
        &self,
        npub: &str,
        role: MemberRole,
        added_by_npub: Option<&str>,
    ) -> Result<MemberDb, ApiError> {
        self.send_json(
            Method::PUT,
            &format!("/members/{npub}"),
            Some(serde_json::json!({
                "role": role,
                "status": MemberStatus::Active,
                "addedByNpub": added_by_npub,
            })),
        )
        .await
    }

    pub async fn revoke_member(&self, npub: &str) -> Result<MemberDb, ApiError> {
        self.send_json(Method::DELETE, &format!("/members/{npub}"), None)
            .await
    }

    pub async fn get_storage(&self, npub: &str) -> Result<Option<StorageDb>, ApiError> {
        self.get_optional(&format!("/storages/{npub}")).await
    }

    pub async fn list_storages(
        &self,
        owner_npub: Option<&str>,
    ) -> Result<Vec<StorageDb>, ApiError> {
        let path = owner_npub.map_or_else(
            || "/storages".to_string(),
            |owner| format!("/storages?ownerNpub={owner}"),
        );
        self.send_json(Method::GET, &path, None).await
    }

    pub async fn create_storage(
        &self,
        npub: &str,
        owner_npub: &str,
    ) -> Result<StorageDb, ApiError> {
        self.send_json(
            Method::POST,
            "/storages",
            Some(serde_json::json!({
                "npub": npub,
                "ownerNpub": owner_npub,
                "lifecycle": StorageLifecycle::Linked,
            })),
        )
        .await
    }

    pub async fn patch_storage(
        &self,
        npub: &str,
        patch: serde_json::Value,
    ) -> Result<StorageDb, ApiError> {
        self.send_json(Method::PATCH, &format!("/storages/{npub}"), Some(patch))
            .await
    }

    pub async fn remove_storage(&self, npub: &str) -> Result<StorageDb, ApiError> {
        self.send_json(Method::DELETE, &format!("/storages/{npub}"), None)
            .await
    }

    pub async fn plans(&self) -> Result<std::collections::HashMap<String, PlanConfig>, ApiError> {
        self.send_json(Method::GET, "/plans", None).await
    }

    pub async fn backfill_replicas(&self) -> Result<(), ApiError> {
        let _: serde_json::Value = self
            .send_json(
                Method::POST,
                "/storages/backfill-replicas",
                Some(serde_json::json!({ "dryRun": false })),
            )
            .await?;
        Ok(())
    }

    async fn get_optional<T: DeserializeOwned>(&self, path: &str) -> Result<Option<T>, ApiError> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .map_err(db_unavailable)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(decode(response).await?))
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, ApiError> {
        let mut request = self.http.request(method, format!("{}{path}", self.base));
        if let Some(body) = body {
            request = request.json(&body);
        }
        decode(request.send().await.map_err(db_unavailable)?).await
    }
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, ApiError> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status {
            StatusCode::NOT_FOUND => ApiError::not_found("db-api record was not found"),
            StatusCode::CONFLICT => ApiError::conflict("db-api rejected a conflicting record"),
            _ => ApiError::bad_gateway(format!("db-api returned HTTP {status}")),
        });
    }
    response
        .json()
        .await
        .map_err(|_| ApiError::bad_gateway("db-api returned an incompatible response"))
}

fn db_unavailable(error: reqwest::Error) -> ApiError {
    tracing::error!(%error, "db-api request failed");
    ApiError::bad_gateway("db-api is unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_enums_are_uppercase() {
        assert_eq!(
            serde_json::to_string(&MemberRole::Admin).unwrap(),
            "\"ADMIN\""
        );
        assert_eq!(
            serde_json::to_string(&StorageLifecycle::Linked).unwrap(),
            "\"LINKED\""
        );
    }
}
