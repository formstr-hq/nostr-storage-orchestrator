import { Router, type Router as ExpressRouter } from "express";
import { StorageLifecycle, prisma, type Prisma } from "../prisma.js";
import { storageProviderToJson } from "../serialize.js";

export const storagesRouter: ExpressRouter = Router();

const ACTIVE_WINDOW_SECS = positiveNumber(process.env.STORAGE_ACTIVE_WINDOW_SECS, 960);

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBigInt(value: unknown): bigint | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("invalid_bigint");
  }
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new Error("invalid_bigint");
  }
  return BigInt(value);
}

function parseOptionalPort(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : NaN;
}

function parseOptionalDate(value: unknown): Date | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

storagesRouter.get("/active", async (_req, res) => {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_SECS * 1000);
  const storages = await prisma.storageProvider.findMany({
    where: {
      lifecycle: StorageLifecycle.LINKED,
      lastPingAt: { gt: cutoff },
      tunnelIp: { not: null },
      blossomPort: { not: null },
    },
  });
  res.json(storages.map(storageProviderToJson));
});

// Mesh-PG providers: active storages that also expose a pg-agent. The
// pg-gateway polls this instead of /storages/active so providers without a
// postgres stack never enter the mesh-PG placement pool.
storagesRouter.get("/active-pg", async (_req, res) => {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_SECS * 1000);
  const storages = await prisma.storageProvider.findMany({
    where: {
      lifecycle: StorageLifecycle.LINKED,
      lastPingAt: { gt: cutoff },
      tunnelIp: { not: null },
      blossomPort: { not: null },
      pgAgentPort: { not: null },
    },
  });
  res.json(storages.map(storageProviderToJson));
});

// Capacity for new signups. Sums the free space the active providers last
// reported. Every blob is stored on up to BLOSSOM_REPLICAS providers, so the
// room for *new* data is the free space divided by the replica count (never
// more replicas than there are providers). New buyers are turned away once that
// drops below SIGNUPS_MIN_FREE_BYTES; existing users can always renew. With
// SIGNUPS_COUNT_COMMITMENTS=true the unused part of every live allowance is
// subtracted too, so the service cannot sell more than it can hold.
storagesRouter.get("/capacity", async (_req, res) => {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_SECS * 1000);
  const providers = await prisma.storageProvider.findMany({
    where: {
      lifecycle: StorageLifecycle.LINKED,
      lastPingAt: { gt: cutoff },
      tunnelIp: { not: null },
      blossomPort: { not: null },
    },
    select: { reportedFreeBytes: true, reportedTotalBytes: true },
  });

  let freeBytes = 0n;
  let totalBytes = 0n;
  for (const provider of providers) {
    freeBytes += provider.reportedFreeBytes ?? 0n;
    totalBytes += provider.reportedTotalBytes ?? 0n;
  }

  const configuredReplicas = Math.max(1, Math.floor(positiveNumber(process.env.BLOSSOM_REPLICAS, 2)));
  const replicas = Math.max(1, Math.min(configuredReplicas, providers.length));
  const rawAvailable = providers.length === 0 ? 0n : freeBytes / BigInt(replicas);

  let committedBytes = 0n;
  const committed = await prisma.$queryRaw<Array<{ committed: bigint | null }>>`
    SELECT COALESCE(SUM(GREATEST(storage_bytes - used_storage, 0)), 0)::bigint AS committed
    FROM "user"
    WHERE plan_expires_at > now() AND storage_bytes IS NOT NULL`;
  committedBytes = committed[0]?.committed ?? 0n;

  const countCommitments = process.env.SIGNUPS_COUNT_COMMITMENTS === "true";
  const available = countCommitments
    ? rawAvailable > committedBytes ? rawAvailable - committedBytes : 0n
    : rawAvailable;
  const minFree = BigInt(Math.floor(positiveNumber(process.env.SIGNUPS_MIN_FREE_BYTES, 1_073_741_824)));

  res.json({
    providers: providers.length,
    replicas,
    totalBytes: totalBytes.toString(),
    freeBytes: freeBytes.toString(),
    committedBytes: committedBytes.toString(),
    availableBytes: available.toString(),
    minFreeBytes: minFree.toString(),
    signupsOpen: providers.length > 0 && available >= minFree,
  });
});

