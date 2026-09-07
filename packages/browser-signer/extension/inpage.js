"use strict";
(() => {
  // src/content/inpage.ts
  (function() {
    "use strict";
    if (window.__formstrSigner) return;
    window.__formstrSigner = true;
    const pending = /* @__PURE__ */ new Map();
    let nextId = 1;
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== "formstr-signer-response") return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      const reply = data;
      if (reply.ok) entry.resolve(reply.data);
      else entry.reject(new Error(reply.error ?? "signer error"));
    });
    function call(method, args) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        window.postMessage({ type: "formstr-signer-request", id, method, args }, window.location.origin);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error("Signer request timed out"));
          }
        }, 3e4);
      });
    }
    window.nostr = {
      getPublicKey: () => call("getPublicKey"),
      signEvent: (event) => call("signEvent", { event })
    };
  })();
})();
