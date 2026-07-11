import express from "express";
import { prisma } from "./prisma.js";
import { PLAN_CONFIG } from "./plan.js";
import { blobToJson, relayEventToJson, userToJson } from "./serialize.js";

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

app.get("/relay-events/:eventId", async (req, res) => {
  const relayEvent = await prisma.relayEvent.findUnique({ where: { eventId: req.params.eventId! } });
  if (!relayEvent) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(relayEventToJson(relayEvent));
});

app.post("/relay-events", async (req, res) => {
  const { eventId, npub, kind, size } = req.body as {
    eventId: string;
    npub: string;
    kind: number;
    size: string | number;
  };
  try {
    const sizeBig = BigInt(size);
    const { relayEvent, user } = await prisma.$transaction(async (tx) => {
      await tx.user.findUniqueOrThrow({ where: { npub } });
      const relayEvent = await tx.relayEvent.create({
        data: { eventId, npub, kind, size: sizeBig, replicas: [] },
      });
      const user = await tx.user.update({
        where: { npub },
        data: { usedStorage: { increment: sizeBig } },
      });
      return { relayEvent, user };
    });
    res.status(201).json({ ...relayEventToJson(relayEvent), usedStorage: user.usedStorage.toString() });
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

app.post("/relay-events/:eventId/rollback", async (req, res) => {
  const eventId = req.params.eventId!;
  try {
    const existing = await prisma.$transaction(async (tx) => {
      const existing = await tx.relayEvent.findUnique({ where: { eventId } });
      if (!existing) {
        return null;
      }
      await tx.relayEvent.delete({ where: { eventId } });
      await tx.user.update({
        where: { npub: existing.npub },
        data: { usedStorage: { decrement: existing.size } },
      });
      return existing;
    });
    res.json({ rolledBack: existing !== null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.patch("/relay-events/:eventId", async (req, res) => {
  const eventId = req.params.eventId!;
  const { replicas } = req.body as { replicas: string[] };
  try {
    await prisma.relayEvent.update({ where: { eventId }, data: { replicas } });
    res.json({ updated: true });
  } catch (error) {
    if (prismaErrorCode(error) === "P2025") {
      return res.status(404).json({ error: "not_found" });
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

// NOTE: intentionally does not decrement usedStorage — preserves pre-existing
// relay kind-5 deletion behavior from before the db-api split.
app.delete("/relay-events/:eventId", async (req, res) => {
  const eventId = req.params.eventId!;
  try {
    await prisma.relayEvent.delete({ where: { eventId } });
    res.json({ deleted: true });
  } catch (error) {
    if (prismaErrorCode(error) === "P2025") {
      return res.status(404).json({ error: "not_found" });
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

const PORT = parseInt(process.env.DB_API_PORT ?? process.env.PORT ?? "4000", 10);
app.listen(PORT, () => {
  console.log(`db-api listening on port ${PORT}`);
});
