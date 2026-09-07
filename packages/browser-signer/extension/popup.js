// src/protocol.ts
var WORKER_MSG = "formstr-signer-request";

// src/ui/lib/ipc.ts
function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...message, via: WORKER_MSG }, (reply) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      const parsed = reply;
      if (!parsed) return reject(new Error("No response from signer worker"));
      if (parsed.ok) resolve(parsed.data);
      else reject(new Error(parsed.error ?? "Signer error"));
    });
  });
}

// src/ui/popup.ts
var $ = (id) => document.getElementById(id);
function show(view) {
  $("lockedView").classList.toggle("hidden", view === "unlocked");
  $("unlockedView").classList.toggle("hidden", view === "locked");
}
function setErr(message) {
  $("err").textContent = message;
}
async function refresh() {
  const status = await send({ type: "status" });
  $("dot").classList.toggle("on", status.unlocked);
  $("stateLabel").textContent = status.unlocked ? "unlocked" : "locked";
  $("activeNpub").textContent = status.activeNpub ?? "";
  show(status.unlocked ? "unlocked" : "locked");
  if (!status.unlocked) {
    const sel = $("profileSel");
    sel.innerHTML = "";
    for (const profile of status.profiles) {
      const option = document.createElement("option");
      option.value = profile.npub;
      option.textContent = `${profile.label} \u2014 ${profile.npub.slice(0, 16)}\u2026`;
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
async function renderAllowlist() {
  const entries = await send({ type: "allowlist" });
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
  const npub = $("profileSel").value;
  const passphrase = $("passInput").value;
  if (!npub || !passphrase) return setErr("Pick a key and enter the passphrase");
  const result = await send({ type: "unlock", npub, passphrase });
  if (!result.ok) return setErr(result.error ?? "Unlock failed");
  await refresh();
})());
$("lockBtn").addEventListener("click", () => void (async () => {
  await send({ type: "lock" });
  await refresh();
})());
$("importBtn").addEventListener("click", () => void (async () => {
  const nsec = $("nsecInput").value.trim();
  const passphrase = $("newPassInput").value;
  const label = $("labelInput").value.trim();
  if (!nsec || !passphrase) return setErr("nsec and passphrase required");
  try {
    await send({ type: "importKey", nsec, passphrase, label });
    $("nsecInput").value = "";
    $("newPassInput").value = "";
    $("labelInput").value = "";
    await refresh();
  } catch (error) {
    setErr(error instanceof Error ? error.message : String(error));
  }
})());
$("generateBtn").addEventListener("click", () => void (async () => {
  const passphrase = $("newPassInput").value;
  const label = $("labelInput").value.trim();
  if (!passphrase) return setErr("Passphrase required");
  await send({ type: "generateKey", passphrase, label });
  $("newPassInput").value = "";
  await refresh();
})());
$("allowBtn").addEventListener("click", () => void (async () => {
  const raw = $("originInput").value.trim();
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return setErr("Enter a full URL, e.g. https://example.com");
  }
  await send({ type: "setOriginAllowed", origin, allowed: true });
  $("originInput").value = "";
  await renderAllowlist();
})());
void refresh().then(() => {
  if (!document.getElementById("unlockedView")?.classList.contains("hidden")) void renderAllowlist();
});
