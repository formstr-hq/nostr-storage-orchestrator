use axum::{Json, body::Bytes, extract::State, http::HeaderMap};
use nostr::nips::nip98::HttpMethod;
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    auth::{self, Audience},
    db_client::{MemberDb, MemberRole, MemberStatus, StorageLifecycle},
    error::ApiError,
    routes::canonical_npub,
};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PublicRole {
    Client,
    Admin,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicStatus {
    Active,
    Revoked,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    npub: String,
    role: PublicRole,
    status: PublicStatus,
    added_by_npub: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    storage_count: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpsertRequest {
    npub: String,
    role: PublicRole,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveRequest {
    npub: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResponse {
    npub: String,
    revoked: bool,
    storages_removed: usize,
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<MemberView>>, ApiError> {
    let caller = verify_admin_get(&state, &headers, "/v1/members").await?;
    tracing::debug!(caller, "listing members");
    let members = state
        .db
        .list_members()
        .await?
        .into_iter()
        .map(MemberView::from)
        .collect();
    Ok(Json(members))
}

pub async fn upsert(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<MemberView>, ApiError> {
    let caller = verify_admin_post(&state, &headers, "/v1/members", &body).await?;
    let request: UpsertRequest = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("invalid member JSON body"))?;
    let target = canonical_npub(&request.npub)?;
    let _mutation_guard = state.admin_mutation_lock.lock().await;
    let new_role = match request.role {
        PublicRole::Client => MemberRole::Client,
        PublicRole::Admin => MemberRole::Admin,
    };
    if let Some(existing) = state.db.get_member(&target).await?
        && existing.status == MemberStatus::Active
        && existing.role == MemberRole::Admin
        && new_role == MemberRole::Client
    {
        ensure_not_last_active_admin(&state, &target).await?;
    }
    let member = state
        .db
        .put_member(&target, new_role, Some(&caller))
        .await?;
    Ok(Json(MemberView::from(member)))
}

pub async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<RemoveResponse>, ApiError> {
    let caller = verify_admin_post(&state, &headers, "/v1/members/remove", &body).await?;
    let request: RemoveRequest = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("invalid member removal JSON body"))?;
    let target = canonical_npub(&request.npub)?;
    if caller == target {
        return Err(ApiError::conflict(
            "administrators cannot revoke themselves",
        ));
    }
    let _mutation_guard = state.admin_mutation_lock.lock().await;
    let member = state
        .db
        .get_member(&target)
        .await?
        .ok_or_else(|| ApiError::not_found("member was not found"))?;
    if member.status == MemberStatus::Active && member.role == MemberRole::Admin {
        ensure_not_last_active_admin(&state, &target).await?;
    }

    // Revoke authority first. Any subsequent failure leaves the member unable
    // to act and is reported as a partial cleanup, never as a false rollback.
    state.db.revoke_member(&target).await?;
    let storages = state.db.list_storages(Some(&target)).await?;
    let mut removed = 0;
    let mut failures = Vec::new();
    for storage in storages
        .into_iter()
        .filter(|storage| storage.lifecycle == StorageLifecycle::Linked)
    {
        if let Err(error) = state.db.remove_storage(&storage.npub).await {
            failures.push(format!("{} lifecycle: {error}", storage.npub));
            continue;
        }
        removed += 1;
        if let Err(error) = state.nvpn.remove_device_and_reload(&storage.npub).await {
            failures.push(format!("{} mesh: {error}", storage.npub));
        }
    }
    if !failures.is_empty() {
        return Err(ApiError::bad_gateway(format!(
            "member revoked and {removed} storage lifecycle(s) removed, but cleanup was partial: {}",
            failures.join("; ")
        )));
    }
    Ok(Json(RemoveResponse {
        npub: target,
        revoked: true,
        storages_removed: removed,
    }))
}

async fn verify_admin_get(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
) -> Result<String, ApiError> {
    let caller = auth::verify(
        state,
        headers,
        path,
        HttpMethod::GET,
        None,
        false,
        Audience::Public,
    )?;
    auth::admin(state, &caller).await?;
    Ok(caller)
}

async fn verify_admin_post(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    body: &Bytes,
) -> Result<String, ApiError> {
    let caller = auth::verify(
        state,
        headers,
        path,
        HttpMethod::POST,
        Some(body),
        true,
        Audience::Public,
    )?;
    auth::admin(state, &caller).await?;
    Ok(caller)
}

async fn ensure_not_last_active_admin(state: &AppState, target: &str) -> Result<(), ApiError> {
    let active_admins = state
        .db
        .list_members()
        .await?
        .into_iter()
        .filter(|member| member.status == MemberStatus::Active && member.role == MemberRole::Admin)
        .count();
    if active_admins <= 1 {
        return Err(ApiError::conflict(format!(
            "{target} is the last active administrator"
        )));
    }
    Ok(())
}

impl From<MemberDb> for MemberView {
    fn from(member: MemberDb) -> Self {
        Self {
            npub: member.npub,
            role: match member.role {
                MemberRole::Client => PublicRole::Client,
                MemberRole::Admin => PublicRole::Admin,
            },
            status: match member.status {
                MemberStatus::Active => PublicStatus::Active,
                MemberStatus::Revoked => PublicStatus::Revoked,
            },
            added_by_npub: member.added_by_npub,
            created_at: member.created_at,
            updated_at: member.updated_at,
            storage_count: member.storage_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_member_enums_are_lowercase() {
        assert_eq!(
            serde_json::to_string(&PublicRole::Admin).unwrap(),
            "\"admin\""
        );
        assert_eq!(
            serde_json::to_string(&PublicStatus::Revoked).unwrap(),
            "\"revoked\""
        );
    }
}
