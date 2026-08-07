/// <reference lib="webworker" />
/**
 * Crypto worker for the web build.
 *
 * This worker owns the wasm instance, and therefore the decrypted key: nothing
 * on the main thread ever holds it, and an unlock's scrypt work (log_n 16, tens
 * of MiB and a second or more) cannot block the page. It is the browser
 * counterpart of the native build's `spawn_blocking`.
 *
 * It also performs the HTTP itself, because a request must be sent exactly as
 * `admin-core` signed it — sending is the last step of an operation, not a
 * separate concern the main thread could get wrong.
 */
import init, {
  Session,
  deviceResponse,
  generateHostKey,
  importNsec,
  inviteResponse,
  normalizeHostUrl,
  statusResponse,
  transportError,
  type SignedRequest,
} from "../wasm/pkg/admin_wasm.js";
import wasmUrl from "../wasm/pkg/admin_wasm_bg.wasm?url";

import type { WorkerReady, WorkerRequest, WorkerResponse } from "./protocol";

/** Matches the native client's `REQUEST_TIMEOUT`. */
const REQUEST_TIMEOUT_MS = 20_000;

const scope = self as unknown as DedicatedWorkerGlobalScope;

let session: Session | null = null;

/**
 * Send a signed request verbatim.
 *
 * `redirect: "error"` is the browser equivalent of the native client's
 * `Policy::none()`: following a redirect would replay a NIP-98 authorization
 * against a URL it was not signed for. `credentials: "omit"` keeps ambient
 * cookies out of a request whose only legitimate authority is the signature.
 */
async function send(request: SignedRequest): Promise<[number, Uint8Array]> {
  const headers: Record<string, string> = {
    Authorization: request.authorization,
  };
  const body = request.body;
  if (body) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers,
      body: body ? (body as BodyInit) : null,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(transportError());
  }

  const buffer = await response.arrayBuffer().catch(() => {
    throw new Error(transportError());
  });
  return [response.status, new Uint8Array(buffer)];
}

/** Build, send, and free a signed request in one step. */
async function exchange(
  build: (active: Session) => Promise<SignedRequest>,
): Promise<[number, Uint8Array]> {
  if (!session) throw new Error("Host is locked. Unlock it to continue");
  const request = await build(session);
  try {
    return await send(request);
  } finally {
    // wasm-bindgen objects are not garbage collected for us.
    request.free();
  }
}

function lock(): void {
  const active = session;
  session = null;
  active?.free();
}

async function handle(message: WorkerRequest): Promise<unknown> {
  switch (message.method) {
    case "normalizeHostUrl":
      return normalizeHostUrl(...message.args);

    case "generateHostKey":
      return generateHostKey(...message.args);

    case "importNsec":
      return importNsec(...message.args);

    case "unlockHost": {
      const [{ hostUrl, ncryptsec, passphrase }] = message.args;
      // Replace any previous session only once the new one exists, so a failed
      // unlock never silently locks a working host.
      const opened = Session.open(hostUrl, ncryptsec, passphrase);
      lock();
      session = opened;
      return opened.unlockResult();
    }

    case "lockHost":
      lock();
      return undefined;

    case "status": {
      const [code, body] = await exchange((active) => active.statusRequest());
      return statusResponse(code, body);
    }

    case "generateInvite": {
      const [code, body] = await exchange((active) => active.inviteRequest());
      return inviteResponse(code, body);
    }

    case "addDevice": {
      const [npub] = message.args;
      const [code, body] = await exchange((active) => active.deviceRequest(npub));
      return deviceResponse(code, body);
    }

    case "removeDevice": {
      const [npub] = message.args;
      const [code, body] = await exchange((active) =>
        active.deviceRemovalRequest(npub),
      );
      return deviceResponse(code, body);
    }
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The operation could not be completed";
}

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void handle(request).then(
    (value) => scope.postMessage({ id: request.id, ok: true, value } satisfies WorkerResponse),
    (error: unknown) =>
      scope.postMessage({
        id: request.id,
        ok: false,
        error: errorMessage(error),
      } satisfies WorkerResponse),
  );
});

init({ module_or_path: wasmUrl }).then(
  () => scope.postMessage({ ready: true } satisfies WorkerReady),
  (error: unknown) =>
    scope.postMessage({
      ready: false,
      error: errorMessage(error),
    } satisfies WorkerReady),
);
