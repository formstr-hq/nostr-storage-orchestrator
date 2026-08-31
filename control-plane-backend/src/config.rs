use std::{
    collections::HashSet,
    env,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use ipnet::IpNet;
use nostr::{key::PublicKey, nips::nip19::ToBech32};
use tokio::sync::Mutex;
use tracing::info;
use url::Url;

use crate::{AppState, db_client::DbClient, nvpn::Nvpn};

const DEFAULT_PORT: u16 = 3002;
const DEFAULT_NVPN_CONFIG: &str = "/data/config/nvpn/config.toml";
const DEFAULT_NVPN_BIN: &str = "nvpn";

#[derive(Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    public_base: String,
    mesh_base: String,
    bootstrap_admins: Vec<String>,
    db_api_url: String,
    nvpn_bin: PathBuf,
    nvpn_config: PathBuf,
    private_cidr: IpNet,
    active_freshness: Duration,
    pending_reap_grace: Duration,
    peer_cache_ttl: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = env_u16("ADMIN_API_PORT", DEFAULT_PORT)?;
        let nvpn_config = env::var_os("NVPN_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_NVPN_CONFIG));
        let private_cidr = env::var("NVPN_PRIVATE_CIDR")
            .unwrap_or_else(|_| "10.44.0.0/16".to_string())
            .parse::<IpNet>()
            .map_err(|_| "NVPN_PRIVATE_CIDR must be a valid CIDR".to_string())?;
        let public_base = parse_base_url(
            env::var("ADMIN_PUBLIC_URL").ok().as_deref(),
            Some(format!("http://localhost:{port}")),
            "ADMIN_PUBLIC_URL",
            !cfg!(debug_assertions),
        )?;
        let mesh_base = parse_base_url(
            env::var("CONTROL_PLANE_MESH_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .as_deref(),
            Some(default_mesh_base(&nvpn_config, private_cidr, port)?),
            "CONTROL_PLANE_MESH_URL",
            false,
        )?;
        let bootstrap_admins = parse_bootstrap_admins(
            env::var("ADMIN_ALLOWED_PUBKEYS")
                .unwrap_or_default()
                .as_str(),
        )?;

        Ok(Self {
            listen_addr: SocketAddr::from(([0, 0, 0, 0], port)),
            public_base,
            mesh_base,
            bootstrap_admins,
            db_api_url: env::var("DB_API_URL").unwrap_or_else(|_| "http://db:4000".to_string()),
            nvpn_bin: env::var_os("NVPN_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_NVPN_BIN)),
            nvpn_config,
            private_cidr,
            active_freshness: Duration::from_secs(env_u64("ACTIVE_FRESHNESS_SECS", 960)?),
            pending_reap_grace: Duration::from_secs(env_u64("PENDING_REAP_SECS", 86_400)?),
            peer_cache_ttl: Duration::from_secs(env_u64("PING_PEER_CACHE_SECS", 15)?),
        })
    }

    pub fn into_state(self) -> AppState {
        info!(
            public_base = %self.public_base,
            mesh_base = %self.mesh_base,
            db_api_url = %self.db_api_url,
            nvpn_bin = %self.nvpn_bin.display(),
            bootstrap_admins = self.bootstrap_admins.len(),
            "control-plane-backend configured"
        );
        AppState {
            public_base: self.public_base.into(),
            mesh_base: self.mesh_base.into(),
            bootstrap_admins: Arc::new(self.bootstrap_admins),
            used_auth_events: Arc::new(StdMutex::new(Default::default())),
            db: DbClient::new(self.db_api_url),
            nvpn: Nvpn::new(self.nvpn_bin, self.nvpn_config),
            private_cidr: self.private_cidr,
            active_freshness: self.active_freshness,
            pending_reap_grace: self.pending_reap_grace,
            peer_cache_ttl: self.peer_cache_ttl,
            peer_cache: Arc::new(Mutex::new(None)),
            admin_mutation_lock: Arc::new(Mutex::new(())),
        }
    }
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

fn default_mesh_base(config: &std::path::Path, cidr: IpNet, port: u16) -> Result<String, String> {
    let contents = std::fs::read_to_string(config).map_err(|error| {
        format!(
            "CONTROL_PLANE_MESH_URL is unset and {} could not be read: {error}",
            config.display()
        )
    })?;
    let address = parse_node_tunnel_ip(&contents).ok_or_else(|| {
        format!(
            "CONTROL_PLANE_MESH_URL is unset and {} has no node tunnel_ip",
            config.display()
        )
    })?;
    if !cidr.contains(&address) {
        return Err("the host tunnel_ip is outside NVPN_PRIVATE_CIDR".to_string());
    }
    Ok(match address {
        IpAddr::V4(address) => format!("http://{address}:{port}"),
        IpAddr::V6(address) => format!("http://[{address}]:{port}"),
    })
}

fn parse_node_tunnel_ip(contents: &str) -> Option<IpAddr> {
    contents.lines().find_map(|line| {
        let value = line.trim().strip_prefix("tunnel_ip")?.trim_start();
        let value = value.strip_prefix('=')?.trim().trim_matches('"');
        value.split('/').next()?.parse().ok()
    })
}

fn parse_base_url(
    value: Option<&str>,
    default: Option<String>,
    name: &str,
    required: bool,
) -> Result<String, String> {
    let value = match value.map(str::trim) {
        Some("") => return Err(format!("{name} cannot be empty")),
        Some(value) => value.to_string(),
        None if required => return Err(format!("{name} is required in release builds")),
        None => default.ok_or_else(|| format!("{name} is required"))?,
    };
    let url = Url::parse(&value).map_err(|_| format!("{name} must be an absolute URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{name} must be an http(s) base URL without credentials, query, or fragment"
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn parse_bootstrap_admins(raw: &str) -> Result<Vec<String>, String> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = HashSet::new();
    let mut admins = Vec::new();
    for (index, entry) in raw.split(',').enumerate() {
        let entry = entry.trim();
        if entry.is_empty() {
            return Err(format!(
                "ADMIN_ALLOWED_PUBKEYS entry {} is empty",
                index + 1
            ));
        }
        let key = PublicKey::parse(entry).map_err(|_| {
            format!(
                "ADMIN_ALLOWED_PUBKEYS entry {} is not an npub or hex public key",
                index + 1
            )
        })?;
        let canonical = key.to_bech32().expect("public key encoding is infallible");
        let valid =
            entry == canonical || (entry.len() == 64 && entry.eq_ignore_ascii_case(&key.to_hex()));
        if !valid {
            return Err(format!(
                "ADMIN_ALLOWED_PUBKEYS entry {} must be an npub or 64-character hex key",
                index + 1
            ));
        }
        if seen.insert(canonical.clone()) {
            admins.push(canonical);
        }
    }
    Ok(admins)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4";

    #[test]
    fn bootstrap_allowlist_is_optional_and_canonicalized() {
        assert!(parse_bootstrap_admins("").unwrap().is_empty());
        let admins = parse_bootstrap_admins(HEX).unwrap();
        assert_eq!(admins.len(), 1);
        assert!(admins[0].starts_with("npub1"));
    }

    #[test]
    fn mesh_default_uses_host_address_from_nvpn_config() {
        let path = std::env::temp_dir().join(format!(
            "control-plane-config-{}-{}.toml",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        std::fs::write(&path, "[node]\ntunnel_ip = \"10.44.7.9/32\"\n").unwrap();
        assert_eq!(
            default_mesh_base(&path, "10.44.0.0/16".parse().unwrap(), 3002).unwrap(),
            "http://10.44.7.9:3002"
        );
        std::fs::remove_file(path).unwrap();
    }
}
