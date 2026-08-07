//! Clock for `nostr` on `wasm32-unknown-unknown`.
//!
//! `nostr` reads the time through `universal-time`, which has no clock on this
//! target and requires the binary to supply one. Without it the build fails to
//! link with "a time provider is required".
//!
//! This matters for correctness, not just linking: NIP-98 events carry a
//! `created_at`, and the admin backend rejects authorizations outside its
//! freshness window. A wrong clock here reads as an authentication failure.

use core::time::Duration;

use universal_time::{define_time_provider, Instant, MonotonicClock, SystemTime, WallClock};
use wasm_bindgen::{JsCast, JsValue};

struct BrowserClock;

impl WallClock for BrowserClock {
    fn system_time(&self) -> SystemTime {
        // `Date.now()` is milliseconds since the Unix epoch, which is exactly
        // what a NIP-98 `created_at` needs.
        SystemTime::from_unix_duration(Duration::from_secs_f64(
            js_sys::Date::now().max(0.0) / 1000.0,
        ))
    }
}

impl MonotonicClock for BrowserClock {
    fn instant(&self) -> Instant {
        Instant::from_ticks(Duration::from_secs_f64(monotonic_millis() / 1000.0))
    }
}

/// `performance.now()` if the host exposes it, else the wall clock.
///
/// Reached reflectively because the global differs between a window and a
/// worker, and this crate is meant to run in the latter.
fn monotonic_millis() -> f64 {
    fn lookup() -> Option<f64> {
        let performance =
            js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("performance")).ok()?;
        let now = js_sys::Reflect::get(&performance, &JsValue::from_str("now")).ok()?;
        let now = now.dyn_into::<js_sys::Function>().ok()?;
        now.call0(&performance).ok()?.as_f64()
    }

    lookup()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or_else(js_sys::Date::now)
}

define_time_provider!(BrowserClock);
