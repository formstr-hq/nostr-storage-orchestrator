import type { NextFunction, Request, Response } from "express";
import { Nip98Error, verifyNip98, type ReplayCache } from "@orchestrator/nip98";
import { prisma } from "./prisma.js";

export type InternalRole = "service" | "admin";

const INTERNAL_ROLES: readonly InternalRole[] = ["service", "admin"];

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Gate for the internal admin/mutation db-api endpoints. The caller proves its
 * identity with a NIP-98 (kind 27235) header; the signer's npub must have an
 * internal role ("service" or "admin") in the User table.
 *
 * There is no shared bearer token and no environment fallback: db-api trusts
 * only signed requests. Service identities are registered out of band with
 * `npm run register:service -- <npub>`.
 *
 * Replay protection defaults to a process-local cache; scaling db-api
 * horizontally requires a shared store (see packages/nip98).
 */
export function requireInternalRole(
  req: Request,
  res: Response,
  next: NextFunction,
  allowed: readonly InternalRole[] = INTERNAL_ROLES,
  replay?: ReplayCache,
): void {
  void (async () => {
    let signer: { pubkey: string; npub: string };
    try {
      signer = verifyNip98(req, replay ? { replay } : {});
    } catch (error) {
      if (error instanceof Nip98Error) {
        res.setHeader("X-Reason", error.message);
        res.status(error.status).json({ error: "unauthorized" });
        return;
      }
      throw error;
    }

    const user = await prisma.user.findUnique({ where: { npub: signer.npub } });
    if (!user || !allowed.includes(user.role as InternalRole)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }

    (req as Request & { serviceNpub?: string }).serviceNpub = signer.npub;
    next();
  })().catch(next);
}

/**
 * Service-role guard used where only a machine caller makes sense (entitlement
 * writes); admins are still allowed by requireInternalRole.
 */
export function requireServiceRole(req: Request, res: Response, next: NextFunction): void {
  requireInternalRole(req, res, next);
}

export { headerValue };