// One-shot internal migration helper. Unknown URLs remain untouched so no
// durable replica pointer is lost when it cannot be attributed safely.
storagesRouter.post("/backfill-replicas", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as { dryRun?: unknown } : {};
  const dryRun = body.dryRun ?? false;
  if (typeof dryRun !== "boolean") {
    return res.status(400).json({ error: "invalid_dry_run" });
  }

  const storages = await prisma.storageProvider.findMany();
  const aliases = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  const addAlias = (url: string, npub: string) => {
    const existing = aliases.get(url);
    if (existing && existing !== npub) {
      aliases.delete(url);
      ambiguousAliases.add(url);
    } else if (!ambiguousAliases.has(url)) {
      aliases.set(url, npub);
    }
  };
  for (const storage of storages) {
    if (!storage.tunnelIp) continue;
    if (storage.blossomPort !== null) {
      addAlias(`http://${storage.tunnelIp}:${storage.blossomPort}`, storage.npub);
      addAlias(`https://${storage.tunnelIp}:${storage.blossomPort}`, storage.npub);
    }
  }

  let changedRows = 0;
  let replacedValues = 0;
  let unmatchedValues = 0;
  const updates: Array<ReturnType<typeof prisma.blob.updateMany>> = [];
  const rewrite = (replicas: string[]) => replicas.map((replica) => {
    if (!/^https?:\/\//i.test(replica) && !/^wss?:\/\//i.test(replica)) return replica;
    const replacement = aliases.get(normalizeUrl(replica));
    if (!replacement) {
      unmatchedValues += 1;
      return replica;
    }
    replacedValues += 1;
    return replacement;
  });

  const blobs = await prisma.blob.findMany({
    select: { hash: true, replicas: true },
    distinct: ["hash"],
  });
  for (const blob of blobs) {
    const replicas = rewrite(blob.replicas);
    if (replicas.some((value, index) => value !== blob.replicas[index])) {
      changedRows += 1;
      if (!dryRun) updates.push(prisma.blob.updateMany({ where: { hash: blob.hash }, data: { replicas } }));
    }
  }
  if (updates.length > 0) await prisma.$transaction(updates);
  if (unmatchedValues > 0) console.warn(`Replica backfill retained ${unmatchedValues} unmatched URL values`);
  res.json({ dryRun, changedRows, replacedValues, unmatchedValues });
});

storagesRouter.get("/", async (req, res) => {
  if (req.query.ownerNpub !== undefined && typeof req.query.ownerNpub !== "string") {
    return res.status(400).json({ error: "invalid_filter" });
  }
  const storages = await prisma.storageProvider.findMany({
    where: typeof req.query.ownerNpub === "string" ? { ownerNpub: req.query.ownerNpub } : {},
  });
  res.json(storages.map(storageProviderToJson));
});

storagesRouter.get("/:npub", async (req, res) => {
  const storage = await prisma.storageProvider.findUnique({ where: { npub: req.params.npub! } });
  if (!storage) return res.status(404).json({ error: "not_found" });
  res.json(storageProviderToJson(storage));
});

