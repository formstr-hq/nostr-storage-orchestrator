//! Tauri binding for the storage admin client.
//!
//! This layer holds no business logic. It owns the unlocked [`Session`], moves
//! CPU-bound NIP-49 work onto a blocking worker so Android's UI thread never
//! stalls, and sends the requests `admin_core` has already signed.

use std::sync::Mutex;
use std::time::Duration;

use admin_core::{
    self as core, CoreError, GeneratedKey, HostStatus, Method, Session, SignedRequest, UnlockResult,
};
use reqwest::redirect::Policy;
use tauri::State;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

struct AppState {
    active: Mutex<Option<Session>>,
    client: reqwest::Client,
}

impl AppState {
    /// Take a working copy of the unlocked session.
    ///
    /// The mutex guard is released immediately so a slow host can never block
    /// `lock_host`. Callers drop the copy as soon as the request is signed.
    fn session(&self) -> Result<Session, String> {
        self.active
            .lock()
            .map_err(|_| "Key state is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "Host is locked. Unlock it to continue".to_string())
    }

    /// Send an already-signed request verbatim and return its raw outcome for
    /// `admin_core` to interpret.
    async fn send(&self, request: SignedRequest) -> Result<(u16, Vec<u8>), String> {
        let mut builder = match request.method {
            Method::Get => self.client.get(&request.url),
            Method::Post => self.client.post(&request.url),
        }
        .header(reqwest::header::AUTHORIZATION, &request.authorization);

        if let Some(body) = request.body {
            builder = builder
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }

        let response = builder.send().await.map_err(transport)?;
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(transport)?;
        Ok((status, body.to_vec()))
    }
}

fn transport<E>(_: E) -> String {
    core::transport_error().into_message()
}

/// Run CPU-bound key work (scrypt at log_n 16) off the UI thread.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> core::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Key operation failed".to_string())?
        .map_err(CoreError::into_message)
}

#[tauri::command]
fn normalize_host_url(url: String) -> Result<String, String> {
    core::normalize_host_url(&url).map_err(CoreError::into_message)
}

#[tauri::command]
async fn generate_host_key(passphrase: String) -> Result<GeneratedKey, String> {
    blocking(move || core::generate_key(&passphrase)).await
}

/// Encrypt a plaintext `nsec` into a storable NIP-49 credential. The plaintext
/// is consumed here and never reaches disk.
#[tauri::command]
async fn import_nsec(nsec: String, passphrase: String) -> Result<GeneratedKey, String> {
    blocking(move || core::encrypt_nsec(&nsec, &passphrase)).await
}

#[tauri::command]
async fn unlock_host(
    host_url: String,
    ncryptsec: String,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<UnlockResult, String> {
    let session = blocking(move || Session::open(&host_url, &ncryptsec, &passphrase)).await?;
    let result = session.unlock_result().map_err(CoreError::into_message)?;

    let mut active = state
        .active
        .lock()
        .map_err(|_| "Key state is unavailable".to_string())?;
    *active = Some(session);
    Ok(result)
}

#[tauri::command]
fn lock_host(state: State<'_, AppState>) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Key state is unavailable".to_string())?;
    // Dropping the session drops the decrypted key.
    *active = None;
    Ok(())
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> Result<HostStatus, String> {
    let session = state.session()?;
    let request = session
        .status_request()
        .await
        .map_err(CoreError::into_message)?;
    drop(session);

    let (code, body) = state.send(request).await?;
    core::status_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn generate_invite(state: State<'_, AppState>) -> Result<String, String> {
    let session = state.session()?;
    let request = session
        .invite_request()
        .await
        .map_err(CoreError::into_message)?;
    drop(session);

    let (code, body) = state.send(request).await?;
    core::invite_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn add_device(npub: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session()?;
    let request = session
        .device_request(&npub)
        .await
        .map_err(CoreError::into_message)?;
    drop(session);

    let (code, body) = state.send(request).await?;
    core::device_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn remove_device(npub: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session()?;
    let request = session
        .device_removal_request(&npub)
        .await
        .map_err(CoreError::into_message)?;
    drop(session);

    let (code, body) = state.send(request).await?;
    core::device_response(code, &body).map_err(CoreError::into_message)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = reqwest::Client::builder()
        // Refusing redirects keeps a signed authorization from being replayed
        // against a URL other than the one it was signed for.
        .redirect(Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("reqwest client configuration is valid");

    tauri::Builder::default()
        .manage(AppState {
            active: Mutex::new(None),
            client,
        })
        .invoke_handler(tauri::generate_handler![
            normalize_host_url,
            generate_host_key,
            import_nsec,
            unlock_host,
            lock_host,
            status,
            generate_invite,
            add_device,
            remove_device
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
