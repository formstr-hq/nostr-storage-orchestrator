use std::{
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::{process::Command, sync::Mutex, time::timeout};
use tracing::{debug, error, info, warn};

use crate::error::ApiError;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone)]
pub struct Nvpn {
    bin: Arc<PathBuf>,
    config: Arc<PathBuf>,
    command_lock: Arc<Mutex<()>>,
    command_timeout: Duration,
}

#[derive(Clone)]
pub struct PeerCache {
    pub loaded_at: Instant,
    pub peers: Vec<NvpnPeer>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct NvpnPeer {
    #[serde(default)]
    pub fips_endpoint_npub: String,
    pub tunnel_ip: String,
    pub reachable: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct StatusResponse {
    pub known_clients: usize,
    pub connected_clients: usize,
    pub peers: Vec<NvpnPeer>,
}

#[derive(Debug, Deserialize)]
struct NvpnStatus {
    daemon: NvpnDaemon,
}

#[derive(Debug, Deserialize)]
struct NvpnDaemon {
    state: Option<NvpnDaemonState>,
}

#[derive(Debug, Deserialize)]
struct NvpnDaemonState {
    peers: Vec<NvpnPeer>,
}

impl Nvpn {
    pub fn new(bin: PathBuf, config: PathBuf) -> Self {
        Self {
            bin: Arc::new(bin),
            config: Arc::new(config),
            command_lock: Arc::new(Mutex::new(())),
            command_timeout: COMMAND_TIMEOUT,
        }
    }

    pub async fn status(&self) -> Result<StatusResponse, ApiError> {
        let config = self.config.to_string_lossy();
        let output = self.run(&["status", "--config", &config, "--json"]).await?;
        parse_status(&output)
    }

    pub async fn create_invite(&self) -> Result<String, ApiError> {
        let config = self.config.to_string_lossy();
        let output = self.run(&["create-invite", "--config", &config]).await?;
        extract_invite(&output)
    }

    pub async fn add_device_and_reload(&self, npub: &str) -> Result<(), ApiError> {
        let _guard = self.command_lock.lock().await;
        let config = self.config.to_string_lossy();
        self.run_locked(&[
            "add-device",
            "--config",
            &config,
            "--device",
            npub,
            "--publish",
        ])
        .await?;
        self.run_locked(&["reload", "--config", &config]).await?;
        info!(npub, "device added and mesh reloaded");
        Ok(())
    }

    pub async fn remove_device_and_reload(&self, npub: &str) -> Result<(), ApiError> {
        let _guard = self.command_lock.lock().await;
        let config = self.config.to_string_lossy();
        self.run_locked(&[
            "remove-device",
            "--config",
            &config,
            "--device",
            npub,
            "--publish",
        ])
        .await?;
        self.run_locked(&["reload", "--config", &config]).await?;
        info!(npub, "device removed and mesh reloaded");
        Ok(())
    }

    async fn run(&self, args: &[&str]) -> Result<Vec<u8>, ApiError> {
        let _guard = self.command_lock.lock().await;
        self.run_locked(args).await
    }

    async fn run_locked(&self, args: &[&str]) -> Result<Vec<u8>, ApiError> {
        let bin = self.bin.display();
        debug!(%bin, ?args, "running nvpn command");
        let mut command = Command::new(self.bin.as_ref());
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().map_err(|error| {
            error!(%bin, ?args, %error, "failed to spawn nvpn");
            ApiError::bad_gateway("nVPN operation could not start")
        })?;
        let output = timeout(self.command_timeout, child.wait_with_output())
            .await
            .map_err(|_| {
                warn!(?args, "nVPN command timed out");
                ApiError::new(
                    axum::http::StatusCode::GATEWAY_TIMEOUT,
                    "nvpn_timeout",
                    "nVPN operation timed out",
                )
            })?
            .map_err(|error| {
                error!(?args, %error, "failed to read nvpn command output");
                ApiError::bad_gateway("nVPN operation failed")
            })?;
        if !output.status.success() {
            error!(
                ?args,
                code = ?output.status.code(),
                stderr = %truncated(&String::from_utf8_lossy(&output.stderr)),
                "nVPN command exited with a failure status"
            );
            return Err(ApiError::bad_gateway("nVPN operation failed"));
        }
        Ok(output.stdout)
    }
}

fn parse_status(output: &[u8]) -> Result<StatusResponse, ApiError> {
    let status: NvpnStatus = serde_json::from_slice(output).map_err(|error| {
        error!(%error, output = %truncated(&String::from_utf8_lossy(output)), "unexpected nvpn status JSON");
        ApiError::bad_gateway("nVPN status was unavailable")
    })?;
    let peers = status
        .daemon
        .state
        .ok_or_else(|| {
            error!("nvpn status had no daemon.state; is the daemon running?");
            ApiError::bad_gateway("nVPN daemon state was unavailable")
        })?
        .peers;
    Ok(StatusResponse {
        known_clients: peers.len(),
        connected_clients: peers.iter().filter(|peer| peer.reachable).count(),
        peers,
    })
}

fn extract_invite(output: &[u8]) -> Result<String, ApiError> {
    let output = std::str::from_utf8(output)
        .map_err(|_| ApiError::bad_gateway("nVPN invite output was invalid"))?;
    output
        .split_ascii_whitespace()
        .find(|part| part.starts_with("nvpn://invite/") && part.len() > "nvpn://invite/".len())
        .map(ToOwned::to_owned)
        .ok_or_else(|| ApiError::bad_gateway("nVPN did not return an invite"))
}

fn truncated(input: &str) -> String {
    const MAX_CHARS: usize = 2000;
    if input.chars().count() <= MAX_CHARS {
        return input.to_string();
    }
    let mut clipped: String = input.chars().take(MAX_CHARS).collect();
    clipped.push_str("...");
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_parser_preserves_cli_shape_and_reachability() {
        let response = parse_status(br#"{
            "daemon":{"state":{"peers":[
                {"fips_endpoint_npub":"npub1first","tunnel_ip":"10.44.0.2/32","reachable":true,"ignored":1},
                {"fips_endpoint_npub":"npub1second","tunnel_ip":"10.44.0.3/32","reachable":false}
            ]}}
        }"#).unwrap();
        assert_eq!(response.known_clients, 2);
        assert_eq!(response.connected_clients, 1);
        assert_eq!(response.peers[0].tunnel_ip, "10.44.0.2/32");
    }

    #[test]
    fn invite_parser_returns_only_token() {
        assert_eq!(
            extract_invite(b"notice\nnvpn://invite/abc123\n").unwrap(),
            "nvpn://invite/abc123"
        );
        assert!(extract_invite(b"invite unavailable").is_err());
    }
}
