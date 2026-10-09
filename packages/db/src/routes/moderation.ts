import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "../prisma.js";
import { requireServiceAccount } from "../internal-auth.js";
import { moderationToJson } from "../serialize.js";
import { paginated, parsePagination, queryString } from "../pagination.js";

export const moderationRouter: ExpressRouter = Router();

moderationRouter.use(requireServiceAccount);

moderationRouter.post("/", async (req, res) => {
  const { hash, npub, adminNpub, reason } = req.body as {
    hash?: string;
    npub?: string;
    adminNpub?: string;
    reason?: string;
  };
  if (!hash || !npub || !adminNpub || !reason) {
    return res.status(400).json({ error: "invalid_moderation_action" });
  }
  const action = await prisma.moderationAction.create({
    data: { hash, npub, adminNpub, reason },
  });
  res.status(201).json(moderationToJson(action));
});

moderationRouter.get("/", async (req, res) => {
  const hash = queryString(req.query.hash);
  const npub = queryString(req.query.npub);
  const pagination = parsePagination(req.query as Record<string, unknown>);
  const where = {
    ...(hash ? { hash } : {}),
    ...(npub ? { npub } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.moderationAction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.moderationAction.count({ where }),
  ]);
  res.json(paginated(items.map(moderationToJson), total, pagination));
});
