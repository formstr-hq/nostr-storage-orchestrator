//! HTTP client for provider pg-agent endpoints over the NVPN mesh.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{GatewayError, Result};

#[derive(Debug, Clone, Serialize)]
pub struct WriteOpPayload {
    pub id: String,
    #[serde(rename = "table")]
    pub table_name: String,
    /// INSERT | UPDATE | DELETE
    pub op: String,
    #[serde(rename = "rowId")]
    pub row_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyRequest {
    pub ops: Vec<WriteOpPayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct QueryResponse {
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SchemaResponse {
    pub version: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PgAgentHealth {
    pub status: String,
    pub version: i32,
    pub tables: Option<Vec<String>>,
}

#[derive(Clone)]
pub struct ProviderClient {
    http: Client,
    token: Option<String>,
}

impl ProviderClient {
    pub fn new(timeout: Duration, token: Option<String>) -> Self {
        let http = Client::builder()
            .timeout(timeout)
            .build()
            .expect("reqwest client builds");
        Self { http, token }
    }

    fn base(&self, provider_url: &str) -> String {
        provider_url.trim_end_matches('/').to_string()
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let builder = self.http.request(method, url);
        match &self.token {
            Some(token) => builder.bearer_auth(token),
            None => builder,
        }
    }

    pub async fn apply(&self, provider_url: &str, request: &ApplyRequest) -> Result<()> {
        let response = self
            .request(reqwest::Method::POST, &format!("{}/pg/apply", self.base(provider_url)))
            .json(request)
            .send()
            .await
            .map_err(|error| GatewayError::provider(format!("{provider_url}: {error}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GatewayError::provider(format!(
                "{provider_url}/pg/apply returned {status}: {body}"
            )));
        }
        Ok(())
    }

    pub async fn query(&self, provider_url: &str, sql: &str) -> Result<Vec<Value>> {
        let response = self
            .request(reqwest::Method::POST, &format!("{}/pg/query", self.base(provider_url)))
            .json(&serde_json::json!({ "sql": sql }))
            .send()
            .await
            .map_err(|error| GatewayError::provider(format!("{provider_url}: {error}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GatewayError::provider(format!(
                "{provider_url}/pg/query returned {status}: {body}"
            )));
        }
        let decoded: QueryResponse = response
            .json()
            .await
            .map_err(|error| GatewayError::provider(format!("{provider_url}: bad JSON: {error}")))?;
        Ok(decoded.rows)
    }

    pub async fn schema(&self, provider_url: &str, migrations: &[crate::central::PendingMigration]) -> Result<i32> {
        let payload: Vec<Value> = migrations
            .iter()
            .map(|migration| serde_json::json!({ "id": migration.id, "version": migration.version, "ddl": migration.ddl }))
            .collect();
        let response = self
            .request(reqwest::Method::POST, &format!("{}/pg/schema", self.base(provider_url)))
            .json(&serde_json::json!({ "migrations": payload }))
            .send()
            .await
            .map_err(|error| GatewayError::provider(format!("{provider_url}: {error}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GatewayError::provider(format!(
                "{provider_url}/pg/schema returned {status}: {body}"
            )));
        }
        let decoded: SchemaResponse = response
            .json()
            .await
            .map_err(|error| GatewayError::provider(format!("{provider_url}: bad JSON: {error}")))?;
        Ok(decoded.version)
    }

    pub async fn health(&self, provider_url: &str) -> Result<PgAgentHealth> {
        let response = self
            .request(reqwest::Method::GET, &format!("{}/pg/health", self.base(provider_url)))
            .send()
            .await
            .map_err(|error| GatewayError::provider(format!("{provider_url}: {error}")))?;
        if !response.status().is_success() {
            let status = response.status();
            return Err(GatewayError::provider(format!(
                "{provider_url}/pg/health returned {status}"
            )));
        }
        response
            .json()
            .await
            .map_err(|error| GatewayError::provider(format!("{provider_url}: bad JSON: {error}")))
    }
}