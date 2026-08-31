use std::{fs, path::Path};

use nostr::{
    key::{Keys, SecretKey},
    nips::nip19::{FromBech32, ToBech32},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarMarker {
    role: String,
    schema_version: u64,
    npub: String,
}

pub fn load(secret_path: &Path, marker_path: &Path) -> Result<(Keys, String), String> {
    let nsec = fs::read_to_string(secret_path)
        .map_err(|error| format!("could not read {}: {error}", secret_path.display()))?;
    let secret = SecretKey::from_bech32(nsec.trim())
        .map_err(|_| "nVPN secret file did not contain an nsec".to_string())?;
    let keys = Keys::new(secret);
    let marker: SidecarMarker = serde_json::from_slice(
        &fs::read(marker_path)
            .map_err(|error| format!("could not read {}: {error}", marker_path.display()))?,
    )
    .map_err(|_| "nVPN sidecar marker was invalid JSON".to_string())?;
    if marker.role != "client" || marker.schema_version != 1 {
        return Err("nVPN sidecar marker is not a schema-v1 client marker".to_string());
    }
    let derived = keys
        .public_key()
        .to_bech32()
        .map_err(|_| "could not encode the storage npub".to_string())?;
    if marker.npub != derived {
        return Err("nVPN secret key does not match /data/.sidecar-complete npub".to_string());
    }
    Ok((keys, derived))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_shape_requires_client_role_and_schema() {
        let marker: SidecarMarker = serde_json::from_str(
            r#"{"role":"client","schemaVersion":1,"npub":"npub1example","listenPort":51820}"#,
        )
        .unwrap();
        assert_eq!(marker.role, "client");
        assert_eq!(marker.schema_version, 1);
    }
}
