/**
 * ISOLATED-world content script: relays window.postMessage from the MAIN
 * world inpage script to the service worker (chrome.runtime.sendMessage),
 * enforcing a single extension-owned path. The service worker does the
 * origin check — this relay is transport only.
 */
(function () {
  "use strict";

  // Inject the MAIN-world inpage script (NIP-07 surface).
  const inpage = document.createElement("script");
  inpage.src = chrome.runtime.getURL("inpage.js");
  inpage.type = "module";
  (document.head || document.documentElement).prepend(inpage);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== "formstr-signer-request") return;
    const { id, method, args } = data;
    const respond = (response: { ok: boolean; data?: unknown; error?: string }) => {
      window.postMessage({ type: "formstr-signer-response", id, ...response }, window.location.origin);
    };

    if (method !== "getPublicKey" && method !== "signEvent") {
      respond({ ok: false, error: `Unsupported method: ${method}` });
      return;
    }

    chrome.runtime.sendMessage({ type: method === "getPublicKey" ? "pubkey" : "signEvent", ...args }, (reply) => {
      const error = chrome.runtime.lastError;
      if (error) {
        respond({ ok: false, error: error.message });
        return;
      }
      respond(reply ?? { ok: false, error: "No response from signer" });
    });
  });
})();