import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "../prisma.js";
import { requireServiceAccount } from "../internal-auth.js";
import {
  EntitlementError,
  computeEntitlement,
  parseEntitlementRequest,
} from "../entitlement.js";
import { blobToJson, notificationToJson, userToJson } from "../serialize.js";
import { paginated, parsePagination, queryString } from "../pagination.js";

export const usersRouter: ExpressRouter = Router();

// Users due for lifecycle/notification evaluation. Registered before
// /:npub so "attention" is not captured as an npub. Anyone with an expiry is
// due for evaluation; the derived access state decides what, if anything, is
// sent.
usersRouter.get("/attention", requireServiceAccount, async (req, res) => {
  const pagination = parsePagination(req.query as Record<string, unknown>);
  const where = {
    planExpiresAt: { not: null },
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { planExpiresAt: "asc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.user.count({ where }),
  ]);
  res.json(paginated(items.map(userToJson), total, pagination));
});

// Extended user serialization (no auth — same exposure as before; the proxy
// authenticates the account owner before exposing it to the console).
usersRouter.get("/:npub", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { npub: req.params.npub! } });
  if (!user) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(userToJson(user));
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
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.user.count({ where }),
  ]);

  res.json(paginated(items.map(userToJson), total, pagination));
});

/**
 * Atomic entitlement assign/extend/upgrade. See
 * docs/BLOSSOM_PRODUCTIONISATION_PLAN.md — the transaction is the single
 * write path for plan state; formstr-backend pushes paid purchases here.
 * The upsert creates the row: this is the only place a user is created, so
 * the user table contains paid users only.
 */
usersRouter.post("/:npub/entitlement", requireServiceAccount, async (req, res) => {
  const npub = String(req.params.npub);
  let request;
  try {
    request = parseEntitlementRequest(req.body);
  } catch (error) {
    if (error instanceof EntitlementError) {
      return res.status(error.status).json({ error: error.code });
    }
    throw error;
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const current = await tx.user.upsert({
        where: { npub },
        update: {},
        create: { npub },
      });
      // Claim the payment hash first. A repeat hits the primary key and the
      // whole transaction rolls back, so the entitlement is applied once.
      if (request.paymentHash) {
        await tx.entitlementGrant.create({
          data: { paymentHash: request.paymentHash, npub },
        });
      }
      const effect = computeEntitlement(current, request);

      return tx.user.update({
        where: { npub },
        data: {
          planExpiresAt: effect.planExpiresAt,
          storageBytes: effect.storageBytes,
        },
      });
    });
    res.json(userToJson(user));
  } catch (error) {
    if (error instanceof EntitlementError) {
      return res.status(error.status).json({ error: error.code });
    }
    if (
      request.paymentHash &&
      error && typeof error === "object" && "code" in error && error.code === "P2002"
    ) {
      // Already applied: report the current state, change nothing.
      const existing = await prisma.entitlementGrant.findUnique({
        where: { paymentHash: request.paymentHash },
      });
      if (existing && existing.npub !== npub) {
        return res.status(409).json({ error: "payment_hash_used_by_other_user" });
      }
      const user = await prisma.user.findUnique({ where: { npub } });
      if (user) return res.json(userToJson(user));
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

usersRouter.get("/:npub/blobs", async (req, res) => {
  const npub = req.params.npub!;
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
      return blobs;
    });
    res.json({ deleted: result.length, blobs: result.map(blobToJson) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

usersRouter.get("/:npub/notifications", async (req, res) => {
  const npub = req.params.npub!;
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
