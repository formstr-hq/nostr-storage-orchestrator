//! Tauri binding for the storage admin client.
//!
//! This layer holds no business logic. It owns the unlocked [`Session`], moves
//! CPU-bound NIP-49 work onto a blocking worker so Android's UI thread never
//! stalls, and sends the requests `admin_core` has already signed.

use std::sync::Mutex;
use std::time::Duration;

use admin_core::{
    self as core, CoreError, GeneratedKey, HostStatus, Me, Member, MemberRole, Method, Roster,
    Session, SignedRequest, Storage, UnlockResult,
};
use reqwest::redirect::Policy;
use tauri::{image::Image, Manager, State};

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
fn canonical_npub(npub: String) -> Result<String, String> {
    core::canonical_npub(&npub).map_err(CoreError::into_message)
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
async fn me(state: State<'_, AppState>) -> Result<Me, String> {
    let session = state.session()?;
    let request = session
        .me_request()
        .await
        .map_err(CoreError::into_message)?;
    drop(session);
    let (code, body) = state.send(request).await?;
    core::me_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn roster(state: State<'_, AppState>) -> Result<Roster, String> {
    let session = state.session()?;
    let request = session
        .roster_request()
        .await
        .map_err(CoreError::into_message)?;
    drop(session);
    let (code, body) = state.send(request).await?;
    core::roster_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn members(state: State<'_, AppState>) -> Result<Vec<Member>, String> {
    let session = state.session()?;
    let request = session
        .members_request()
        .await
        .map_err(CoreError::into_message)?;
    drop(session);
    let (code, body) = state.send(request).await?;
    core::members_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn storages(state: State<'_, AppState>) -> Result<Vec<Storage>, String> {
    let session = state.session()?;
    let request = session
        .storages_request()
        .await
        .map_err(CoreError::into_message)?;
    drop(session);
    let (code, body) = state.send(request).await?;
    core::storages_response(code, &body).map_err(CoreError::into_message)
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
async fn authorize_member(
    npub: String,
    role: MemberRole,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state.session()?;
    let request = session
        .member_request(&npub, role)
        .await
        .map_err(CoreError::into_message)?;
    drop(session);

    let (code, body) = state.send(request).await?;
    core::mutation_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn revoke_member(npub: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session()?;
    let request = session
        .member_removal_request(&npub)
        .await
        .map_err(CoreError::into_message)?;
    drop(session);

    let (code, body) = state.send(request).await?;
    core::mutation_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn link_storage(npub: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session()?;
    let request = session
        .storage_request(&npub)
        .await
        .map_err(CoreError::into_message)?;
    drop(session);
    let (code, body) = state.send(request).await?;
    core::mutation_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn set_storage_capacity(
    npub: String,
    declared_capacity_bytes: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state.session()?;
    let request = session
        .storage_capacity_request(&npub, &declared_capacity_bytes)
        .await
        .map_err(CoreError::into_message)?;
    drop(session);
    let (code, body) = state.send(request).await?;
    core::mutation_response(code, &body).map_err(CoreError::into_message)
}

#[tauri::command]
async fn remove_storage(npub: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session()?;
    let request = session
        .storage_removal_request(&npub)
        .await
        .map_err(CoreError::into_message)?;
    drop(session);
    let (code, body) = state.send(request).await?;
    core::mutation_response(code, &body).map_err(CoreError::into_message)
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
        .setup(|app| {
            // Linux window managers read the taskbar icon from the running
            // window, not the bundle icon, so dev/unpackaged builds show no
            // icon unless we set it explicitly here.
            #[cfg(target_os = "linux")]
            {
                let icon = Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
                app.get_webview_window("main")
                    .expect("main window exists")
                    .set_icon(icon)?;
            }
            Ok(())
        })
        .manage(AppState {
            active: Mutex::new(None),
            client,
        })
        .invoke_handler(tauri::generate_handler![
            normalize_host_url,
            canonical_npub,
            generate_host_key,
            import_nsec,
            unlock_host,
            lock_host,
            status,
            me,
            roster,
            members,
            storages,
            generate_invite,
            authorize_member,
            revoke_member,
            link_storage,
            set_storage_capacity,
            remove_storage
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
