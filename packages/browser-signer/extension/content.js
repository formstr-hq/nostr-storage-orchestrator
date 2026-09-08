"use strict";
(() => {
  // src/content/relay.ts
  (function() {
    "use strict";
    const inpage = document.createElement("script");
    inpage.src = chrome.runtime.getURL("inpage.js");
    inpage.type = "module";
    (document.head || document.documentElement).prepend(inpage);
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== "formstr-signer-request") return;
      const { id, method, args } = data;
      const respond = (response) => {
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
})();
