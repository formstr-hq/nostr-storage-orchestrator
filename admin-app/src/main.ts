import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

const STORAGE_KEY = "formstr.storage-admin.profiles.v1";
const SELECTED_KEY = "formstr.storage-admin.selected.v1";
const DEFAULT_HOST = "https://storage.stg.formstr.app";

interface HostProfile {
  id: string;
  name: string;
  url: string;
  ncryptsec: string;
  npub?: string;
}

interface Peer {
  npub: string;
  tunnelIp: string | null;
  connected: boolean;
  lastSeen: string | null;
}

interface HostStatus {
  connectedCount: number;
  peers: Peer[];
}

interface UnlockResult {
  hostUrl: string;
  npub: string;
}

interface GeneratedKey {
  ncryptsec: string;
  npub: string;
}

type Notice = { type: "error" | "success"; message: string } | null;

const mount = document.querySelector<HTMLDivElement>("#app");
if (!mount) throw new Error("Application mount point is missing");
const root: HTMLDivElement = mount;

let profiles = loadProfiles();
let selectedId = localStorage.getItem(SELECTED_KEY) ?? profiles[0]?.id ?? null;
if (!profiles.some((profile) => profile.id === selectedId)) selectedId = profiles[0]?.id ?? null;
let unlocked = false;
let hostStatus: HostStatus | null = null;
let busy: string | null = null;
let notice: Notice = null;
let dialog: "profile" | "invite" | "backup" | null = profiles.length ? null : "profile";
let invite = "";
let backupCredential = "";
let backupNpub = "";
let profileMode: "import" | "create" = "import";

function loadProfiles(): HostProfile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is HostProfile =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as HostProfile).id === "string" &&
        typeof (item as HostProfile).name === "string" &&
        typeof (item as HostProfile).url === "string" &&
        typeof (item as HostProfile).ncryptsec === "string" &&
        (item as HostProfile).ncryptsec.startsWith("ncryptsec1"),
    );
  } catch {
    return [];
  }
}

function persistProfiles(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
  else localStorage.removeItem(SELECTED_KEY);
}

function selectedProfile(): HostProfile | null {
  return profiles.find((profile) => profile.id === selectedId) ?? null;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ] ?? character,
  );
}

function compactNpub(npub: string): string {
  return npub.length > 26 ? `${npub.slice(0, 14)}...${npub.slice(-8)}` : npub;
}

function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : "The operation could not be completed";
}

function setNotice(type: "error" | "success", message: string): void {
  notice = { type, message };
  render();
  window.setTimeout(() => {
    if (notice?.message === message) {
      notice = null;
      render();
    }
  }, 4200);
}

function statusMarkup(): string {
  if (!unlocked) {
    return `
      <section class="locked-panel">
        <div class="lock-mark"><span></span></div>
        <p class="eyebrow">Session locked</p>
        <h1>Unlock the control plane.</h1>
        <p class="lede">Your passphrase is sent directly to Rust for this unlock only. It is never stored.</p>
        ${selectedProfile() ? `
          <form id="unlock-form" class="unlock-form">
            <label>Passphrase<input id="unlock-passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus></label>
            <button class="primary" type="submit" ${busy ? "disabled" : ""}>
              ${busy === "unlock" ? '<span class="spinner"></span> Unlocking' : "Unlock host"}
            </button>
          </form>` : `
          <button id="first-profile" class="primary" type="button">Add host profile</button>`}
      </section>`;
  }

  const peers = hostStatus?.peers ?? [];
  const peerRows = peers.length
    ? peers
        .map(
          (peer) => `
            <li class="peer-row">
              <span class="peer-state ${peer.connected ? "online" : "offline"}"></span>
              <div class="peer-id">
                <strong title="${escapeHtml(peer.npub)}">${escapeHtml(compactNpub(peer.npub))}</strong>
                <span>${escapeHtml(peer.tunnelIp ?? "Tunnel IP pending")}</span>
              </div>
              <span class="peer-label">${peer.connected ? "Reachable" : "Offline"}</span>
            </li>`,
        )
        .join("")
    : `<li class="empty-row"><span>No approved devices yet</span><small>Create an invite, then approve the device npub.</small></li>`;

  return `
    <main class="dashboard">
      <section class="summary-card">
        <div>
          <p class="eyebrow">Live mesh</p>
          <div class="count-line">
            <strong>${hostStatus ? hostStatus.connectedCount : "-"}</strong>
            <span>connected<br>devices</span>
          </div>
        </div>
        <div class="mesh-visual" aria-hidden="true"><i></i><i></i><i></i><span></span></div>
        <button id="refresh" class="icon-button" type="button" aria-label="Refresh status" title="Refresh status" ${busy ? "disabled" : ""}>
          <span class="refresh-icon ${busy === "status" ? "spinning" : ""}"></span>
        </button>
      </section>

      <section class="operations">
        <article class="operation-card invite-card">
          <p class="eyebrow">Enrollment / 01</p>
          <h2>Issue an invite</h2>
          <p>Generate the host bootstrap credential for a new storage node.</p>
          <button id="generate-invite" class="primary warm" type="button" ${busy ? "disabled" : ""}>
            ${busy === "invite" ? '<span class="spinner dark"></span> Generating' : "Generate invite"}
          </button>
        </article>
        <article class="operation-card">
          <p class="eyebrow">Approval / 02</p>
          <h2>Add a device</h2>
          <p>Approve the npub shown by the node after it imports the invite.</p>
          <form id="device-form">
            <label class="sr-only" for="device-npub">Device npub</label>
            <input id="device-npub" name="npub" type="text" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="npub1..." required>
            <button class="secondary" type="submit" ${busy ? "disabled" : ""}>
              ${busy === "device" ? '<span class="spinner"></span> Approving' : "Approve device"}
            </button>
          </form>
        </article>
      </section>

      <section class="peers-card">
        <div class="section-heading">
          <div><p class="eyebrow">Network roster</p><h2>Peers</h2></div>
          <span>${peers.length} total</span>
        </div>
        <ul class="peer-list">${peerRows}</ul>
      </section>
    </main>`;
}

