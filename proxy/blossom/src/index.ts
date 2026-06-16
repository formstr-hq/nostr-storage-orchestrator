import express from 'express';
import { PrismaClient } from "./generated/prisma/client.js";
import { getNpub } from './nostr.js';
import { uploadBlob } from './servers.js';
import { PLAN_CONFIG } from './plan.js';
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from 'dotenv';
import { downloadBlob } from './servers.js';

dotenv.config();
const app = express();
app.use(express.raw({
  type: "application/octet-stream",
}));
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({
  adapter,
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
    const user = await prisma.user.upsert({
      where: { npub },
      update: {},
      create: {
        npub,
      },
      select: {
        usedStorage: true,
        plan: true,
      },
    });
    console.log(user);


    const limit =
      PLAN_CONFIG[user.plan as keyof typeof PLAN_CONFIG].storageLimit;
    console.log(limit);
    res.json({
      used: Number(user.usedStorage),
      total: limit,
      available:
        limit - Number(user.usedStorage),
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

    const user = await prisma.user.upsert({
      where: { npub },
      update: {},
      create: { npub },
    });

    const planConfig =
      PLAN_CONFIG[
        user.plan as keyof typeof PLAN_CONFIG
      ];
    
    const replicaCount = planConfig.replicaCount;
    if (
      Number(user.usedStorage) + size >
      planConfig.storageLimit
    ) {
      return res.status(403).json({
        error: "Storage limit exceeding while uploading this file. Please upgrade your plan to upload this file.",
      });
    }

    if (size > planConfig.uploadLimit) {
      return res.status(403).json({
        error: "File exceeds upload limit. Please upgrade your plan to upload this file.",
      });
    }

    const result = await uploadBlob(data, authHeader, replicaCount);

    const existing =
      await prisma.blob.findUnique({
        where: {
          hash: result.hash,
        },
      });

    if (!existing) {
      await prisma.$transaction([
        prisma.blob.create({
          data: {
            hash: result.hash,
            npub,
            size,
            replicas: result.replicas,
          },
        }),

        prisma.user.update({
          where: { npub },
          data: {
            usedStorage: {
              increment: size,
            },
          },
        }),
      ]);
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

    const blob = await prisma.blob.findUnique({
      where: { hash },
    });
 
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
      hash,
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

    const blob = await prisma.blob.findUnique({
      where: { hash },
    });

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

    await prisma.$transaction([
      prisma.blob.delete({
        where: { hash },
      }),
      prisma.user.update({
        where: { npub },
        data: {
          usedStorage: {
            decrement: Number(blob.size),
          },
        },
      }),
    ]);

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

app.listen(1000, () => {
    console.log('Blossom Server is running on port 1000');
})