use axum::{Json, extract::State, http::HeaderMap};
use nostr::nips::nip98::HttpMethod;
use serde::Serialize;

use crate::{
    AppState,
    auth::{self, Audience},
    db_client::{MemberRole, MemberStatus},
    error::ApiError,
};

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PublicRole {
    Admin,
    Client,
    None,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    npub: String,
    role: PublicRole,
    member_since: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, ApiError> {
    let npub = auth::verify(
        &state,
        &headers,
        "/v1/me",
        HttpMethod::GET,
        None,
        false,
        Audience::Public,
    )?;
    let member = state.db.get_member(&npub).await?;
    let (role, member_since) = match member {
        Some(member) if member.status == MemberStatus::Active => (
            match member.role {
                MemberRole::Admin => PublicRole::Admin,
                MemberRole::Client => PublicRole::Client,
            },
            Some(member.created_at),
        ),
        _ => (PublicRole::None, None),
    };
    Ok(Json(MeResponse {
        npub,
        role,
        member_since,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_roles_are_lowercase() {
        assert_eq!(
            serde_json::to_string(&PublicRole::Admin).unwrap(),
            "\"admin\""
        );
        assert_eq!(
            serde_json::to_string(&PublicRole::None).unwrap(),
            "\"none\""
        );
    }
}
