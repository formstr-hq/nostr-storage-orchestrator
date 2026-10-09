import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "../prisma.js";
import { requireServiceAccount } from "../internal-auth.js";
import { paginated, parsePagination, queryString } from "../pagination.js";

export const serviceAccountsRouter: ExpressRouter = Router();

function accountToJson(account: {
  npub: string;
  label: string | null;
  enabled: boolean;
  createdAt: Date;
}) {
  return {
    npub: account.npub,
    label: account.label,
    enabled: account.enabled,
    createdAt: account.createdAt.toISOString(),
  };
}

// Unauthenticated by design: this is the single-account lookup the NIP-98 gate
// in front of the internal endpoints consults. It exposes only npub + enabled
// (the legacy GET /users/:npub exposed the same membership via `role`), never
// a secret. Registered before the list route with its own auth.
serviceAccountsRouter.get("/:npub", async (req, res) => {
  const account = await prisma.serviceAccount.findUnique({ where: { npub: req.params.npub! } });
  if (!account) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(accountToJson(account));
});

serviceAccountsRouter.get("/", requireServiceAccount, async (req, res) => {
  const enabled = queryString(req.query.enabled);
  const pagination = parsePagination(req.query as Record<string, unknown>);
  const where = enabled === undefined ? {} : { enabled: enabled === "true" };
  const [items, total] = await Promise.all([
    prisma.serviceAccount.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.serviceAccount.count({ where }),
  ]);
  res.json(paginated(items.map(accountToJson), total, pagination));
});
