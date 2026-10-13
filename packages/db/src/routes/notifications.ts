import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "../prisma.js";
import { requireServiceAccount } from "../internal-auth.js";
import { notificationToJson } from "../serialize.js";
import { paginated, parsePagination, queryString } from "../pagination.js";

export const notificationsRouter: ExpressRouter = Router();

notificationsRouter.use(requireServiceAccount);

// Log a notification send; 409 on duplicate so the caller can treat
// (npub, kind, ref, channel) as the idempotency key.
notificationsRouter.post("/", async (req, res) => {
  const { npub, kind, ref, channel } = req.body as {
    npub?: string;
    kind?: string;
    ref?: string | null;
    channel?: string;
  };
  if (!npub || !kind || !channel) {
    return res.status(400).json({ error: "invalid_notification" });
  }
  try {
    const notification = await prisma.notificationLog.create({
      data: { npub, kind, ref: ref ?? null, channel },
    });
    res.status(201).json(notificationToJson(notification));
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ error: "already_exists" });
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  }
});

notificationsRouter.get("/", async (req, res) => {
  const npub = queryString(req.query.npub);
  if (!npub) {
    return res.status(400).json({ error: "npub_required" });
  }
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
