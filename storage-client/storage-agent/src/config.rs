use std::{env, net::IpAddr, path::PathBuf, time::Duration};

use nostr::{key::PublicKey, nips::nip19::ToBech32};
use url::Url;

const DEFAULT_SECRET_PATH: &str = "/data/config/nvpn/.config.toml.nostr-secret-key.secret";
const DEFAULT_MARKER_PATH: &str = "/data/.sidecar-complete";
const DEFAULT_NVPN_CONFIG_PATH: &str = "/data/config/nvpn/config.toml";
const DEFAULT_ROUTE_PATH: &str = "/proc/net/route";

#[derive(Debug)]
pub struct Config {
    pub control_url: Url,
    pub host_npub: PublicKey,
    pub blossom_path: PathBuf,
    pub relay_path: PathBuf,
    pub blossom_port: u16,
    pub relay_port: u16,
    pub health_port: u16,
    pub ping_interval: Duration,
    pub retry_interval: Duration,
    pub secret_path: PathBuf,
    pub marker_path: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let nvpn_config_path = PathBuf::from(DEFAULT_NVPN_CONFIG_PATH);
        let host_npub = match nonempty_env("CONTROL_PLANE_HOST_NPUB") {
            Some(raw) => canonical_npub(&raw)?,
            None => crate::mesh::inviter_npub(&nvpn_config_path)?,
        };
        let host_ip = match nonempty_env("CONTROL_PLANE_HOST_TUNNEL_IP") {
            Some(raw) => raw
                .parse::<IpAddr>()
                .map_err(|_| "CONTROL_PLANE_HOST_TUNNEL_IP must be an IP address".to_string())?,
            None => crate::mesh::peer_route_ip(
                PathBuf::from(DEFAULT_ROUTE_PATH).as_path(),
                nonempty_env("NVPN_TUN_IFACE").as_deref().unwrap_or("nvpn0"),
            )?
            .into(),
        };
        let api_port = env_u16("CONTROL_PLANE_API_PORT", 3002)?;
        let control_url = Url::parse(&format!("http://{host_ip}:{api_port}/v1/storage/ping"))
            .map_err(|_| "could not construct the internal control-plane URL".to_string())?;
        Ok(Self {
            control_url,
            host_npub,
            blossom_path: env::var_os("BLOSSOM_DATA_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/storage/blossom")),
            relay_path: env::var_os("RELAY_DATA_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/storage/strfry")),
            blossom_port: env_u16("BLOSSOM_PORT", 3000)?,
            relay_port: env_u16("NOSTR_PORT", 7777)?,
            health_port: env_u16("AGENT_HEALTH_PORT", 3010)?,
            ping_interval: Duration::from_secs(env_u64("PING_INTERVAL_SECS", 300)?),
            retry_interval: Duration::from_secs(env_u64("PING_RETRY_SECS", 15)?),
            secret_path: PathBuf::from(DEFAULT_SECRET_PATH),
            marker_path: PathBuf::from(DEFAULT_MARKER_PATH),
        })
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn canonical_npub(raw: &str) -> Result<PublicKey, String> {
    let key = raw
        .parse::<PublicKey>()
        .map_err(|_| "CONTROL_PLANE_HOST_NPUB must be a valid npub".to_string())?;
    if key
        .to_bech32()
        .map_err(|_| "could not encode host npub".to_string())?
        != raw
    {
        return Err("CONTROL_PLANE_HOST_NPUB must be a canonical npub".to_string());
    }
    Ok(key)
}

fn env_u16(name: &str, default: u16) -> Result<u16, String> {
    env::var(name).map_or(Ok(default), |value| {
        value
            .parse()
            .map_err(|_| format!("{name} must be a valid TCP port"))
    })
}

fn env_u64(name: &str, default: u64) -> Result<u64, String> {
    env::var(name).map_or(Ok(default), |value| {
        value
            .parse()
            .map_err(|_| format!("{name} must be an unsigned integer"))
    })
}
