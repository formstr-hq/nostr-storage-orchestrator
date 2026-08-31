use axum::{Json, extract::State, http::HeaderMap};
use nostr::nips::nip98::HttpMethod;
use serde::Serialize;

use crate::{
    AppState,
    auth::{self, Audience},
    db_client::{MemberRole, MemberStatus, StorageLifecycle},
    error::ApiError,
    routes::storage_types::{PublicLiveness, liveness},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterResponse {
    members: MemberCounts,
    storages: StorageCounts,
    replica_count_required: u64,
    replica_shortfall: bool,
}

#[derive(Serialize, Default)]
pub struct MemberCounts {
    authorized: u64,
    admins: u64,
    clients: u64,
    revoked: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageCounts {
    total: u64,
    active: u64,
    pending: u64,
    unreachable: u64,
    reported_total_bytes: String,
    reported_free_bytes: String,
}

pub async fn roster(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RosterResponse>, ApiError> {
    let caller = auth::verify(
        &state,
        &headers,
        "/v1/roster",
        HttpMethod::GET,
        None,
        false,
        Audience::Public,
    )?;
    auth::admin(&state, &caller).await?;

    let mut member_counts = MemberCounts::default();
    for member in state.db.list_members().await? {
        match member.status {
            MemberStatus::Revoked => member_counts.revoked += 1,
            MemberStatus::Active => {
                member_counts.authorized += 1;
                match member.role {
                    MemberRole::Admin => member_counts.admins += 1,
                    MemberRole::Client => member_counts.clients += 1,
                }
            }
        }
    }

    let mut storage_counts = StorageCounts::default();
    let mut total_bytes = 0_u128;
    let mut free_bytes = 0_u128;
    for storage in state
        .db
        .list_storages(None)
        .await?
        .into_iter()
        .filter(|storage| storage.lifecycle == StorageLifecycle::Linked)
    {
        storage_counts.total += 1;
        match liveness(&storage, state.active_freshness, chrono::Utc::now()) {
            PublicLiveness::Pending => storage_counts.pending += 1,
            PublicLiveness::Active => storage_counts.active += 1,
            PublicLiveness::Unreachable => storage_counts.unreachable += 1,
        }
        total_bytes = total_bytes.saturating_add(parse_db_bytes(storage.reported_total_bytes));
        free_bytes = free_bytes.saturating_add(parse_db_bytes(storage.reported_free_bytes));
    }
    storage_counts.reported_total_bytes = total_bytes.to_string();
    storage_counts.reported_free_bytes = free_bytes.to_string();

    let replica_count_required = state
        .db
        .plans()
        .await?
        .into_values()
        .map(|plan| plan.replica_count)
        .max()
        .unwrap_or(0);
    let replica_shortfall = storage_counts.active < replica_count_required;
    Ok(Json(RosterResponse {
        members: member_counts,
        storages: storage_counts,
        replica_count_required,
        replica_shortfall,
    }))
}

fn parse_db_bytes(value: Option<String>) -> u128 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}
