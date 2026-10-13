import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "../prisma.js";
import { requireServiceAccount } from "../internal-auth.js";
import { blobToJson } from "../serialize.js";
import { paginated, parsePagination, queryString } from "../pagination.js";

export const adminRouter: ExpressRouter = Router();

// Global blob search/filter for the admin console.
adminRouter.get("/blobs", requireServiceAccount, async (req, res) => {
  const hash = queryString(req.query.hash);
  const npub = queryString(req.query.npub);
  const query = queryString(req.query.query);
  const pagination = parsePagination(req.query as Record<string, unknown>);
  const where = {
    ...(hash ? { hash } : {}),
    ...(npub ? { npub } : {}),
    ...(query ? { npub: { contains: query, mode: "insensitive" as const } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.blob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.blob.count({ where }),
  ]);
  res.json(paginated(items.map(blobToJson), total, pagination));
});

// No money or plan info here — plan labels, billing statistics and admin
// identity live in formstr-backend.
adminRouter.get("/storage-stats", requireServiceAccount, async (_req, res) => {
  const [totalUsers, totalBlobs, sizeAgg] = await Promise.all([
    prisma.user.count(),
    prisma.blob.count(),
    prisma.blob.aggregate({ _sum: { size: true } }),
  ]);

  res.json({
    users: totalUsers,
    blobs: totalBlobs,
    bytes: (sizeAgg._sum.size ?? 0n).toString(),
  });
});
