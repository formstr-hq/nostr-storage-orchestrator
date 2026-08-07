//! WebAssembly binding for the storage admin client.
//!
//! Mirrors the Tauri command surface one-for-one so the React app can talk to
//! either through the same `AdminClient` port. Like the Tauri binding it holds
//! no business logic: every decision lives in `admin_core`.
//!
//! This module is intended to be instantiated inside a Web Worker. Key material
//! then lives only in that worker's memory, and the scrypt work in
//! [`generate_host_key`] / [`import_nsec`] / [`Session::open`] cannot block the
//! page.

use admin_core::{self as core, CoreError};
use wasm_bindgen::prelude::*;

mod time;

fn js_error(error: CoreError) -> JsValue {
    JsValue::from_str(error.message())
}

fn to_js<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value)
        .map_err(|_| JsValue::from_str("Could not encode the result"))
}

/// A request `admin_core` has already signed. Send it verbatim — changing the
/// URL, method, or body invalidates the NIP-98 authorization.
#[wasm_bindgen]
pub struct SignedRequest {
    inner: core::SignedRequest,
}

#[wasm_bindgen]
impl SignedRequest {
    #[wasm_bindgen(getter)]
    pub fn url(&self) -> String {
        self.inner.url.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn method(&self) -> String {
        self.inner.method.as_str().to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn authorization(&self) -> String {
        self.inner.authorization.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn body(&self) -> Option<Vec<u8>> {
        self.inner.body.clone()
    }
}

impl From<core::SignedRequest> for SignedRequest {
    fn from(inner: core::SignedRequest) -> Self {
        Self { inner }
    }
}

/// An unlocked host. The decrypted key lives inside this object in wasm memory
/// and nowhere else; calling the generated `free()` from JS re-locks.
#[wasm_bindgen]
pub struct Session {
    inner: core::Session,
}

#[wasm_bindgen]
impl Session {
    /// Decrypt `ncryptsec` and bind it to `host_url`. CPU-bound (scrypt).
    pub fn open(host_url: &str, ncryptsec: &str, passphrase: &str) -> Result<Session, JsValue> {
        core::Session::open(host_url, ncryptsec, passphrase)
            .map(|inner| Session { inner })
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = unlockResult)]
    pub fn unlock_result(&self) -> Result<JsValue, JsValue> {
        to_js(&self.inner.unlock_result().map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = statusRequest)]
    pub async fn status_request(&self) -> Result<SignedRequest, JsValue> {
        self.inner
            .status_request()
            .await
            .map(SignedRequest::from)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = inviteRequest)]
    pub async fn invite_request(&self) -> Result<SignedRequest, JsValue> {
        self.inner
            .invite_request()
            .await
            .map(SignedRequest::from)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = deviceRequest)]
    pub async fn device_request(&self, npub: String) -> Result<SignedRequest, JsValue> {
        self.inner
            .device_request(&npub)
            .await
            .map(SignedRequest::from)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = deviceRemovalRequest)]
    pub async fn device_removal_request(&self, npub: String) -> Result<SignedRequest, JsValue> {
        self.inner
            .device_removal_request(&npub)
            .await
            .map(SignedRequest::from)
            .map_err(js_error)
    }
}

#[wasm_bindgen(js_name = normalizeHostUrl)]
pub fn normalize_host_url(url: &str) -> Result<String, JsValue> {
    core::normalize_host_url(url).map_err(js_error)
}

#[wasm_bindgen(js_name = generateHostKey)]
pub fn generate_host_key(passphrase: &str) -> Result<JsValue, JsValue> {
    to_js(&core::generate_key(passphrase).map_err(js_error)?)
}

/// Encrypt a plaintext `nsec` into a storable NIP-49 credential. The plaintext
/// is consumed here and is never returned to JS.
#[wasm_bindgen(js_name = importNsec)]
pub fn import_nsec(nsec: &str, passphrase: &str) -> Result<JsValue, JsValue> {
    to_js(&core::encrypt_nsec(nsec, passphrase).map_err(js_error)?)
}

#[wasm_bindgen(js_name = statusResponse)]
pub fn status_response(status: u16, body: &[u8]) -> Result<JsValue, JsValue> {
    to_js(&core::status_response(status, body).map_err(js_error)?)
}

#[wasm_bindgen(js_name = inviteResponse)]
pub fn invite_response(status: u16, body: &[u8]) -> Result<String, JsValue> {
    core::invite_response(status, body).map_err(js_error)
}

#[wasm_bindgen(js_name = deviceResponse)]
pub fn device_response(status: u16, body: &[u8]) -> Result<(), JsValue> {
    core::device_response(status, body).map_err(js_error)
}

/// The message every binding uses when the host is unreachable.
#[wasm_bindgen(js_name = transportError)]
pub fn transport_error() -> String {
    core::transport_error().into_message()
}
