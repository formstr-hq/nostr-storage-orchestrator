# Storage Control

Administration client for the Nostr Storage Orchestrator. One React + Vite
source tree builds five targets — **web**, **Linux**, **Android**, **Windows**,
and **macOS** — with all business logic in Rust.

## Architecture

```
src/                  React app. Identical UI on every target.
  platform/           The only target-specific code
    types.ts          AdminClient — the port each target implements
    tauri.ts          invoke() adapter        (Linux/Android/Windows/macOS)
    web.ts            worker RPC adapter      (browser)
    worker.ts         Web Worker: owns the wasm instance and does the fetch
crates/
  admin-core/         All logic: crypto, NIP-49, NIP-98 signing, parsing. No I/O.
  admin-wasm/         wasm-bindgen binding over admin-core
src-tauri/            Tauri binding: session state + reqwest transport
```

`admin-core` is the single implementation of every security-relevant decision.
Neither binding contains business logic; they differ only in how they reach Rust
and how they send HTTP. A key generated on one target unlocks on any other.

Vite resolves the `#platform` import to one adapter or the other based on
`VITE_TARGET`, so the web bundle never contains `@tauri-apps/api` and the Tauri
bundle never contains the wasm module.

## Security model

- Profiles live in the WebView's app-local `localStorage`. The only persisted
  credential is the profile's NIP-49 `ncryptsec`.
- A plaintext `nsec` may be **imported once**: it is passed straight to Rust,
  encrypted under a passphrase, and discarded. It is never persisted, and the
  resulting `ncryptsec` is what the app stores and shows you to back up.
- Passphrases exist transiently in the form and across the platform boundary
  during unlock. They are never persisted or logged, and their Rust allocations
  are zeroized after use.
- The decrypted key is held only inside Rust — the host process on Tauri targets,
  the worker's wasm memory on web. Lock, host switch, profile deletion, app exit,
  and page teardown all remove it.
- NIP-49 scrypt runs off the UI thread on every target: `spawn_blocking` on
  native, a dedicated Web Worker on web. Neither Android nor a browser tab
  freezes during unlock.
- Key generation, NIP-49, Bech32, event construction, and signing use pinned
  `nostr = 0.45.0`. Payload SHA-256 uses `bitcoin_hashes`, the library `nostr`
  uses internally. NIP-98 headers come from `HttpData::to_authorization`; every
  POST signs the exact request body's payload hash.
- Imported NIP-49 credentials are capped at scrypt `log_n=16` (about 64 MiB),
  matching keys the app generates, so an untrusted high-cost credential cannot
  exhaust a mobile process.
- Host URLs are normalized in Rust, require HTTPS, and reject credentials, query
  strings, and fragments. Redirects are refused on every target — `Policy::none()`
  natively, `redirect: "error"` in the worker — so a signed authorization cannot
  be replayed against a different URL.

**Web target caveat.** In a browser the `ncryptsec` sits in `localStorage` and
the decrypted key lives in worker memory reachable from the same origin, so an
XSS on the serving origin is a real risk that the Tauri builds do not have. Serve
the web build from a dedicated origin, or prefer a native build for
high-value hosts.

The admin API contract:

| Method | Path | Body |
|---|---|---|
| `GET` | `/v1/status` | none |
| `POST` | `/v1/invites` | `{}` |
| `POST` | `/v1/devices` | `{"npub":"npub1..."}` |

Every endpoint requires a strict `Authorization: Nostr ...` NIP-98 header. Status
reads the backend's sanitized top-level `peers` array and `connected_clients`;
invite creation returns `{ "invite": "..." }`.

## Web

Requires Node.js 20+, pnpm, Rust stable, the wasm target, and `wasm-pack`:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
pnpm install
pnpm dev            # builds wasm, then serves on http://localhost:1420
pnpm build          # -> dist-web/
```

Serve `dist-web/` as static files. The build injects a CSP allowing
`'wasm-unsafe-eval'` and `connect-src https:`.

The host must be reachable over **HTTPS** and must answer CORS preflights —
`admin-backend` does so for any origin (see its README). A plain
`http://localhost` backend will be rejected by `normalize_url`, so front a local
backend with TLS when testing the web build against one.

## Linux, Windows, macOS

Install Node.js 20+, pnpm, Rust stable, and Tauri's system packages. Debian or
Ubuntu:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Arch Linux:

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

Then:

```bash
pnpm install
pnpm tauri:dev
pnpm tauri:build
```

Bundles are written below `target/release/bundle/`. Windows and macOS need no
extra system packages beyond the standard Tauri prerequisites; the app capability
already lists all four desktop platforms.

`tauri:build` runs through `scripts/tauri-build.mjs` rather than calling `tauri`
directly. On Linux it works around two linuxdeploy AppImage-bundling issues that
show up with newer toolchains (Arch in particular): the cached linuxdeploy
AppImage's bundled `strip` can't parse the `.relr.dyn` section modern
glibc/binutils emit and aborts the whole bundle, and Arch's `gdk-pixbuf2`
package no longer ships the `loaders/` directory its `.pc` file still
advertises, which crashes linuxdeploy-plugin-gtk's copy step. The wrapper sets
`NO_STRIP=1` and, only when the advertised gdk-pixbuf loaders directory is
actually missing, points `PKG_CONFIG_PATH` at a local empty-directory shim so
the copy is a no-op. Neither workaround changes the built app; it just lets the
AppImage/deb/rpm bundling finish.

## Android

Install Android Studio with the SDK Platform, Build-Tools, Platform-Tools,
Command-line Tools, NDK (Side by side) and CMake, plus JDK 17 or 21. Then:

```bash
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/<installed-ndk-version>"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

pnpm install
pnpm android:init     # once; generates src-tauri/gen/android
pnpm android:dev
pnpm android:build
```

Tauri's generated manifest includes `android.permission.INTERNET`; verify it
remains present at `src-tauri/gen/android/app/src/main/AndroidManifest.xml` after
regenerating. Android min SDK is 24, the app capability permits only core IPC for
the main window, and all native network access is performed by Rust `reqwest`
rather than the WebView.

For a physical device, enable USB debugging and confirm it appears in
`adb devices`. Release APK/AAB outputs land under
`src-tauri/gen/android/app/build/outputs/`; configure signing in the generated
Gradle project before distribution.

## Tests

```bash
pnpm typecheck                # TypeScript, both tsconfig projects
cargo test -p admin-core      # crypto, signing, parsing — no system deps needed
```

`admin-core`'s tests are the ones that matter: they check a NIP-49 round trip, an
`nsec` import producing a credential for the same key, and — via `nostr`'s own
`verify_auth_header`, the same verifier `admin-backend` uses — that each signed
request validates against its exact URL and body and fails against any other.

Checking the Tauri crate needs that platform's system libraries. On Linux without
WebKit installed you can still type-check the identical code through the Android
target:

```bash
cargo check -p nostr-storage-admin --target aarch64-linux-android
```
