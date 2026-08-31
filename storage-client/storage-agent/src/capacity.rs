use std::{collections::HashSet, fs, os::unix::fs::MetadataExt, path::Path};

use nix::sys::statvfs::statvfs;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capacity {
    pub total: u64,
    pub free: u64,
}

pub fn measure(paths: [&Path; 2]) -> Result<Capacity, String> {
    let mut devices = HashSet::new();
    let mut total = 0_u64;
    let mut free = 0_u64;
    for path in paths {
        let device = fs::metadata(path)
            .map_err(|error| format!("could not inspect {}: {error}", path.display()))?
            .dev();
        if !devices.insert(device) {
            continue;
        }
        let stats = statvfs(path)
            .map_err(|error| format!("statvfs failed for {}: {error}", path.display()))?;
        total = total.saturating_add(saturating_bytes(stats.blocks(), stats.fragment_size()));
        free = free.saturating_add(saturating_bytes(
            stats.blocks_available(),
            stats.fragment_size(),
        ));
    }
    Ok(Capacity { total, free })
}

fn saturating_bytes(blocks: u64, size: u64) -> u64 {
    u64::try_from(u128::from(blocks) * u128::from(size)).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_multiplication_saturates() {
        assert_eq!(saturating_bytes(4, 1024), 4096);
        assert_eq!(saturating_bytes(u64::MAX, 2), u64::MAX);
    }

    #[test]
    fn same_filesystem_is_counted_once() {
        let result = measure([Path::new("/tmp"), Path::new("/tmp")]).unwrap();
        assert!(result.total > 0);
        assert!(result.free <= result.total);
    }
}
