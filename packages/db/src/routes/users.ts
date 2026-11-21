import { Router, type Response, type Router as ExpressRouter } from "express";
import { prisma } from "../prisma.js";
import { requireServiceAccount } from "../internal-auth.js";
import {
  GrantError,
  parseAddGrantRequest,
  parseLegacyEntitlement,
  parseTransferRequest,
} from "../grants.js";
import { blobToJson, notificationToJson, userToJson } from "../serialize.js";
import { paginated, parsePagination, queryString } from "../pagination.js";

export const usersRouter: ExpressRouter = Router();

function prismaErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function sendGrantError(res: Response, error: unknown): Response | never {
  if (error instanceof GrantError) {
    return res.status(error.status).json({ error: error.code });
  }
  throw error;
}

// Users due for lifecycle/notification evaluation. Registered before
// /:npub so "attention" is not captured as an npub. Anyone with an expiry is
// due for evaluation; the derived access state decides what, if anything, is
// sent.
usersRouter.get("/attention", requireServiceAccount, async (req, res) => {
  const pagination = parsePagination(req.query as Record<string, unknown>);
  const where = { grants: { some: {} } };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: { grants: true },
      orderBy: { createdAt: "asc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.user.count({ where }),
  ]);
  res.json(paginated(items.map((user) => userToJson(user, user.grants)), total, pagination));
});

// Extended user serialization. Service-gated: only the blossom proxy reads
// entitlement rows now; it authenticates the account owner (BUD-11) or a
// service caller before exposing them.
usersRouter.get("/:npub", requireServiceAccount, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { npub: String(req.params.npub) },
    include: { grants: true },
  });
  if (!user) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(userToJson(user, user.grants));
});

