import { send } from "./lib/ipc";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Status {
  unlocked: boolean;
  activeNpub: string | null;
  profiles: Array<{ npub: string; label: string; createdAt: number }>;
}

interface AllowEntry { origin: string; addedAt: number }

function show(view: "locked" | "unlocked") {
  $("lockedView").classList.toggle("hidden", view === "unlocked");
  $("unlockedView").classList.toggle("hidden", view === "locked");
}

function setErr(message: string) {
  ($("err") as HTMLElement).textContent = message;
}

async function refresh(): Promise<void> {
  const status = (await send({ type: "status" })) as Status;
  $("dot").classList.toggle("on", status.unlocked);
  $("stateLabel").textContent = status.unlocked ? "unlocked" : "locked";
  $("activeNpub").textContent = status.activeNpub ?? "";
  show(status.unlocked ? "unlocked" : "locked");

  if (!status.unlocked) {
    const sel = $("profileSel") as HTMLSelectElement;
    sel.innerHTML = "";
    for (const profile of status.profiles) {
      const option = document.createElement("option");
      option.value = profile.npub;
      option.textContent = `${profile.label} — ${profile.npub.slice(0, 16)}…`;
      sel.appendChild(option);
    }
    if (status.profiles.length === 0) {
      const option = document.createElement("option");
      option.textContent = "No keys stored";
      option.disabled = true;
      sel.appendChild(option);
    }
  } else {
    await renderAllowlist();
  }
  setErr("");
}

async function renderAllowlist(): Promise<void> {
  const entries = (await send({ type: "allowlist" })) as AllowEntry[];
  const list = $("allowlist");
  list.innerHTML = "";
  for (const entry of entries) {
    const item = document.createElement("li");
    const span = document.createElement("span");
    span.className = "npub";
    span.textContent = entry.origin;
    const button = document.createElement("button");
    button.className = "danger";
    button.textContent = "Revoke";
    button.onclick = () => void (async () => {
      await send({ type: "setOriginAllowed", origin: entry.origin, allowed: false });
      await renderAllowlist();
    })();
    item.appendChild(span);
    item.appendChild(button);
    list.appendChild(item);
  }
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.innerHTML = '<span class="muted">No origins enabled</span>';
    list.appendChild(item);
  }
}

$("unlockBtn").addEventListener("click", () => void (async () => {
  const npub = ($("profileSel") as HTMLSelectElement).value;
  const passphrase = ($("passInput") as HTMLInputElement).value;
  if (!npub || !passphrase) return setErr("Pick a key and enter the passphrase");
  const result = await send({ type: "unlock", npub, passphrase }) as { ok: boolean; error?: string };
  if (!result.ok) return setErr(result.error ?? "Unlock failed");
  await refresh();
})());

$("lockBtn").addEventListener("click", () => void (async () => {
  await send({ type: "lock" });
  await refresh();
})());

$("importBtn").addEventListener("click", () => void (async () => {
  const nsec = ($("nsecInput") as HTMLInputElement).value.trim();
  const passphrase = ($("newPassInput") as HTMLInputElement).value;
  const label = ($("labelInput") as HTMLInputElement).value.trim();
  if (!nsec || !passphrase) return setErr("nsec and passphrase required");
  try {
    await send({ type: "importKey", nsec, passphrase, label });
    ($("nsecInput") as HTMLInputElement).value = "";
    ($("newPassInput") as HTMLInputElement).value = "";
    ($("labelInput") as HTMLInputElement).value = "";
    await refresh();
  } catch (error) {
    setErr(error instanceof Error ? error.message : String(error));
  }
})());

$("generateBtn").addEventListener("click", () => void (async () => {
  const passphrase = ($("newPassInput") as HTMLInputElement).value;
  const label = ($("labelInput") as HTMLInputElement).value.trim();
  if (!passphrase) return setErr("Passphrase required");
  await send({ type: "generateKey", passphrase, label });
  ($("newPassInput") as HTMLInputElement).value = "";
  await refresh();
})());

$("allowBtn").addEventListener("click", () => void (async () => {
  const raw = ($("originInput") as HTMLInputElement).value.trim();
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return setErr("Enter a full URL, e.g. https://example.com");
  }
  await send({ type: "setOriginAllowed", origin, allowed: true });
  ($("originInput") as HTMLInputElement).value = "";
  await renderAllowlist();
})());

void refresh().then(() => {
  // Refresh the allowlist only when unlocked (it lives in the unlocked view).
  if (!document.getElementById("unlockedView")?.classList.contains("hidden")) void renderAllowlist();
});