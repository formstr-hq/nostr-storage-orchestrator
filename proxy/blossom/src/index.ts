import express from 'express';
import { DbClient, DbApiError } from "@orchestrator/db-client";
import { getNpub } from './nostr.js';
import { uploadBlob } from './servers.js';
import { getPlanConfig } from './plan.js';
import { downloadBlob } from './servers.js';
import cors from 'cors';

const app = express();
app.use(cors({
  origin: "*",
}));

app.use(express.raw({
  type: "application/octet-stream",
  limit: "1gb",
}));

const db = new DbClient({
  baseUrl: process.env.DB_API_URL ?? "http://localhost:4000",
});

app.get("/storage", async (req, res) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const npub = getNpub(
      req.headers.authorization
    );

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
    console.error(error);

    res.status(500).json({
      error: "Internal server error",
    });
  }
});

app.post("/upload", async (req, res) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }
    const authHeader = req.headers.authorization;
    const npub = getNpub(authHeader);

    const data = req.body as Buffer;
    const size = data.length;

    const user = await db.upsertUser(npub);
    const planConfig = await getPlanConfig(db);
    const limits = planConfig[user.plan];

    const replicaCount = limits.replicaCount;
    if (
      Number(user.usedStorage) + size >
      limits.storageLimit
    ) {
      return res.status(403).json({
        error: "Storage limit exceeding while uploading this file. Please upgrade your plan to upload this file.",
      });
    }

    if (size > limits.uploadLimit) {
      return res.status(403).json({
        error: "File exceeds upload limit. Please upgrade your plan to upload this file.",
      });
    }

    const result = await uploadBlob(data, authHeader, replicaCount);

    const existing = await db.getBlob(result.hash);

    if (!existing) {
      try {
        await db.createBlob({
          hash: result.hash,
          npub,
          size,
          replicas: result.replicas,
        });
      } catch (error) {
        if (!(error instanceof DbApiError && error.status === 409)) {
          throw error;
        }
      }
    }

    return res.json({
      hash: result.hash,
      replicas: result.replicas,
      size,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Upload failed",
    });
  }
});

app.get("/download/:hash", async (req, res) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }
    const authHeader = req.headers.authorization;
    const npub = getNpub(authHeader);

    const { hash } = req.params;

    const blob = await db.getBlob(hash!);

    if (!blob) {
      return res.status(404).json({
        error: "Blob not found",
      });
    }

    if (blob.npub !== npub) {
      return res.status(403).json({
        error: "You do not have access to this blob",
      });
    }

    const data = await downloadBlob(
      hash!,
      blob.replicas
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${hash}"`
    );
    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );
    res.send(data);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Download failed",
    });
  }
});


app.delete("/delete/:hash", async (req, res) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }
    const authHeader = req.headers.authorization;
    const npub = getNpub(authHeader);

    const { hash } = req.params;

    const blob = await db.getBlob(hash!);

    if (!blob) {
      return res.status(404).json({
        error: "Blob not found",
      });
    }

    if (blob.npub !== npub) {
      return res.status(403).json({
        error: "You do not have access to this blob",
      });
    }

    await db.deleteBlob(hash!);

    return res.json({
      message: "Blob deleted successfully",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Delete failed",
    });
  }
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
app.listen(PORT, () => {
    console.log(`Blossom Server is running on port ${PORT}`);
})
