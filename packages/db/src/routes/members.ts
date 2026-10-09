import { Router, type Router as ExpressRouter } from "express";
import { MeshRole, MeshStatus, prisma } from "../prisma.js";
import { meshMemberToJson } from "../serialize.js";

export const membersRouter: ExpressRouter = Router();

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? value as T : undefined;
}

membersRouter.get("/", async (req, res) => {
  const role = req.query.role === undefined
    ? undefined
    : enumValue(req.query.role, Object.values(MeshRole));
  const status = req.query.status === undefined
    ? undefined
    : enumValue(req.query.status, Object.values(MeshStatus));
  if ((req.query.role !== undefined && !role) || (req.query.status !== undefined && !status)) {
    return res.status(400).json({ error: "invalid_filter" });
  }

  const members = await prisma.meshMember.findMany({
    where: { ...(role ? { role } : {}), ...(status ? { status } : {}) },
    include: { _count: { select: { storages: true } } },
  });
  res.json(members.map(({ _count, ...member }) => meshMemberToJson(member, _count.storages)));
});

membersRouter.get("/:npub", async (req, res) => {
  const member = await prisma.meshMember.findUnique({ where: { npub: req.params.npub! } });
  if (!member) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json(meshMemberToJson(member));
});

membersRouter.put("/:npub", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const role = body.role === undefined
    ? MeshRole.CLIENT
    : enumValue(body.role, Object.values(MeshRole));
  if (!role || (body.status !== undefined && body.status !== MeshStatus.ACTIVE)) {
    return res.status(400).json({ error: "invalid_member" });
  }
  if (body.addedByNpub !== undefined && body.addedByNpub !== null && typeof body.addedByNpub !== "string") {
    return res.status(400).json({ error: "invalid_member" });
  }

  const addedByNpub = typeof body.addedByNpub === "string" ? body.addedByNpub : null;
  const member = await prisma.meshMember.upsert({
    where: { npub: req.params.npub! },
    update: { role, status: MeshStatus.ACTIVE },
    create: { npub: req.params.npub!, role, status: MeshStatus.ACTIVE, addedByNpub },
  });
  res.json(meshMemberToJson(member));
});

membersRouter.delete("/:npub", async (req, res) => {
  try {
    const member = await prisma.meshMember.update({
      where: { npub: req.params.npub! },
      data: { status: MeshStatus.REVOKED },
    });
    res.json(meshMemberToJson(member));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return res.status(404).json({ error: "not_found" });
    }
    throw error;
  }
});
