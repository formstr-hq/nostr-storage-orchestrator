import { Router, type Router as ExpressRouter } from "express";
import { MemberRole, MemberStatus, prisma } from "../prisma.js";
import { memberToJson } from "../serialize.js";

export const membersRouter: ExpressRouter = Router();

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? value as T : undefined;
}

membersRouter.get("/", async (req, res) => {
  const role = req.query.role === undefined
    ? undefined
    : enumValue(req.query.role, Object.values(MemberRole));
  const status = req.query.status === undefined
    ? undefined
    : enumValue(req.query.status, Object.values(MemberStatus));
  if ((req.query.role !== undefined && !role) || (req.query.status !== undefined && !status)) {
    return res.status(400).json({ error: "invalid_filter" });
  }

  const members = await prisma.member.findMany({
    where: { ...(role ? { role } : {}), ...(status ? { status } : {}) },
    include: { _count: { select: { storages: true } } },
  });
  res.json(members.map(({ _count, ...member }) => memberToJson(member, _count.storages)));
});

membersRouter.get("/:npub", async (req, res) => {
  const member = await prisma.member.findUnique({ where: { npub: req.params.npub! } });
  if (!member) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(memberToJson(member));
});

membersRouter.put("/:npub", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const role = body.role === undefined
    ? MemberRole.CLIENT
    : enumValue(body.role, Object.values(MemberRole));
  if (!role || (body.status !== undefined && body.status !== MemberStatus.ACTIVE)) {
    return res.status(400).json({ error: "invalid_member" });
  }
  if (body.addedByNpub !== undefined && body.addedByNpub !== null && typeof body.addedByNpub !== "string") {
    return res.status(400).json({ error: "invalid_member" });
  }

  const addedByNpub = typeof body.addedByNpub === "string" ? body.addedByNpub : null;
  const member = await prisma.member.upsert({
    where: { npub: req.params.npub! },
    update: { role, status: MemberStatus.ACTIVE },
    create: { npub: req.params.npub!, role, status: MemberStatus.ACTIVE, addedByNpub },
  });
  res.json(memberToJson(member));
});

membersRouter.delete("/:npub", async (req, res) => {
  try {
    const member = await prisma.member.update({
      where: { npub: req.params.npub! },
      data: { status: MemberStatus.REVOKED },
    });
    res.json(memberToJson(member));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return res.status(404).json({ error: "not_found" });
    }
    throw error;
  }
});
