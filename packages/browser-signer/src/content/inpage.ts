/**
 * MAIN-world inpage script: exposes window.nostr (NIP-07) to the page.
 *
 * It holds NO keys and does NO trust decisions — it only forwards calls to
 * the extension via postMessage and relays responses back. Requests carry a
 * random request id; responses are matched by id.
 */
(function () {
  "use strict";
  if (window.__formstrSigner) return;
  window.__formstrSigner = true;

  const pending = new Map();
  let nextId = 1;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== "formstr-signer-response") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    const reply = data as Reply;
    if (reply.ok) entry.resolve(reply.data);
    else entry.reject(new Error(reply.error ?? "signer error"));
  });

  type Reply = { ok: boolean; data?: unknown; error?: string };

  function call(method: string, args?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      window.postMessage({ type: "formstr-signer-request", id, method, args }, window.location.origin);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("Signer request timed out"));
        }
      }, 30_000);
    });
  }

  window.nostr = {
    getPublicKey: () => call("getPublicKey") as Promise<string>,
    signEvent: (event: unknown) => call("signEvent", { event }) as Promise<unknown>,
  };
})();