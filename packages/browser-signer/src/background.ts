/**
 * MV3 service worker: key custody + request handling.
 *
 * Trust model:
 * - The allowlist check (origin → allowed) is authoritative and read
 *   directly from chrome.storage here, BEFORE any signing.
 * - Per-sign approval prompts are NOT part of v0: the allowlist is the
 *   consent surface (one decision per origin, not per request).
 */

import {
  status,
  unlock,
  lock,
  importKey,
  generateKey,
  removeProfile,
  getAllowlist,
  setOriginAllowed,
  isOriginAllowed,
  getActivePublicKey,
  signEvent,
} from "./core";

interface SenderOrigin {
  origin?: string;
}

chrome.runtime.onMessage.addListener((message: { type: string } & Record<string, unknown>, sender, sendResponse) => {
  void (async () => {
    try {
      const data = await handle(message, sender);
      sendResponse({ ok: true, data });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true; // async sendResponse
});

async function handle(message: { type: string } & Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "status":
      return await status();
    case "unlock":
      return await unlock(message.npub as string, message.passphrase as string);
    case "lock":
      return lock();
    case "importKey":
      return await importKey(message.nsec as string, message.passphrase as string, message.label as string);
    case "generateKey":
      return await generateKey(message.passphrase as string, message.label as string);
    case "removeProfile":
      return await removeProfile(message.npub as string);
    case "allowlist":
      return await getAllowlist();
    case "setOriginAllowed":
      await setOriginAllowed(message.origin as string, message.allowed as boolean);
      return { ok: true };
    // ── NIP-07 surface (from pages, via the content-script relay) ──
    case "pubkey":
      await requireAllowed(sender);
      return getActivePublicKey();
    case "signEvent": {
      await requireAllowed(sender);
      const template = message.event as Parameters<typeof signEvent>[0];
      return signEvent(template);
    }
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

/** Origin gate: every NIP-07 call must come from an allow-listed origin. */
async function requireAllowed(sender: chrome.runtime.MessageSender): Promise<void> {
  const origin = (sender as SenderOrigin).origin;
  if (!origin) throw new Error("Unknown caller origin");
  if (!(await isOriginAllowed(origin))) {
    throw new Error(`Origin not enabled: ${origin}`);
  }
}