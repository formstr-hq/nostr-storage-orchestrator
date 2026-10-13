import { createHash } from "node:crypto";
import type { NextFunction } from "express";
import express, { type Express, type Request, type Response } from "express";
import {
  DbClient,
  DbApiError,
  type EntitlementRequest,
  type UserInfo,
} from "@orchestrator/db-client";
import { loadLifecycleConfig, type LifecycleConfig } from "@orchestrator/lifecycle";
import { AuthError, verifyAuthToken } from "./nostr.js";
import { Nip98Error, verifyNip98 } from "@orchestrator/nip98";
import { uploadBlob, serverRegistry, openBlobStream, deleteBlob } from "./servers.js";
import { createAccessCache, withAccess, STATUS_ERROR_CODES } from "./access.js";
import { createAdminIdentity, createInternalRoleGate, requireAdmin } from "./admin-auth.js";
import { clientIp, createRateLimiter } from "./rate-limit.js";
import cors from "cors";

export const lifecycleConfig: LifecycleConfig = loadLifecycleConfig();

// db-api always runs on the same host (both are host-networked in Docker,
// see docker-compose.yml), so this is derived from its port rather than
// duplicated as its own var — override DB_API_URL directly if that ever
// stops being true.
const db = new DbClient({
  baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
  ...(process.env.SERVICE_NSEC
    ? { serviceNsec: process.env.SERVICE_NSEC }
    : {}),
});

// Per-owner access cache. Entitlement changes are day-scale, and this only
// avoids a db-api read per upload; upload/delete invalidate it and the upload
// deny path re-reads, so a purchase is effective immediately. Ten seconds
// bounds how long an out-of-band change (admin/backend write) can look stale.
// Disabled under test so state changes take effect deterministically.
const accessCache = createAccessCache({
  db,
  ttlMs: process.env["NODE_ENV"] === "test" ? 0 : 10_000,
});

const adminIdentity = createAdminIdentity({
  backendUrl: process.env.FORMSTR_BACKEND_URL,
  serviceNsec: process.env.STORAGE_SERVICE_NSEC,
});

// Internal service endpoints are gated by NIP-98 + an enabled service_account
// row in db-api, not a shared token (same model as the backend's internal
// APIs). They exist so service callers (formstr-backend, the notifier) never
// talk to db-api directly: db-api is only reachable on the orchestrator's
// internal network.
const requireInternalRole = createInternalRoleGate({ db });

// Operator per-file hard cap, not a plan feature (the plan sells total
// allowance only). Its job is resource-exhaustion protection: it bounds how
// much a single request can buffer in the proxy, so Express never buffers an
// unbounded body. BUD-06 lets clients preflight it.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const UPGRADE_URL = "/pricing";

const app: Express = express();
// Behind a TLS-terminating proxy in production; trust the first hop so
// req.protocol/req.ip reflect the client.
app.set("trust proxy", 1);

// Public storage endpoint: CORS is deliberately open to all origins. It is
// not an auth boundary — requests are authorized by the signed
// `Authorization: Nostr …` header, which a browser only attaches to the origin
// it is actually talking to. No cookies are used, so `*` is safe.
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-SHA-256",
      "X-Content-Length",
      "X-Internal-Token",
      "Content-Length",
    ],
    exposedHeaders: ["X-Reason"],
    maxAge: 86400,
  }),
);

// Liveness/readiness. `providers` is the current active roster size, so
// deploy tooling and the smoke harness can wait for a registered backend
// instead of guessing at the poll interval.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    providers: serverRegistry.candidates().length,
    uptime: Math.floor(process.uptime()),
  });
});

// Request ids + structured access logs.
app.use((req, res, next) => {
  const id =
    req.header("x-request-id") ??
    createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
  res.setHeader("X-Request-Id", id);
  const started = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        requestId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      }),
    );
  });
  next();
});

