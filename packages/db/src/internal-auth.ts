import type { NextFunction, Request, Response } from "express";
import { Nip98Error, verifyNip98, type ReplayCache } from "@orchestrator/nip98";
import { prisma } from "./prisma.js";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Gate for the internal db-api endpoints. The caller proves its identity with
 * a NIP-98 (kind 27235) header; the signer's npub must have an enabled row in
 * service_account. There is no shared bearer token, no environment fallback,
 * and no admin role: admins are owned by formstr-backend, which the proxy
 * checks directly. Service identities are registered out of band with
 * `npm run register:service -- <npub>`.
 *
 * Replay protection defaults to a process-local cache; scaling db-api
 * horizontally requires a shared store (see packages/nip98).
 *
 * The returned middleware must keep exactly three parameters: Express treats
 * any handler with four as an error handler and silently skips it on normal
 * requests, which would leave the route unauthenticated. The replay cache is
 * therefore injected through this factory, not a fourth argument.
 */
export function createServiceAccountGate(
  replay?: ReplayCache,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
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

      const account = await prisma.serviceAccount.findUnique({ where: { npub: signer.npub } });
      if (!account?.enabled) {
        res.status(403).json({ error: "forbidden_service_account" });
        return;
      }

      (req as Request & { serviceNpub?: string }).serviceNpub = signer.npub;
      next();
    })().catch(next);
  };
}

export const requireServiceAccount = createServiceAccountGate();

export { headerValue };
