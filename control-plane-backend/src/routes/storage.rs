use std::time::Instant;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
};
use chrono::Utc;
use nostr::nips::nip98::HttpMethod;

use crate::{
    AppState,
    auth::{self, Audience},
    db_client::{MemberRole, StorageDb, StorageLifecycle},
    error::ApiError,
    nvpn::PeerCache,
    routes::{
        canonical_npub,
        storage_types::{
            CapacityRequest, LinkRequest, PingRequest, PingResponse, PublicLiveness,
            RemoveResponse, StorageView, decimal_u64, ensure_empty_body, parse_tunnel_ip,
            valid_port,
        },
    },
};

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<StorageView>>, ApiError> {
    let caller = verify_public(
        &state,
        &headers,
        "/v1/storages",
        HttpMethod::GET,
        None,
        false,
    )?;
    let member = auth::active_member(&state, &caller).await?;
    let owner = (member.role != MemberRole::Admin).then_some(caller.as_str());
    let storages = state
        .db
        .list_storages(owner)
        .await?
        .into_iter()
        .map(|storage| StorageView::new(storage, state.active_freshness))
        .collect();
    Ok(Json(storages))
}

pub async fn link(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<StorageView>, ApiError> {
    let caller = verify_public(
        &state,
        &headers,
        "/v1/storage",
        HttpMethod::POST,
        Some(&body),
        true,
    )?;
    let request: LinkRequest = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("invalid storage JSON body"))?;
    let npub = canonical_npub(&request.npub)?;
    let _mutation_guard = state.admin_mutation_lock.lock().await;
    auth::active_member(&state, &caller).await?;
    let storage = match state.db.get_storage(&npub).await? {
        Some(storage) if storage.owner_npub != caller => {
            return Err(ApiError::conflict(
                "storage identities cannot be reassigned to another member",
            ));
        }
        Some(_) => {
            state
                .db
                .patch_storage(
                    &npub,
                    serde_json::json!({
                        "lifecycle": "LINKED",
                        "tunnelIp": null,
                        "blossomPort": null,
                        "relayPort": null,
                        "lastPingAt": null,
                        "createdAt": Utc::now(),
                    }),
                )
                .await?
        }
        None => state.db.create_storage(&npub, &caller).await?,
    };
    if let Err(error) = state.nvpn.add_device_and_reload(&npub).await {
        if let Err(rollback_error) = state.db.remove_storage(&npub).await {
            tracing::error!(npub, %rollback_error, "failed to roll back storage link");
        }
        return Err(ApiError::bad_gateway(format!(
            "mesh add/reload failed and the storage link was rolled back: {error}"
        )));
    }
    Ok(Json(StorageView::new(storage, state.active_freshness)))
}

pub async fn ping(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<PingResponse>, ApiError> {
    let signer = verify_public(
        &state,
        &headers,
        "/v1/storage/ping",
        HttpMethod::POST,
        Some(&body),
        true,
    )?;
    let storage = auth::linked_storage(&state, &signer).await?;
    let first_report = storage.last_ping_at.is_none();
    let report: PingRequest = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("invalid storage ping JSON body"))?;
    let blossom_port = valid_port(report.blossom_port)?;
    let relay_port = valid_port(report.relay_port)?;
    let total = decimal_u64(&report.reported_total_bytes, "reportedTotalBytes")?;
    let free = decimal_u64(&report.reported_free_bytes, "reportedFreeBytes")?;
    if free > total {
        return Err(ApiError::bad_request(
            "reportedFreeBytes cannot exceed reportedTotalBytes",
        ));
    }

    // Preserve useful measurements even if host-side peer resolution fails;
    // lastPingAt remains untouched so this cannot make the storage active.
    state
        .db
        .patch_storage(
            &signer,
            serde_json::json!({
                "reportedTotalBytes": total.to_string(),
                "reportedFreeBytes": free.to_string(),
            }),
        )
        .await?;
    let peers = cached_peers(&state).await?;
    let peer = peers
        .iter()
        .find(|peer| peer.fips_endpoint_npub == signer)
        .ok_or_else(|| ApiError::unprocessable("signing npub is absent from host nvpn status"))?;
    if !peer.reachable {
        return Err(ApiError::unprocessable(
            "signing storage is not reachable in host nvpn status",
        ));
    }
    let tunnel_ip = parse_tunnel_ip(&peer.tunnel_ip)?;
    if !state.private_cidr.contains(&tunnel_ip) {
        return Err(ApiError::unprocessable(
            "host-resolved tunnel IP is outside NVPN_PRIVATE_CIDR",
        ));
    }
    state
        .db
        .patch_storage(
            &signer,
            serde_json::json!({
                "tunnelIp": tunnel_ip.to_string(),
                "blossomPort": blossom_port,
                "relayPort": relay_port,
                "reportedTotalBytes": total.to_string(),
                "reportedFreeBytes": free.to_string(),
                "lastPingAt": Utc::now(),
            }),
        )
        .await?;
    if first_report && let Err(error) = state.db.backfill_replicas().await {
        tracing::warn!(%error, "replica URL backfill failed after first storage ping");
    }
    Ok(Json(PingResponse {
        accepted: true,
        liveness: PublicLiveness::Active,
    }))
}

