use std::{fs, net::Ipv4Addr, path::Path};

use nostr::key::PublicKey;

pub fn inviter_npub(config_path: &Path) -> Result<PublicKey, String> {
    let contents = fs::read_to_string(config_path)
        .map_err(|error| format!("could not read {}: {error}", config_path.display()))?;
    parse_inviter_npub(&contents)
}

pub fn peer_route_ip(route_path: &Path, interface: &str) -> Result<Ipv4Addr, String> {
    let contents = fs::read_to_string(route_path)
        .map_err(|error| format!("could not read {}: {error}", route_path.display()))?;
    parse_peer_route(&contents, interface)
}

fn parse_inviter_npub(contents: &str) -> Result<PublicKey, String> {
    let raw = contents
        .lines()
        .find_map(|line| {
            let value = line.trim().strip_prefix("invite_inviter")?.trim_start();
            Some(value.strip_prefix('=')?.trim().trim_matches('"'))
        })
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "nVPN config has no invite_inviter".to_string())?;
    raw.parse()
        .map_err(|_| "nVPN config invite_inviter is not a valid npub".to_string())
}

fn parse_peer_route(contents: &str, interface: &str) -> Result<Ipv4Addr, String> {
    let mut peers = contents.lines().skip(1).filter_map(|line| {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        if fields.len() < 8 || fields[0] != interface || fields[7] != "FFFFFFFF" {
            return None;
        }
        let flags = u16::from_str_radix(fields[3], 16).ok()?;
        if flags & 1 == 0 {
            return None;
        }
        let encoded = u32::from_str_radix(fields[1], 16).ok()?;
        let address = Ipv4Addr::from(encoded.to_le_bytes());
        (!address.is_unspecified()).then_some(address)
    });
    let peer = peers
        .next()
        .ok_or_else(|| format!("no /32 peer route exists on {interface}"))?;
    if peers.next().is_some() {
        return Err(format!(
            "more than one /32 peer route exists on {interface}; set CONTROL_PLANE_HOST_TUNNEL_IP"
        ));
    }
    Ok(peer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{
        key::{Keys, SecretKey},
        nips::nip19::ToBech32,
    };

    #[test]
    fn reads_inviter_from_imported_config() {
        let npub = Keys::new(
            SecretKey::parse("0000000000000000000000000000000000000000000000000000000000000001")
                .unwrap(),
        )
        .public_key()
        .to_bech32()
        .unwrap();
        let parsed = parse_inviter_npub(&format!("invite_inviter = \"{npub}\"\n")).unwrap();
        assert_eq!(parsed.to_bech32().unwrap(), npub);
    }

    #[test]
    fn reads_little_endian_peer_route() {
        let routes = "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n\
                      nvpn0 09072C0A 00000000 0001 0 0 0 FFFFFFFF 0 0 0\n";
        assert_eq!(
            parse_peer_route(routes, "nvpn0").unwrap(),
            Ipv4Addr::new(10, 44, 7, 9)
        );
    }
}
