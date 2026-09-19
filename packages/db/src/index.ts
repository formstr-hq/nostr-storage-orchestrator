import express from "express";
import { prisma } from "./prisma.js";
import { PLAN_CONFIG } from "./plan.js";
import { blobToJson, userToJson } from "./serialize.js";
import { membersRouter } from "./routes/members.js";
import { storagesRouter } from "./routes/storages.js";

const app = express();
app.use(express.json());

function prismaErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/plans", (_req, res) => {
  res.json(PLAN_CONFIG);
});

app.use("/members", membersRouter);
app.use("/storages", storagesRouter);

app.get("/users/:npub", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { npub: req.params.npub! } });
  if (!user) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(userToJson(user));
});

app.put("/users/:npub", async (req, res) => {
  const npub = req.params.npub!;
  const user = await prisma.user.upsert({
    where: { npub },
    update: {},
    create: { npub },
  });
  res.json(userToJson(user));
});

// Must be registered before /blobs/:hash or "total" is captured as a hash.
app.get("/blobs/total", async (_req, res) => {
  const total = await prisma.blob.aggregate({ _sum: { size: true } });
  res.json({ totalSize: (total._sum.size ?? 0n).toString() });
});

app.get("/blobs/:hash", async (req, res) => {
  const blob = await prisma.blob.findUnique({ where: { hash: req.params.hash! } });
  if (!blob) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(blobToJson(blob));
});

app.post("/blobs", async (req, res) => {
  const { hash, npub, size, replicas } = req.body as {
    hash: string;
    npub: string;
    size: string | number;
    replicas: string[];
  };
  try {
    const sizeBig = BigInt(size);
    const { blob, user } = await prisma.$transaction(async (tx) => {
      await tx.user.findUniqueOrThrow({ where: { npub } });
      const blob = await tx.blob.create({
        data: { hash, npub, size: sizeBig, replicas },
      });
      const user = await tx.user.update({
        where: { npub },
        data: { usedStorage: { increment: sizeBig } },
      });
      return { blob, user };
    });
    res.status(201).json({ ...blobToJson(blob), usedStorage: user.usedStorage.toString() });
  } catch (error) {
    const code = prismaErrorCode(error);
    if (code === "P2025") {
      return res.status(404).json({ error: "user_not_found" });
    }
    if (code === "P2002") {
      return res.status(409).json({ error: "already_exists" });
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.delete("/blobs/:hash", async (req, res) => {
  const hash = req.params.hash!;
  try {
    const user = await prisma.$transaction(async (tx) => {
      const blob = await tx.blob.findUniqueOrThrow({ where: { hash } });
      await tx.blob.delete({ where: { hash } });
      return tx.user.update({
        where: { npub: blob.npub },
        data: { usedStorage: { decrement: blob.size } },
      });
    });
    res.json({ deleted: true, usedStorage: user.usedStorage.toString() });
  } catch (error) {
    if (prismaErrorCode(error) === "P2025") {
      return res.status(404).json({ error: "not_found" });
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

const PORT = parseInt(process.env.DB_API_PORT!, 10);
app.listen(PORT, () => {
  console.log(`db-api listening on port ${PORT}`);
});
