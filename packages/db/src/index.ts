import express from "express";
import { prisma } from "./prisma.js";
import { blobToJson } from "./serialize.js";
import { membersRouter } from "./routes/members.js";
import { storagesRouter } from "./routes/storages.js";
import { usersRouter } from "./routes/users.js";
import { notificationsRouter } from "./routes/notifications.js";
import { moderationRouter } from "./routes/moderation.js";
import { adminRouter } from "./routes/admin.js";
import { serviceAccountsRouter } from "./routes/service-accounts.js";

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

app.use("/members", membersRouter);
app.use("/storages", storagesRouter);

// Entitlement/account/admin routes. See
// docs/BLOSSOM_PRODUCTIONISATION_PLAN.md and src/routes/users.ts.
app.use("/users", usersRouter);
app.use("/notifications", notificationsRouter);
app.use("/moderation", moderationRouter);
app.use("/service-accounts", serviceAccountsRouter);
app.use("/", adminRouter);

// Must be registered before /blobs/:hash or "total" is captured as a hash.
app.get("/blobs/total", async (_req, res) => {
  const total = await prisma.blob.aggregate({ _sum: { size: true } });
  res.json({ totalSize: (total._sum.size ?? 0n).toString() });
});

// All owner rows for a hash. The first row stands for the blob itself (size,
// replicas and createdAt are identical across owners); `owners` lists who is
// billed for it. 404 when nobody owns it.
app.get("/blobs/:hash", async (req, res) => {
  const rows = await prisma.blob.findMany({
    where: { hash: req.params.hash! },
    orderBy: { createdAt: "asc" },
  });
  const first = rows[0];
  if (!first) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json({ ...blobToJson(first), owners: rows.map((row) => row.npub) });
});

class QuotaExceededError extends Error {}
class AlreadyExistsError extends Error {}

// Records `npub` as an owner of `hash` and bills them for it. The user row is
// locked for the whole transaction, so two uploads racing for the same user are
// checked one after the other against the real running total instead of both
// passing against the same stale number.
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
      const locked = await tx.$queryRaw<
        Array<{ used_storage: bigint; storage_bytes: bigint | null }>
      >`SELECT used_storage, storage_bytes FROM "user" WHERE npub = ${npub} FOR UPDATE`;
      const current = locked[0];
      if (!current) {
        throw Object.assign(new Error("user_not_found"), { code: "P2025" });
      }
      // Same owner uploading the same content again is a no-op, checked before
      // quota so a re-upload never fails for being "over".
      const dup = await tx.blob.findUnique({ where: { hash_npub: { hash, npub } } });
      if (dup) throw new AlreadyExistsError();
      if (
        current.storage_bytes !== null &&
        current.used_storage + sizeBig > current.storage_bytes
      ) {
        throw new QuotaExceededError();
      }
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
    if (error instanceof QuotaExceededError) {
      return res.status(409).json({ error: "quota_exceeded" });
    }
    if (error instanceof AlreadyExistsError) {
      return res.status(409).json({ error: "already_exists" });
    }
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

// Removes ownership rows for a hash and gives each owner their bytes back.
// `?npub=` removes one owner's row; `?all=true` (moderation) removes every
// owner. `remainingOwners` tells the caller whether the bytes on the storage
// nodes are still needed.
app.delete("/blobs/:hash", async (req, res) => {
  const hash = req.params.hash!;
  const npub = typeof req.query["npub"] === "string" ? req.query["npub"] : undefined;
  const all = req.query["all"] === "true";
  if (!npub && !all) {
    return res.status(400).json({ error: "npub_or_all_required" });
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.blob.findMany({
        where: { hash, ...(all ? {} : { npub: npub! }) },
      });
      if (rows.length === 0) throw Object.assign(new Error("not_found"), { code: "P2025" });
      let lastUsed = "0";
      for (const row of rows) {
        await tx.blob.delete({ where: { hash_npub: { hash, npub: row.npub } } });
        const user = await tx.user.update({
          where: { npub: row.npub },
          data: { usedStorage: { decrement: row.size } },
        });
        lastUsed = user.usedStorage.toString();
      }
      const remainingOwners = await tx.blob.count({ where: { hash } });
      return { usedStorage: lastUsed, remainingOwners };
    });
    res.json({ deleted: true, ...result });
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
