use axum::{Json, extract::State, http::HeaderMap};
use nostr::nips::nip98::HttpMethod;

use crate::{
    AppState,
    auth::{self, Audience},
    error::ApiError,
    nvpn::StatusResponse,
};

pub async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StatusResponse>, ApiError> {
    let npub = auth::verify(
        &state,
        &headers,
        "/v1/status",
        HttpMethod::GET,
        None,
        false,
        Audience::Public,
    )?;
    auth::admin(&state, &npub).await?;
    Ok(Json(state.nvpn.status().await?))
}