pub async fn capacity(
    State(state): State<AppState>,
    Path(path_npub): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<StorageView>, ApiError> {
    let npub = canonical_npub(&path_npub)?;
    let path = format!("/v1/storage/{npub}/capacity");
    let caller = verify_public(&state, &headers, &path, HttpMethod::POST, Some(&body), true)?;
    authorize_owner_or_admin(&state, &caller, &npub).await?;
    let request: CapacityRequest = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("invalid capacity JSON body"))?;
    let capacity = decimal_u64(&request.declared_capacity_bytes, "declaredCapacityBytes")?;
    let storage = state
        .db
        .patch_storage(
            &npub,
            serde_json::json!({ "declaredCapacityBytes": capacity.to_string() }),
        )
        .await?;
    Ok(Json(StorageView::new(storage, state.active_freshness)))
}

pub async fn remove(
    State(state): State<AppState>,
    Path(path_npub): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<RemoveResponse>, ApiError> {
    let npub = canonical_npub(&path_npub)?;
    let path = format!("/v1/storage/{npub}/remove");
    let caller = verify_public(&state, &headers, &path, HttpMethod::POST, Some(&body), true)?;
    ensure_empty_body(&body)?;
    authorize_owner_or_admin(&state, &caller, &npub).await?;
    state.db.remove_storage(&npub).await?;
    if let Err(error) = state.nvpn.remove_device_and_reload(&npub).await {
        return Err(ApiError::bad_gateway(format!(
            "storage lifecycle is removed, but mesh remove/reload failed: {error}"
        )));
    }
    Ok(Json(RemoveResponse {
        npub,
        removed: true,
    }))
}

pub async fn reap_pending(state: &AppState) -> Result<(), ApiError> {
    let grace = chrono::Duration::from_std(state.pending_reap_grace)
        .map_err(|_| ApiError::internal("pending reap duration is invalid"))?;
    let cutoff = Utc::now() - grace;
    for storage in state
        .db
        .list_storages(None)
        .await?
        .into_iter()
        .filter(|storage| {
            storage.lifecycle == StorageLifecycle::Linked
                && storage.last_ping_at.is_none()
                && storage.created_at < cutoff
        })
    {
        state.db.remove_storage(&storage.npub).await?;
        if let Err(error) = state.nvpn.remove_device_and_reload(&storage.npub).await {
            tracing::warn!(npub = storage.npub, %error, "reaped storage but mesh cleanup failed");
        }
    }
    Ok(())
}

async fn authorize_owner_or_admin(
    state: &AppState,
    caller: &str,
    storage_npub: &str,
) -> Result<StorageDb, ApiError> {
    let member = auth::active_member(state, caller).await?;
    let storage = state
        .db
        .get_storage(storage_npub)
        .await?
        .ok_or_else(|| ApiError::not_found("storage was not found"))?;
    if member.role != MemberRole::Admin && storage.owner_npub != caller {
        return Err(ApiError::forbidden(
            "storage owner or administrator required",
        ));
    }
    Ok(storage)
}

async fn cached_peers(state: &AppState) -> Result<Vec<crate::nvpn::NvpnPeer>, ApiError> {
    let mut cache = state.peer_cache.lock().await;
    if let Some(cached) = cache.as_ref()
        && cached.loaded_at.elapsed() <= state.peer_cache_ttl
    {
        return Ok(cached.peers.clone());
    }
    let peers = state.nvpn.status().await?.peers;
    *cache = Some(PeerCache {
        loaded_at: Instant::now(),
        peers: peers.clone(),
    });
    Ok(peers)
}

fn verify_public(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    method: HttpMethod,
    body: Option<&Bytes>,
    consume: bool,
) -> Result<String, ApiError> {
    let audience = if path == "/v1/storage/ping" {
        Audience::Mesh
    } else {
        Audience::Public
    };
    auth::verify(state, headers, path, method, body, consume, audience)
}
