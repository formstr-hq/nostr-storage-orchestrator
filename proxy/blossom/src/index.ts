import { createHash } from "node:crypto";
import express, { type Request, type Response } from 'express';
import { DbClient, DbApiError } from "@orchestrator/db-client";
import { verifyAuthToken, AuthError } from './nostr.js';
import { uploadBlob } from './servers.js';
import { getPlanConfig } from './plan.js';
import { downloadBlob, deleteBlob } from './servers.js';
import cors from 'cors';

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "HEAD", "PUT", "DELETE"],
  allowedHeaders: ["Authorization", "*"],
  exposedHeaders: ["X-Reason"],
  maxAge: 86400,
}));

app.use(express.raw({
  type: "application/octet-stream",
  limit: "1gb",
}));

// db-api always runs on the same host (both are host-networked in Docker,
// see docker-compose.yml), so this is derived from its port rather than
// duplicated as its own var — override DB_API_URL directly if that ever
// stops being true.
const db = new DbClient({
  baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
});

// sha256 hex string, optionally followed by a file extension (BUD-01).
const HASH_PATTERN = /^([a-f0-9]{64})(?:\.[a-zA-Z0-9]+)?$/;

// Minimal MIME -> extension map so upload responses can satisfy BUD-02's
// "url field MUST include a file extension" requirement without an extra
// dependency. Unknown types fall back to `.bin`, matching the BUD-01
// guidance for blobs of unknown type.
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

// Non-Blossom endpoint: exposes this account's plan/usage. Kept outside the
// BUDs (there is no equivalent), gated the same way as every other endpoint
// via a BUD-11 token so it shares one auth code path.
app.get("/storage", async (req, res) => {
  try {
    const npub = verifyAuthToken(req.headers.authorization, "get");

    const user = await db.upsertUser(npub);
    const planConfig = await getPlanConfig(db);
    const limit = planConfig[user.plan].storageLimit;
    const used = Number(user.usedStorage);

    res.json({
      used,
      total: limit,
      available:
        limit - used,
      plan: user.plan,
    });

  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);

    res.status(500).json({
      error: "Internal server error",
    });
  }
});

// BUD-06: pre-flight check before PUT /upload.
app.head("/upload", async (req, res) => {
  try {
    const xHash = firstHeader(req.headers["x-sha-256"] as string | string[] | undefined);
    const npub = verifyAuthToken(req.headers.authorization, "upload", { hash: xHash, requireHashScope: true });

    const contentLengthHeader = firstHeader(req.headers["x-content-length"] as string | string[] | undefined);
    if (!contentLengthHeader) {
      res.setHeader("X-Reason", "X-Content-Length header is required");
      return res.status(411).end();
    }

    const size = Number(contentLengthHeader);
    if (!Number.isFinite(size) || size < 0) {
      res.setHeader("X-Reason", "Invalid X-Content-Length header");
      return res.status(400).end();
    }

    const user = await db.upsertUser(npub);
    const planConfig = await getPlanConfig(db);
    const limits = planConfig[user.plan];

    if (Number(user.usedStorage) + size > limits.storageLimit) {
      res.setHeader("X-Reason", "Storage limit exceeding while uploading this file.");
      return res.status(403).end();
    }
    if (size > limits.uploadLimit) {
      res.setHeader("X-Reason", "File exceeds upload limit.");
      return res.status(413).end();
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

// BUD-02: PUT /upload
app.put("/upload", async (req, res) => {
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

    const user = await db.upsertUser(npub);
    const planConfig = await getPlanConfig(db);
    const limits = planConfig[user.plan];

    if (Number(user.usedStorage) + size > limits.storageLimit) {
      res.setHeader("X-Reason", "Storage limit exceeding while uploading this file.");
      return res.status(403).json({
        error: "Storage limit exceeding while uploading this file. Please upgrade your plan to upload this file.",
      });
    }
    if (size > limits.uploadLimit) {
      res.setHeader("X-Reason", "File exceeds upload limit.");
      return res.status(403).json({
        error: "File exceeds upload limit. Please upgrade your plan to upload this file.",
      });
    }

    const existing = await db.getBlob(hash);
    let createdAt = existing?.createdAt;

    if (!existing) {
      const result = await uploadBlob(data, hash, authHeader!, limits.replicaCount);
      try {
        const created = await db.createBlob({
          hash,
          npub,
          size,
          replicas: result.replicas,
        });
        createdAt = created.createdAt;
      } catch (error) {
        if (error instanceof DbApiError && error.status === 409) {
          const refetched = await db.getBlob(hash);
          createdAt = refetched?.createdAt;
        } else {
          throw error;
        }
      }
    }

    const contentType = firstHeader(req.headers["content-type"] as string | string[] | undefined) || "application/octet-stream";
    const baseUrl = process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`;
    const uploaded = createdAt
      ? Math.floor(new Date(createdAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    return res.status(existing ? 200 : 201).json({
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
    return res.status(500).json({
      error: "Upload failed",
    });
  }
});

async function handleGetBlob(req: Request, res: Response, includeBody: boolean) {
  try {
    const match = HASH_PATTERN.exec((req.params.hashWithExt as string));
    if (!match) {
      return res.status(400).json({ error: "Invalid sha256 hash" });
    }
    const hash = match[1]!;

    const npub = verifyAuthToken(req.headers.authorization, "get", { hash });

    const blob = await db.getBlob(hash);
    if (!blob) {
      return res.status(404).json({ error: "Blob not found" });
    }
    if (blob.npub !== npub) {
      return res.status(403).json({ error: "You do not have access to this blob" });
    }

    // The proxy does not persist the original MIME type, so per BUD-01 it
    // MUST default to application/octet-stream here.
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", blob.size);
    res.setHeader("Accept-Ranges", "bytes");

    if (!includeBody) {
      return res.status(200).end();
    }

    const data = await downloadBlob(hash, blob.replicas);
    res.setHeader("Content-Disposition", `attachment; filename="${hash}"`);
    return res.send(data);
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);
    return res.status(500).json(includeBody ? { error: "Download failed" } : {});
  }
}

// BUD-01: GET /<sha256> and HEAD /<sha256>
app.get("/:hashWithExt", (req, res) => handleGetBlob(req, res, true));
app.head("/:hashWithExt", (req, res) => handleGetBlob(req, res, false));

// BUD-12: DELETE /<sha256>
app.delete("/:hashWithExt", async (req, res) => {
  try {
    const match = HASH_PATTERN.exec((req.params.hashWithExt as string));
    if (!match) {
      return res.status(400).json({ error: "Invalid sha256 hash" });
    }
    const hash = match[1]!;

    const npub = verifyAuthToken(req.headers.authorization, "delete", { hash, requireHashScope: true });

    const blob = await db.getBlob(hash);
    if (!blob) {
      return res.status(404).json({ error: "Blob not found" });
    }
    if (blob.npub !== npub) {
      return res.status(403).json({ error: "You do not have access to this blob" });
    }

    await deleteBlob(hash, blob.replicas);
    await db.deleteBlob(hash);

    return res.status(200).json({
      message: "Blob deleted successfully",
    });
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error(error);

    return res.status(500).json({
      error: "Delete failed",
    });
  }
});

const PORT = parseInt(process.env.BLOSSOM_PORT!);
app.listen(PORT, () => {
    console.log(`Blossom Server is running on port ${PORT}`);
})