// Fixed-window per-IP limits. Single-instance only, like the NIP-98 replay
// cache; scaling the proxy horizontally needs a shared store.
const RATE_WINDOW_MS = 60_000;
const uploadLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 30 });
const accountLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 120 });
const adminLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 60 });

// The raw body parser is attached to PUT /upload only, behind `uploadGate`, so
// nothing is buffered for a caller who has not proven who they are and that
// they may store this many bytes.
const rawUpload = express.raw({ type: "application/octet-stream", limit: MAX_UPLOAD_BYTES });

// sha256 hex string, optionally followed by a file extension (BUD-01).
const HASH_PATTERN = /^([a-f0-9]{64})(?:\.[a-zA-Z0-9]+)?$/;
// Explicit hash route, so the SPA catch-all cannot swallow /dashboard etc.
const HASH_ROUTE = /^\/[a-f0-9]{64}(?:\.[a-zA-Z0-9]+)?$/;

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/octet-stream": ".bin",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "text/plain": ".txt",
};

function extensionForType(type: string): string {
  return MIME_EXTENSIONS[type.split(";")[0]!.trim().toLowerCase()] ?? ".bin";
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendAuthError(res: Response, error: AuthError) {
  res.setHeader("X-Reason", error.message);
  return res.status(error.status).json({ error: error.message });
}

function sendAccessError(res: Response, user: UserInfo, access: ReturnType<typeof withAccess>["access"]) {
  const code =
    access.reason === "grace_over_quota"
      ? "quota_exceeded"
      : access.canUpload
        ? "quota_exceeded"
        : access.status === "UNPAID"
          ? "unpaid"
          : access.status === "CLOSED"
            ? "account_closed"
            : access.status === "GRACE"
              ? "grace_expired"
              : access.status === "WRITE_BLOCKED"
                ? "write_blocked"
                : "read_blocked";

  const overQuota = access.reason === "grace_over_quota" || access.canUpload;
  res.setHeader("X-Reason", code);
  return res.status(403).json({
    error: code,
    status: access.status,
    action: overQuota ? "delete_or_upgrade" : "upgrade",
    usedStorage: user.usedStorage,
    storageBytes: user.storageBytes,
    upgradeUrl: UPGRADE_URL,
  });
}

type LoadedAccess = { user: UserInfo; access: ReturnType<typeof withAccess>["access"] };

/**
 * A user row exists only after a purchase, so a missing row is simply an
 * unpaid account. Synthesize the same shape db-api would return so callers
 * can derive access without special-casing null.
 */
function unpaidUser(npub: string): UserInfo {
  return {
    npub,
    planExpiresAt: null,
    storageBytes: null,
    usedStorage: "0",
    createdAt: new Date(0).toISOString(),
  };
}

async function loadAccess(npub: string, fresh = false): Promise<LoadedAccess | null> {
  let user: UserInfo | null;
  if (fresh) {
    accessCache.invalidate(npub);
    user = await db.getUser(npub);
  } else {
    user = await accessCache.get(npub);
  }
  if (!user) {
    user = unpaidUser(npub);
  }
  return withAccess(user, lifecycleConfig);
}

/**
 * Re-reads the entitlement from db-api when a cached decision would deny the
 * operation. This makes a purchase effective immediately rather than after
 * the cache TTL, at the cost of one extra read only on the deny path.
 */
async function loadAccessForDenialCheck(
  npub: string,
  cached: LoadedAccess | null,
): Promise<LoadedAccess | null> {
  if (!cached || cached.access.canUpload) return cached;
  return loadAccess(npub, true);
}

// Internal: how much room the storage providers have left. NIP-98 + an enabled
// service_account row, like the rest of /internal. The UI signal is
// formstr-backend's GET /api/storage/availability, which proxies this call.
app.get("/capacity", requireInternalRole, async (_req, res) => {
  try {
    res.json(await db.getCapacity());
  } catch (error) {
    console.error("capacity lookup failed", error);
    res.status(502).json({ error: "capacity_unavailable" });
  }
});

// Current entitlement for a user, for service callers (purchase flow,
// subscription reads). 404 when the user has never purchased.
app.get("/internal/users/:npub", requireInternalRole, async (req, res) => {
  try {
    const npub = String(req.params["npub"]);
    const user = await db.getUser(npub);
    if (!user) return res.status(404).json({ error: "not_found" });
    res.json(user);
  } catch (error) {
    console.error("entitlement lookup failed", error);
    res.status(502).json({ error: "db_api_unreachable" });
  }
});

// Entitlement write from formstr-backend (paid purchase) or an operator
// service. The body is forwarded unchanged: db-api validates it, and its
// entitlement transaction is the idempotency guard for a payment hash.
app.post(
  "/internal/users/:npub/entitlement",
  express.json(),
  requireInternalRole,
  async (req, res) => {
    const npub = String(req.params["npub"]);
    try {
      const user = await db.assignEntitlement(npub, req.body as EntitlementRequest);
      accessCache.invalidate(npub);
      res.json(user);
    } catch (error) {
      if (error instanceof DbApiError) return res.status(error.status).json(error.body);
      console.error(error);
      res.status(502).json({ error: "db api failed" });
    }
  },
);

// Non-Blossom endpoint: exposes this account's entitlement/usage. Gated by
// BUD-11 so it shares one auth code path with the rest of the protocol.
app.get("/storage", async (req, res) => {
  try {
    if (!accountLimiter.hit(clientIp(req))) {
      return res.status(429).json({ error: "rate_limited" });
    }
    const npub = verifyAuthToken(req.headers.authorization, "get");
    // The dashboard lands here immediately after payment, so a cached
    // non-active state is re-read rather than shown stale.
    const cached = await loadAccess(npub);
    const loaded =
      cached && cached.access.status !== "ACTIVE" ? await loadAccess(npub, true) : cached;
    if (!loaded) {
      return res.status(500).json({ error: "Internal server error" });
    }
    const { user, access } = loaded;
    const used = Number(user.usedStorage);
    const total = user.storageBytes === null ? null : Number(user.storageBytes);

    res.json({
      used,
      total,
      available: total === null ? null : total - used,
      planExpiresAt: user.planExpiresAt,
      storageBytes: user.storageBytes,
      usedStorage: user.usedStorage,
      status: access.status,
      purgeAt: access.purgeAt?.toISOString() ?? null,
      canUpload: access.canUpload,
      canRead: access.canRead,
    });
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// BUD-06: pre-flight check before PUT /upload.
app.head("/upload", async (req, res) => {
  try {
    const xHash = firstHeader(req.headers["x-sha-256"] as string | string[] | undefined);
    const npub = verifyAuthToken(req.headers.authorization, "upload", {
      hash: xHash,
      requireHashScope: true,
    });

    const contentLengthHeader = firstHeader(
      req.headers["x-content-length"] as string | string[] | undefined,
    );
    if (!contentLengthHeader) {
      res.setHeader("X-Reason", "X-Content-Length header is required");
      return res.status(411).end();
    }

    const size = Number(contentLengthHeader);
    if (!Number.isFinite(size) || size < 0) {
      res.setHeader("X-Reason", "Invalid X-Content-Length header");
      return res.status(400).end();
    }
    if (size > MAX_UPLOAD_BYTES) {
      res.setHeader("X-Reason", "File exceeds the operator upload cap.");
      return res.status(413).end();
    }

    const cached = await loadAccess(npub);
    const loaded = await loadAccessForDenialCheck(npub, cached);
    if (!loaded) {
      res.setHeader("X-Reason", "Account lookup failed");
      return res.status(500).end();
    }
    const { user, access } = loaded;

    if (!access.canUpload) {
      res.setHeader("X-Reason", STATUS_ERROR_CODES[access.status] ?? access.status);
      return res.status(403).end();
    }
    if (user.storageBytes !== null && BigInt(user.usedStorage) + BigInt(size) > BigInt(user.storageBytes)) {
      res.setHeader("X-Reason", "quota_exceeded");
      return res.status(403).end();
    }

    return res.status(200).end();
  } catch (error) {
    if (error instanceof AuthError) {
      res.setHeader("X-Reason", error.message);
      return res.status(error.status).end();
    }
    console.error(error);
    return res.status(500).end();
  }
});

// Upload bytes currently being received. The body is held in memory until it
// has been hashed and handed to the storage nodes, so the total is capped:
// beyond it new uploads get 503 and retry, instead of the proxy running out of
// memory.
const MAX_INFLIGHT_UPLOAD_BYTES =
  Number(process.env["UPLOAD_INFLIGHT_BYTES"]) > 0
    ? Number(process.env["UPLOAD_INFLIGHT_BYTES"])
    : 8 * 1024 * 1024 * 1024;
let inflightUploadBytes = 0;

/**
 * Runs before the body is read. Rate limit, a valid upload token, a known
 * Content-Length, plan state and quota (for that length) are all decided from
 * headers, so an unauthenticated or unpaid caller never gets a megabyte
 * buffered. The handler still verifies the token against the real hash once the
 * body has arrived.
 */
async function uploadGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (!uploadLimiter.hit(clientIp(req))) {
      return res.status(429).json({ error: "rate_limited" });
    }
    const npub = verifyAuthToken(req.headers.authorization, "upload", { requireHashScope: true });

    const length = Number(firstHeader(req.headers["content-length"]));
    if (!firstHeader(req.headers["content-length"])) {
      res.setHeader("X-Reason", "Content-Length header is required");
      return res.status(411).json({ error: "Content-Length header is required" });
    }
    if (!Number.isInteger(length) || length <= 0) {
      return res.status(400).json({ error: "Request body must contain binary data" });
    }
    if (length > MAX_UPLOAD_BYTES) {
      res.setHeader("X-Reason", "File exceeds the operator upload cap.");
      return res.status(413).json({ error: "File exceeds the operator upload cap." });
    }

    const cached = await loadAccess(npub);
    const loaded = await loadAccessForDenialCheck(npub, cached);
    if (!loaded) return res.status(500).json({ error: "Upload failed" });
    const { user, access } = loaded;
    if (!access.canUpload) return sendAccessError(res, user, access);
    if (user.storageBytes !== null && BigInt(user.usedStorage) + BigInt(length) > BigInt(user.storageBytes)) {
      return sendAccessError(res, user, { ...access, canUpload: false, reason: "grace_over_quota" });
    }

    if (inflightUploadBytes + length > MAX_INFLIGHT_UPLOAD_BYTES) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "server_busy" });
    }
    inflightUploadBytes += length;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflightUploadBytes -= length;
    };
    res.on("close", release);
    res.on("finish", release);
    return next();
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    return res.status(500).json({ error: "Upload failed" });
  }
}