function profileDialogMarkup(): string {
  if (dialog !== "profile") return "";
  const existing = profiles.length
    ? `<div class="saved-profiles">
        <p class="eyebrow">Saved profiles</p>
        ${profiles
          .map(
            (profile) => `
              <div class="saved-profile">
                <button class="profile-select" type="button" data-select-profile="${escapeHtml(profile.id)}" ${busy ? "disabled" : ""}>
                  <strong>${escapeHtml(profile.name)}</strong><span>${escapeHtml(profile.url)}</span>
                </button>
                <button class="text-button" type="button" data-backup-profile="${escapeHtml(profile.id)}" ${busy ? "disabled" : ""}>Backup</button>
                <button class="text-button danger" type="button" data-delete-profile="${escapeHtml(profile.id)}" ${busy ? "disabled" : ""}>Delete</button>
              </div>`,
          )
          .join("")}
      </div>`
    : "";

  return `
    <div class="dialog-backdrop" role="presentation">
      <section class="dialog profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div class="dialog-heading">
          <div><p class="eyebrow">Host profiles</p><h2 id="profile-title">Connect a control plane</h2></div>
          ${profiles.length ? '<button class="close-button" data-close-dialog type="button" aria-label="Close">x</button>' : ""}
        </div>
        ${existing}
        <div class="mode-switch" role="group" aria-label="Credential source">
           <button type="button" data-profile-mode="import" class="${profileMode === "import" ? "active" : ""}" ${busy ? "disabled" : ""}>Import ncryptsec</button>
           <button type="button" data-profile-mode="create" class="${profileMode === "create" ? "active" : ""}" ${busy ? "disabled" : ""}>Create new key</button>
        </div>
        <form id="profile-form" class="profile-form">
          <div class="field-grid">
            <label>Profile name<input name="name" value="${profiles.length ? "" : "Staging"}" maxlength="48" autocomplete="off" required></label>
            <label>Host URL<input name="url" value="${DEFAULT_HOST}" inputmode="url" autocapitalize="none" spellcheck="false" required></label>
          </div>
          ${profileMode === "import" ? `
            <label>Encrypted secret key<textarea name="ncryptsec" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="ncryptsec1..." required></textarea></label>
            <label>Passphrase<input name="passphrase" type="password" autocomplete="current-password" required></label>` : `
            <div class="security-note"><strong>A new Nostr key will be generated in Rust.</strong><span>You must back up the resulting ncryptsec and remember this passphrase.</span></div>
            <div class="field-grid">
              <label>New passphrase<input name="passphrase" type="password" autocomplete="new-password" minlength="8" required></label>
              <label>Confirm passphrase<input name="confirmation" type="password" autocomplete="new-password" minlength="8" required></label>
            </div>`}
          <button class="primary" type="submit" ${busy ? "disabled" : ""}>
            ${busy === "profile" ? '<span class="spinner"></span> Securing profile' : profileMode === "create" ? "Create and unlock" : "Import and unlock"}
          </button>
        </form>
      </section>
    </div>`;
}

