use axum::{Json, body::Bytes, extract::State, http::HeaderMap};
use nostr::nips::nip98::HttpMethod;
use serde::Serialize;

use crate::{
    AppState,
    auth::{self, Audience},
    error::ApiError,
};

#[derive(Serialize)]
pub struct InviteResponse {
    invite: String,
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<InviteResponse>, ApiError> {
    let npub = auth::verify(
        &state,
        &headers,
        "/v1/invites",
        HttpMethod::POST,
        Some(&body),
        true,
        Audience::Public,
    )?;
    auth::active_member(&state, &npub).await?;
    ensure_empty_json(&body)?;
    Ok(Json(InviteResponse {
        invite: state.nvpn.create_invite().await?,
    }))
}

fn ensure_empty_json(body: &[u8]) -> Result<(), ApiError> {
    if body.is_empty() {
        return Ok(());
    }
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| ApiError::bad_request("invalid JSON body"))?;
    if value == serde_json::json!({}) {
        Ok(())
    } else {
        Err(ApiError::bad_request("expected an empty JSON object"))
    }
}