// BUD-02: PUT /upload
app.put("/upload", uploadGate, rawUpload, async (req, res) => {
  try {
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      res.setHeader("X-Reason", "Request body must contain binary data");
      return res.status(400).json({ error: "Request body must contain binary data" });
    }

    const hash = sha256Hex(data);
    const size = data.length;

    const clientHash = firstHeader(req.headers["x-sha-256"] as string | string[] | undefined);
    if (clientHash && clientHash.toLowerCase() !== hash) {
      res.setHeader("X-Reason", "X-SHA-256 header does not match the uploaded content");
      return res.status(409).json({ error: "X-SHA-256 header does not match the uploaded content" });
    }

    const authHeader = req.headers.authorization;
    const npub = verifyAuthToken(authHeader, "upload", { hash, requireHashScope: true });

    const cached = await loadAccess(npub);
    const loaded = await loadAccessForDenialCheck(npub, cached);
    if (!loaded) {
      return res.status(500).json({ error: "Upload failed" });
    }
    const { user, access } = loaded;

    if (!access.canUpload) {
      return sendAccessError(res, user, access);
    }
    if (user.storageBytes !== null && BigInt(user.usedStorage) + BigInt(size) > BigInt(user.storageBytes)) {
      return sendAccessError(res, user, {
        ...access,
        canUpload: false,
        reason: "grace_over_quota",
      });
    }

    let existing;
    try {
      existing = await db.getBlob(hash);
    } catch (error) {
      console.error("blob lookup failed", error);
      return res.status(502).json({ error: "Blob lookup failed" });
    }
    const alreadyMine = existing?.owners.includes(npub) ?? false;
    let createdAt = existing?.createdAt;

    if (!alreadyMine) {
      // Same bytes already on the nodes (another account uploaded them): reuse
      // those copies and bill this account on its own row. Otherwise store them.
      const storedNow = !existing;
      const replicas = existing ? existing.replicas : (await uploadBlob(data, hash, authHeader!, npub)).replicas;
      try {
        const created = await db.createBlob({ hash, npub, size, replicas });
        createdAt = created.createdAt;
        // usedStorage changed; drop the cached row so /storage and the next
        // quota check see it immediately.
        accessCache.invalidate(npub);
      } catch (error) {
        const reason = error instanceof DbApiError && typeof error.body === "object" && error.body !== null
          ? (error.body as { error?: string }).error
          : undefined;
        if (error instanceof DbApiError && error.status === 409 && reason === "already_exists") {
          const refetched = await db.getBlob(hash);
          createdAt = refetched?.createdAt;
        } else {
          // The bytes we just stored have no row behind them. Take them off the
          // nodes again unless someone else claimed the hash in the meantime.
          if (storedNow) {
            const claimed = await db.getBlob(hash).catch(() => null);
            if (!claimed) await deleteBlob(hash, replicas);
          }
          if (error instanceof DbApiError && error.status === 409 && reason === "quota_exceeded") {
            accessCache.invalidate(npub);
            return sendAccessError(res, user, {
              ...access,
              canUpload: false,
              reason: "grace_over_quota",
            });
          }
          throw error;
        }
      }
    }

    const contentType =
      firstHeader(req.headers["content-type"] as string | string[] | undefined) ||
      "application/octet-stream";
    const baseUrl = process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`;
    const uploaded = createdAt
      ? Math.floor(new Date(createdAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    return res.status(alreadyMine ? 200 : 201).json({
      url: `${baseUrl}/${hash}${extensionForType(contentType)}`,
      sha256: hash,
      size,
      type: contentType,
      uploaded,
    });
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    res.setHeader("X-Reason", "Upload failed");
    return res.status(500).json({ error: "Upload failed" });
  }
});

async function handleGetBlob(req: Request, res: Response, includeBody: boolean) {
  try {
    const match = HASH_PATTERN.exec(req.path.slice(1));
    if (!match) {
      return res.status(400).json({ error: "Invalid sha256 hash" });
    }
    const hash = match[1]!;

    const blob = await db.getBlob(hash);
    if (!blob) {
      return res.status(404).json({ error: "Blob not found" });
    }

    // Read gating is per-owner: a blob is readable while at least one of its
    // owners is outside READ_BLOCKED/CLOSED/UNPAID. Read fresh, never from
    // cache: this is the path that must stop serving data the moment every
    // plan lapses. Derived (not User.status) so enforcement never lags the
    // notifier.
    let owners: Array<Awaited<ReturnType<typeof db.getUser>>>;
    try {
      owners = await Promise.all((blob.owners ?? [blob.npub]).map((owner) => db.getUser(owner)));
    } catch (error) {
      console.error("owner access lookup failed", error);
      return res.status(500).json({ error: "Download failed" });
    }
    const accesses = owners.map((owner) => (owner ? withAccess(owner, lifecycleConfig).access : null));
    const readable = accesses.some((access) => access === null || access.canRead);
    if (!readable) {
      const status = accesses[0]!.status;
      res.setHeader("X-Reason", STATUS_ERROR_CODES[status] ?? status);
      return res.status(403).json({ error: STATUS_ERROR_CODES[status] });
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", blob.size);
    res.setHeader("Accept-Ranges", "bytes");

    if (!includeBody) {
      return res.status(200).end();
    }

    // Piped from the storage node, never buffered whole in the proxy.
    const stream = await openBlobStream(hash, blob.replicas);
    res.setHeader("Content-Disposition", `attachment; filename="${hash}"`);
    stream.on("error", (error) => {
      console.error("blob stream failed", error);
      res.destroy(error);
    });
    stream.pipe(res);
    return;
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    return res.status(500).json(includeBody ? { error: "Download failed" } : {});
  }
}

// BUD-01: GET /<sha256> and HEAD /<sha256>. Registered with an explicit hash
// pattern so the SPA fallback below cannot shadow blob reads.
app.get(HASH_ROUTE, (req, res) => handleGetBlob(req, res, true));
app.head(HASH_ROUTE, (req, res) => handleGetBlob(req, res, false));

// BUD-12: DELETE /<sha256>. Allowed in every state where the blob exists so a
// user can free data before purge.
app.delete(HASH_ROUTE, async (req, res) => {
  try {
    const match = HASH_PATTERN.exec(req.path.slice(1));
    if (!match) {
      return res.status(400).json({ error: "Invalid sha256 hash" });
    }
    const hash = match[1]!;

    const npub = verifyAuthToken(req.headers.authorization, "delete", {
      hash,
      requireHashScope: true,
    });

    const blob = await db.getBlob(hash);
    if (!blob) {
      return res.status(404).json({ error: "Blob not found" });
    }
    if (!(blob.owners ?? [blob.npub]).includes(npub)) {
      return res.status(403).json({ error: "You do not have access to this blob" });
    }

    // Row first, so the owner's space is freed even if a storage node is down.
    // The bytes themselves go only when no other account still owns the blob.
    const removed = await db.deleteBlob(hash, { npub });
    accessCache.invalidate(npub);
    if (removed.remainingOwners === 0) {
      await deleteBlob(hash, blob.replicas);
    }

    return res.status(200).json({ message: "Blob deleted successfully" });
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// ── Account API ─────────────────────────────────────────────────────────────

app.get("/account", async (req, res) => {
  try {
    const npub = verifyAuthToken(req.headers.authorization, "get");
    const user = (await db.getUser(npub)) ?? unpaidUser(npub);
    const { access } = withAccess(user, lifecycleConfig);
    res.json({
      ...user,
      status: access.status,
      canUpload: access.canUpload,
      canRead: access.canRead,
      purgeAt: access.purgeAt?.toISOString() ?? null,
    });
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/account/blobs", async (req, res) => {
  try {
    const npub = verifyAuthToken(req.headers.authorization, "list");
    const page = String(req.query["page"] ?? "1");
    const pageSize = String(req.query["pageSize"] ?? "25");
    const result = await db.listUserBlobs(npub, Number(page), Number(pageSize));
    res.json(result);
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/account/notifications", async (req, res) => {
  try {
    const npub = verifyAuthToken(req.headers.authorization, "list");
    const page = String(req.query["page"] ?? "1");
    const pageSize = String(req.query["pageSize"] ?? "25");
    const result = await db.listUserNotifications(npub, Number(page), Number(pageSize));
    res.json(result);
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Admin API (NIP-98 + unified admin) ───────────────────────────────────────

app.get("/admin/users", async (req, res) => {
  if (!adminLimiter.hit(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
  const admin = await requireAdmin(req, res, adminIdentity);
  if (!admin) return;
  try {
    const result = await db.listUsers({
      page: Number(req.query["page"] ?? 1),
      pageSize: Number(req.query["pageSize"] ?? 25),
      ...(typeof req.query["query"] === "string" ? { query: req.query["query"] } : {}),
    });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "db_api_unreachable" });
  }
});

app.get("/admin/blobs", async (req, res) => {
  if (!adminLimiter.hit(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
  const admin = await requireAdmin(req, res, adminIdentity);
  if (!admin) return;
  try {
    const result = await db.listAllBlobs({
      page: Number(req.query["page"] ?? 1),
      pageSize: Number(req.query["pageSize"] ?? 25),
      ...(typeof req.query["hash"] === "string" ? { hash: req.query["hash"] } : {}),
      ...(typeof req.query["npub"] === "string" ? { npub: req.query["npub"] } : {}),
    });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "db_api_unreachable" });
  }
});

app.get("/admin/storage-stats", async (req, res) => {
  if (!adminLimiter.hit(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
  const admin = await requireAdmin(req, res, adminIdentity);
  if (!admin) return;
  try {
    res.json(await db.storageStats());
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "db_api_unreachable" });
  }
});

app.get("/admin/audit", async (req, res) => {
  if (!adminLimiter.hit(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
  const admin = await requireAdmin(req, res, adminIdentity);
  if (!admin) return;
  try {
    res.json(
      await db.listModeration({
        page: Number(req.query["page"] ?? 1),
        pageSize: Number(req.query["pageSize"] ?? 25),
      }),
    );
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "db_api_unreachable" });
  }
});

// Manual plan grant (admin console). Plan labels/billing live in
// formstr-backend; this only writes the entitlement fields db-api enforces.
// NIP-98 action uses "upload" for writes; the payload hash covers the JSON body.
app.post("/admin/users/:npub/entitlement", express.json(), async (req, res) => {
  if (!adminLimiter.hit(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
  const admin = await requireAdmin(req, res, adminIdentity);
  if (!admin) return;
  try {
    const npub = String(req.params["npub"]);
    const user = await db.assignEntitlement(npub, { ...req.body, source: "admin" });
    accessCache.invalidate(npub);
    res.json(user);
  } catch (error) {
    if (error instanceof DbApiError) return res.status(error.status).json(error.body);
    console.error(error);
    res.status(502).json({ error: "db api failed" });
  }
});

// Moderation delete: bytes on every replica -> row -> audit -> notify owner.
app.delete("/admin/blobs/:hash", express.json(), async (req, res) => {
  if (!adminLimiter.hit(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
  const admin = await requireAdmin(req, res, adminIdentity);
  if (!admin) return;
  try {
    const hash = HASH_PATTERN.exec(String(req.params["hash"]))?.[1];
    if (!hash) return res.status(400).json({ error: "Invalid sha256 hash" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) return res.status(400).json({ error: "reason_required" });

    const blob = await db.getBlob(hash);
    if (!blob) return res.status(404).json({ error: "not_found" });

    // Every owner loses the blob (it is the content that was reported), then
    // the bytes go from every replica.
    const owners = blob.owners ?? [blob.npub];
    await db.deleteBlob(hash, { all: true });
    for (const owner of owners) accessCache.invalidate(owner);
    await deleteBlob(hash, blob.replicas);

    const actions = [];
    for (const owner of owners) {
      actions.push(await db.recordModeration({ hash, npub: owner, adminNpub: admin, reason }));
      // Best-effort owner notification; never fail the deletion on it.
      void notifyModeration(owner, hash, reason).catch((error) => {
        console.error("moderation notification failed", error);
      });
    }
    const action = actions[0];

    res.json({ deleted: true, action });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "moderation_failed" });
  }
});

/**
 * Owner notification for a moderation deletion. Both channels are attempted
 * independently and best-effort: the deletion has already happened and must
 * not fail because a mail bridge or relay is down.
 */
async function notifyModeration(npub: string, hash: string, reason: string) {
  // Log the intent once per channel up front so the dashboard history is
  // complete even when a relay or the mail bridge is unreachable.
  void Promise.all([
    db.logNotification({ npub, kind: "moderation_deleted", ref: hash, channel: "nostr" }).catch(() => undefined),
    db.logNotification({ npub, kind: "moderation_deleted", ref: hash, channel: "email" }).catch(() => undefined),
  ]);

  const [dm, email] = await Promise.all([
    sendModerationDm(npub, hash, reason),
    sendModerationEmail(npub, hash, reason),
  ]);
  if (!dm && !email) {
    console.warn(`moderation notification for ${npub} was not delivered on any channel`);
  }
}

async function sendModerationDm(npub: string, hash: string, reason: string): Promise<boolean> {
  const nsec = process.env.NOTIFY_NSEC;
  if (!nsec) return false;
  try {
    const { createDmSender } = await import("@orchestrator/notifier/dm");
    const { moderationNotification } = await import("@orchestrator/notifier/notifications");
    const relays = (process.env.NOTIFY_RELAYS ?? "wss://relay.damus.io,wss://nos.lol")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sender = createDmSender({ nsec, relays });
    if (!sender) return false;
    const notification = moderationNotification({ id: hash, hash, reason });
    await sender.send(npub, notification.title, notification.body);
    return true;
  } catch (error) {
    console.error("moderation DM failed", error);
    return false;
  }
}

async function sendModerationEmail(npub: string, hash: string, reason: string): Promise<boolean> {
  const backend = process.env.FORMSTR_BACKEND_URL;
  const serviceNsec = process.env.STORAGE_SERVICE_NSEC;
  if (!backend || !serviceNsec) return false;
  try {
    const axios = (await import("axios")).default;
    const { createNip98Signer } = await import("@orchestrator/nip98");
    const base = backend.replace(/\/$/, "");
    const path = "/api/storage/notify";
    const body = { pubkey: npub, event: "moderation", data: { hash, reason } };
    const signer = createNip98Signer(serviceNsec);
    await axios.post(`${base}${path}`, body, {
      timeout: 10_000,
      headers: { authorization: signer.header("POST", `${base}${path}`, body) },
    });
    return true;
  } catch (error) {
    console.error("moderation email failed", error);
    return false;
  }
}

// ── Internal purge ───────────────────────────────────────────────────────────

app.post("/internal/purge/:npub", requireInternalRole, async (req, res) => {
  const npub = String(req.params["npub"]);
  try {
    // Always read the first page: each pass removes what it lists. Per blob,
    // the owner's row goes first (this account's rows only, so a blob another
    // account still owns keeps its bytes) and the bytes are deleted from the
    // nodes when no owner remains.
    let purged = 0;
    for (;;) {
      const batch = await db.listUserBlobs(npub, 1, 100);
      if (batch.items.length === 0) break;
      for (const blob of batch.items) {
        const removed = await db.deleteBlob(blob.hash, { npub });
        if (removed.remainingOwners === 0) {
          await deleteBlob(blob.hash, blob.replicas);
        }
        purged += 1;
      }
    }
    accessCache.invalidate(npub);
    res.json({ purged, status: "CLOSED" });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "purge_failed" });
  }
});

// ── Console SPA ──────────────────────────────────────────────────────────────
// The console build is baked into the proxy image at packages/console/dist (see
// proxy/blossom/Dockerfile). In production nginx may serve the same dist
// directly instead; the API routes above are unaffected either way.
const consoleDist = new URL("../../../packages/console/dist", import.meta.url)
  .pathname;
app.use(express.static(consoleDist, { index: "index.html" }));
// The explicit hash route is registered above; this fallback only sees
// non-API, extension-less paths, so client-side routes work without
// swallowing blob reads.
app.get(/^\/(?!.*\.[a-zA-Z0-9]+$).*/, (_req, res) => {
  res.sendFile("index.html", { root: consoleDist }, (error) => {
    if (error) res.status(404).json({ error: "not_found" });
  });
});

const PORT = parseInt(process.env.BLOSSOM_PORT!);
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Blossom Server is running on port ${PORT}`);
  });
}

export { app };