storagesRouter.post("/", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  if (typeof body.npub !== "string" || typeof body.ownerNpub !== "string") {
    return res.status(400).json({ error: "invalid_storage" });
  }
  try {
    const declaredCapacityBytes = parseBigInt(body.declaredCapacityBytes);
    const existing = await prisma.storageProvider.findUnique({ where: { npub: body.npub } });
    if (existing && existing.ownerNpub !== body.ownerNpub) {
      return res.status(409).json({ error: "owner_conflict" });
    }
    const storage = existing
      ? await prisma.storageProvider.update({
        where: { npub: body.npub, ownerNpub: body.ownerNpub },
        data: {
          lifecycle: StorageLifecycle.LINKED,
          ...(declaredCapacityBytes !== undefined ? { declaredCapacityBytes } : {}),
        },
      })
      : await prisma.storageProvider.create({ data: {
        npub: body.npub,
        ownerNpub: body.ownerNpub,
        lifecycle: StorageLifecycle.LINKED,
        ...(declaredCapacityBytes !== undefined ? { declaredCapacityBytes } : {}),
      } });
    res.status(existing ? 200 : 201).json(storageProviderToJson(storage));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_bigint") {
      return res.status(400).json({ error: "invalid_bigint" });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      const existing = await prisma.storageProvider.findUnique({ where: { npub: body.npub } });
      if (existing && existing.ownerNpub !== body.ownerNpub) {
        return res.status(409).json({ error: "owner_conflict" });
      }
      if (existing) {
        const declaredCapacityBytes = parseBigInt(body.declaredCapacityBytes);
        const storage = await prisma.storageProvider.update({
          where: { npub: body.npub, ownerNpub: body.ownerNpub },
          data: {
            lifecycle: StorageLifecycle.LINKED,
            ...(declaredCapacityBytes !== undefined ? { declaredCapacityBytes } : {}),
          },
        });
        return res.json(storageProviderToJson(storage));
      }
    }
    throw error;
  }
});

storagesRouter.patch("/:npub", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  if (body.ownerNpub !== undefined || (body.lifecycle !== undefined && !Object.values(StorageLifecycle).includes(body.lifecycle as StorageLifecycle))) {
    return res.status(400).json({ error: "invalid_storage" });
  }
  try {
    const blossomPort = parseOptionalPort(body.blossomPort);
    const pgAgentPort = parseOptionalPort(body.pgAgentPort);
    const lastPingAt = parseOptionalDate(body.lastPingAt);
    const createdAt = parseOptionalDate(body.createdAt);
    if (Number.isNaN(blossomPort) || Number.isNaN(pgAgentPort)
      || (body.lastPingAt !== undefined && lastPingAt === undefined)
      || (body.createdAt !== undefined && createdAt === undefined)) {
      return res.status(400).json({ error: "invalid_storage" });
    }
    if (body.tunnelIp !== undefined && body.tunnelIp !== null && typeof body.tunnelIp !== "string") {
      return res.status(400).json({ error: "invalid_storage" });
    }
    const data: Prisma.StorageProviderUpdateInput = {};
    if (body.tunnelIp === null || typeof body.tunnelIp === "string") data.tunnelIp = body.tunnelIp;
    if (blossomPort !== undefined) data.blossomPort = blossomPort;
    if (pgAgentPort !== undefined) data.pgAgentPort = pgAgentPort;
    if (body.declaredCapacityBytes !== undefined) data.declaredCapacityBytes = parseBigInt(body.declaredCapacityBytes) as bigint | null;
    if (body.reportedTotalBytes !== undefined) data.reportedTotalBytes = parseBigInt(body.reportedTotalBytes) as bigint | null;
    if (body.reportedFreeBytes !== undefined) data.reportedFreeBytes = parseBigInt(body.reportedFreeBytes) as bigint | null;
    if (body.lifecycle !== undefined) data.lifecycle = body.lifecycle as StorageLifecycle;
    if (lastPingAt !== undefined) data.lastPingAt = lastPingAt;
    if (createdAt !== undefined && createdAt !== null) data.createdAt = createdAt;
    const storage = await prisma.storageProvider.update({ where: { npub: req.params.npub! }, data });
    res.json(storageProviderToJson(storage));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_bigint") {
      return res.status(400).json({ error: "invalid_bigint" });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return res.status(404).json({ error: "not_found" });
    }
    throw error;
  }
});

storagesRouter.delete("/:npub", async (req, res) => {
  try {
    const storage = await prisma.storageProvider.update({
      where: { npub: req.params.npub! },
      data: { lifecycle: StorageLifecycle.REMOVED },
    });
    res.json(storageProviderToJson(storage));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return res.status(404).json({ error: "not_found" });
    }
    throw error;
  }
});