function secretDialogMarkup(kind: "invite" | "backup", secret: string): string {
  if (dialog !== kind) return "";
  const isInvite = kind === "invite";
  return `
    <div class="dialog-backdrop" role="presentation">
      <section class="dialog secret-dialog" role="dialog" aria-modal="true" aria-labelledby="secret-title">
        <div class="warning-mark">!</div>
         <p class="eyebrow">${isInvite ? "Bearer credential" : "Encrypted key backup"}</p>
         <h2 id="secret-title">${isInvite ? "Share this invite securely." : "Store this ncryptsec safely."}</h2>
         <p>${isInvite ? "Anyone holding this reusable host invite can request enrollment until the host rotates it. Send it through a secure channel." : "This encrypted credential is recoverable only with its passphrase. The passphrase is not stored by this app."}</p>
        ${!isInvite && backupNpub ? `<div class="operator-key"><span>Operator npub / add to host allowlist</span><code>${escapeHtml(backupNpub)}</code><button class="text-button" data-copy-npub type="button">Copy operator npub</button></div>` : ""}
        <div class="secret-value" tabindex="0">${escapeHtml(secret)}</div>
        <button class="primary warm" data-copy-secret type="button">Copy ${isInvite ? "invite" : "ncryptsec"}</button>
        <button class="text-button" data-close-dialog type="button">I have stored it safely</button>
      </section>
    </div>`;
}