// Paginated list with an optional npub substring filter.
usersRouter.get("/", requireServiceAccount, async (req, res) => {
  const query = queryString(req.query.query);
  const pagination = parsePagination(req.query as Record<string, unknown>);

  const where = {
    ...(query
      ? { npub: { contains: query, mode: "insensitive" as const } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: { grants: true },
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.user.count({ where }),
  ]);

  res.json(paginated(items.map((user) => userToJson(user, user.grants)), total, pagination));
});

/**
 * Move existing grants between holders without touching their dates or
 * allowance. Workspace seats use this: the grant is created once, then follows
 * the seat (owner → member on assign, member → owner on revoke).
 */
usersRouter.post("/grants/transfer", requireServiceAccount, async (req, res) => {
  let request;
  try {
    request = parseTransferRequest(req.body);
  } catch (error) {
    return sendGrantError(res, error);
  }

  try {
    const moved = await prisma.$transaction(async (tx) => {
      await tx.user.upsert({
        where: { npub: request.toNpub },
        update: {},
        create: { npub: request.toNpub },
      });
      const where = {
        npub: request.fromNpub,
        ...(request.source ? { source: request.source } : {}),
        ...(request.sourceRefPrefix
          ? { sourceRef: { startsWith: request.sourceRefPrefix } }
          : {}),
      };
      const candidates = await tx.storageGrant.findMany({
        where,
        orderBy: { expiresAt: "asc" },
        take: request.count,
        select: { id: true },
      });
      if (candidates.length === 0) return 0;
      await tx.storageGrant.updateMany({
        where: { id: { in: candidates.map((grant) => grant.id) } },
        data: { npub: request.toNpub },
      });
      return candidates.length;
    });

    const [from, to] = await Promise.all([
      prisma.user.findUnique({
        where: { npub: request.fromNpub },
        include: { grants: true },
      }),
      prisma.user.findUnique({
        where: { npub: request.toNpub },
        include: { grants: true },
      }),
    ]);
    res.json({
      moved,
      from: from ? userToJson(from, from.grants) : null,
      to: to ? userToJson(to, to.grants) : null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * Append a grant. Grants are additive; the body carries its own duration (or
 * explicit window) and `sourceRef` (unique) makes retries idempotent.
 */
usersRouter.post("/:npub/grants", requireServiceAccount, async (req, res) => {
  const npub = String(req.params.npub);
  let request;
  try {
    request = parseAddGrantRequest(req.body);
  } catch (error) {
    return sendGrantError(res, error);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.upsert({ where: { npub }, update: {}, create: { npub } });
      if (request.sourceRef) {
        const existing = await tx.storageGrant.findUnique({
          where: { sourceRef: request.sourceRef },
        });
        if (existing) {
          if (existing.npub !== npub) {
            throw new GrantError(409, "source_ref_used_by_other_user");
          }
          return;
        }
      }
      await tx.storageGrant.create({
        data: {
          npub,
          planId: request.planId,
          storageBytes: request.storageBytes,
          startsAt: request.startsAt,
          expiresAt: request.expiresAt,
          source: request.source,
          sourceRef: request.sourceRef,
        },
      });
    });
    const user = await prisma.user.findUnique({ where: { npub }, include: { grants: true } });
    if (!user) return res.status(500).json({ error: "user_missing" });
    res.json(userToJson(user, user.grants));
  } catch (error) {
    if (error instanceof GrantError) return sendGrantError(res, error);
    if (prismaErrorCode(error) === "P2002" && request.sourceRef) {
      const existing = await prisma.storageGrant.findUnique({
        where: { sourceRef: request.sourceRef },
      });
      if (existing && existing.npub !== npub) {
        return res.status(409).json({ error: "source_ref_used_by_other_user" });
      }
      const user = await prisma.user.findUnique({ where: { npub }, include: { grants: true } });
      if (user) return res.json(userToJson(user, user.grants));
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

usersRouter.delete("/:npub/grants/:id", requireServiceAccount, async (req, res) => {
  const npub = String(req.params.npub);
  try {
    await prisma.storageGrant.deleteMany({
      where: { id: String(req.params.id), npub },
    });
    const user = await prisma.user.findUnique({ where: { npub }, include: { grants: true } });
    if (!user) return res.status(404).json({ error: "not_found" });
    res.json(userToJson(user, user.grants));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * Legacy single-entitlement write. Kept as a compatibility shim for callers
 * that have not moved to /grants: it appends a grant and ignores `mode` /
 * `force`, because grants never overwrite one another.
 */
usersRouter.post("/:npub/entitlement", requireServiceAccount, async (req, res) => {
  const npub = String(req.params.npub);
  let request;
  try {
    request = parseLegacyEntitlement(req.body);
  } catch (error) {
    return sendGrantError(res, error);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.upsert({ where: { npub }, update: {}, create: { npub } });
      if (request.sourceRef) {
        const existing = await tx.storageGrant.findUnique({
          where: { sourceRef: request.sourceRef },
        });
        if (existing) {
          if (existing.npub !== npub) {
            throw new GrantError(409, "payment_hash_used_by_other_user");
          }
          return;
        }
      }
      await tx.storageGrant.create({
        data: {
          npub,
          planId: request.planId,
          storageBytes: request.storageBytes,
          startsAt: request.startsAt,
          expiresAt: request.expiresAt,
          source: request.source,
          sourceRef: request.sourceRef,
        },
      });
    });
    const user = await prisma.user.findUnique({ where: { npub }, include: { grants: true } });
    if (!user) return res.status(500).json({ error: "user_missing" });
    res.json(userToJson(user, user.grants));
  } catch (error) {
    if (error instanceof GrantError) return sendGrantError(res, error);
    if (prismaErrorCode(error) === "P2002" && request.sourceRef) {
      const existing = await prisma.storageGrant.findUnique({
        where: { sourceRef: request.sourceRef },
      });
      if (existing && existing.npub !== npub) {
        return res.status(409).json({ error: "payment_hash_used_by_other_user" });
      }
      const user = await prisma.user.findUnique({ where: { npub }, include: { grants: true } });
      if (user) return res.json(userToJson(user, user.grants));
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

usersRouter.get("/:npub/blobs", requireServiceAccount, async (req, res) => {
  const npub = String(req.params.npub);
  const pagination = parsePagination(req.query as Record<string, unknown>);
  const [items, total] = await Promise.all([
    prisma.blob.findMany({
      where: { npub },
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.blob.count({ where: { npub } }),
  ]);
  res.json(paginated(items.map(blobToJson), total, pagination));
});

// Transactional bulk delete (purge): returns deleted rows, or the deletion
// is rolled back entirely.
usersRouter.delete("/:npub/blobs", requireServiceAccount, async (req, res) => {
  const npub = String(req.params.npub);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const blobs = await tx.blob.findMany({ where: { npub } });
      if (blobs.length > 0) {
        await tx.blob.deleteMany({ where: { npub } });
        await tx.user.update({
          where: { npub },
          data: { usedStorage: 0n },
        });
      }
      // A purge is terminal: the account's grants go with its data.
      await tx.storageGrant.deleteMany({ where: { npub } });
      return blobs;
    });
    res.json({ deleted: result.length, blobs: result.map(blobToJson) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

usersRouter.get("/:npub/notifications", requireServiceAccount, async (req, res) => {
  const npub = String(req.params.npub);
  const pagination = parsePagination(req.query as Record<string, unknown>);
  const [items, total] = await Promise.all([
    prisma.notificationLog.findMany({
      where: { npub },
      orderBy: { sentAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.notificationLog.count({ where: { npub } }),
  ]);
  res.json(paginated(items.map(notificationToJson), total, pagination));
});