function render(): void {
  const profile = selectedProfile();
  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-cube"><i></i></span><div><strong>FORMSTR</strong><small>Storage control</small></div></div>
        <div class="host-controls">
          ${profile ? `<button id="profile-menu" class="host-pill" type="button"><span class="status-dot ${unlocked ? "online" : ""}"></span><span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.url.replace(/^https:\/\//, ""))}</small></span><i></i></button>` : '<button id="profile-menu" class="host-pill empty" type="button">Add host</button>'}
          ${unlocked ? '<button id="lock" class="lock-button" type="button">Lock</button>' : ""}
        </div>
      </header>
      ${statusMarkup()}
      <footer><span>NIP-49 encrypted at rest</span><span>NIP-98 signed per request</span><span>Keys in memory only</span></footer>
    </div>
    ${profileDialogMarkup()}
    ${secretDialogMarkup("invite", invite)}
    ${secretDialogMarkup("backup", backupCredential)}
    ${notice ? `<div class="toast ${notice.type}" role="status"><span></span>${escapeHtml(notice.message)}</div>` : ""}`;
  bindEvents();
}

function bindEvents(): void {
  document.querySelector("#profile-menu")?.addEventListener("click", () => {
    dialog = "profile";
    render();
  });
  document.querySelector("#first-profile")?.addEventListener("click", () => {
    dialog = "profile";
    render();
  });
  document.querySelector("#lock")?.addEventListener("click", () => void lock());
  document.querySelector("#refresh")?.addEventListener("click", () => void refreshStatus(false));
  document.querySelector("#generate-invite")?.addEventListener("click", () => void generateInvite());
  document.querySelector<HTMLFormElement>("#unlock-form")?.addEventListener("submit", (event) => void unlock(event));
  document.querySelector<HTMLFormElement>("#device-form")?.addEventListener("submit", (event) => void addDevice(event));
  document.querySelector<HTMLFormElement>("#profile-form")?.addEventListener("submit", (event) => void saveProfile(event));
  document.querySelectorAll<HTMLElement>("[data-close-dialog]").forEach((button) =>
    button.addEventListener("click", () => {
      dialog = null;
      invite = "";
      backupCredential = "";
      backupNpub = "";
      render();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-profile-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      profileMode = button.dataset.profileMode === "create" ? "create" : "import";
      render();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-select-profile]").forEach((button) =>
    button.addEventListener("click", () => void switchProfile(button.dataset.selectProfile ?? "")),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-delete-profile]").forEach((button) =>
    button.addEventListener("click", () => void deleteProfile(button.dataset.deleteProfile ?? "")),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-backup-profile]").forEach((button) =>
    button.addEventListener("click", () => {
      const profile = profiles.find((item) => item.id === button.dataset.backupProfile);
      if (!profile) return;
      backupCredential = profile.ncryptsec;
      backupNpub = profile.npub ?? "";
      dialog = "backup";
      render();
    }),
  );
  document.querySelector("[data-copy-secret]")?.addEventListener("click", () =>
    void copyText(dialog === "invite" ? invite : backupCredential),
  );
  document.querySelector("[data-copy-npub]")?.addEventListener("click", () => void copyText(backupNpub));
}

async function unlock(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const profile = selectedProfile();
  const form = event.currentTarget as HTMLFormElement;
  const passphrase = new FormData(form).get("passphrase");
  if (!profile || typeof passphrase !== "string") return;
  busy = "unlock";
  notice = null;
  render();
  try {
    const result = await invoke<UnlockResult>("unlock_host", {
      hostUrl: profile.url,
      ncryptsec: profile.ncryptsec,
      passphrase,
    });
    profile.url = result.hostUrl;
    profile.npub = result.npub;
    persistProfiles();
    unlocked = true;
    await refreshStatus(true);
  } catch (error) {
    setNotice("error", errorMessage(error));
  } finally {
    busy = null;
    render();
  }
}

async function lock(): Promise<void> {
  try {
    await invoke("lock_host");
  } finally {
    unlocked = false;
    hostStatus = null;
    invite = "";
    render();
  }
}

async function refreshStatus(silent: boolean): Promise<void> {
  if (!unlocked) return;
  if (!silent) {
    busy = "status";
    render();
  }
  try {
    hostStatus = await invoke<HostStatus>("status");
  } catch (error) {
    setNotice("error", errorMessage(error));
  } finally {
    if (!silent) {
      busy = null;
      render();
    }
  }
}

async function generateInvite(): Promise<void> {
  busy = "invite";
  render();
  try {
    invite = await invoke<string>("generate_invite");
    dialog = "invite";
  } catch (error) {
    setNotice("error", errorMessage(error));
  } finally {
    busy = null;
    render();
  }
}

async function addDevice(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const npub = new FormData(form).get("npub");
  if (typeof npub !== "string") return;
  busy = "device";
  render();
  try {
    await invoke("add_device", { npub });
    form.reset();
    setNotice("success", "Device approved. Roster synchronization may take a moment.");
    await refreshStatus(true);
  } catch (error) {
    setNotice("error", errorMessage(error));
  } finally {
    busy = null;
    render();
  }
}

async function saveProfile(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  const passphrase = String(data.get("passphrase") ?? "");
  const confirmation = String(data.get("confirmation") ?? "");
  if (profileMode === "create" && passphrase !== confirmation) {
    setNotice("error", "Passphrase confirmation does not match");
    return;
  }

  busy = "profile";
  render();
  try {
    const url = await invoke<string>("normalize_host_url", { url: String(data.get("url") ?? "") });
    let ncryptsec = String(data.get("ncryptsec") ?? "").trim();
    let generated: GeneratedKey | null = null;
    if (profileMode === "create") {
      generated = await invoke<GeneratedKey>("generate_host_key", { passphrase });
      ncryptsec = generated.ncryptsec;
    }
    const unlockedProfile = await invoke<UnlockResult>("unlock_host", { hostUrl: url, ncryptsec, passphrase });
    const profile: HostProfile = {
      id: crypto.randomUUID(),
      name,
      url: unlockedProfile.hostUrl,
      ncryptsec,
      npub: unlockedProfile.npub,
    };
    profiles.push(profile);
    selectedId = profile.id;
    persistProfiles();
    unlocked = true;
    hostStatus = null;
    if (generated) {
      backupCredential = generated.ncryptsec;
      backupNpub = generated.npub;
      dialog = "backup";
    } else {
      dialog = null;
      setNotice("success", `Profile ${name} imported and unlocked`);
    }
    await refreshStatus(true);
  } catch (error) {
    setNotice("error", errorMessage(error));
  } finally {
    busy = null;
    render();
  }
}

async function switchProfile(id: string): Promise<void> {
  if (!profiles.some((profile) => profile.id === id)) return;
  await lock();
  selectedId = id;
  persistProfiles();
  dialog = null;
  render();
}

async function deleteProfile(id: string): Promise<void> {
  const profile = profiles.find((item) => item.id === id);
  if (!profile || !window.confirm(`Delete ${profile.name}? Ensure its ncryptsec is backed up first.`)) return;
  if (id === selectedId) await lock();
  profiles = profiles.filter((item) => item.id !== id);
  selectedId = profiles[0]?.id ?? null;
  persistProfiles();
  dialog = profiles.length ? "profile" : "profile";
  render();
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    setNotice("success", "Copied to clipboard");
  } catch {
    setNotice("error", "Clipboard access was unavailable");
  }
}

window.addEventListener("pagehide", () => {
  void invoke("lock_host");
});

render();
