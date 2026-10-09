import axios from "axios";
import type { Request, Response, NextFunction } from "express";
import { Nip98Error, createNip98Signer, verifyNip98, type Nip98Signer } from "@orchestrator/nip98";
import type { DbClient } from "@orchestrator/db-client";

export interface AdminIdentity {
  isAdmin(npub: string): Promise<boolean>;
}

/**
 * Unified admin registry: formstr-backend.users.role='admin'. The orchestrator
 * asks the backend over the shared network with its NIP-98 service identity
 * (STORAGE_SERVICE_NSEC) and caches the answer briefly.
 */
export function createAdminIdentity(options: {
  backendUrl: string | undefined;
  serviceNsec: string | undefined;
  ttlMs?: number;
}): AdminIdentity {
  const ttl = options.ttlMs ?? 60_000;
  const cache = new Map<string, { admin: boolean; at: number }>();

  let signer: Nip98Signer | undefined;
  if (options.serviceNsec) {
    signer = createNip98Signer(options.serviceNsec);
  }

  return {
    async isAdmin(npub: string) {
      const cached = cache.get(npub);
      if (cached && Date.now() - cached.at < ttl) return cached.admin;

      // The backend is the single admin registry; with no backend or service
      // identity configured there is no admin, so fail closed.
      if (!options.backendUrl || !signer) {
        return false;
      }

      const base = options.backendUrl.replace(/\/$/, "");
      const path = `/api/internal/admin-check/${encodeURIComponent(npub)}`;
      try {
        const res = await axios.get<{ admin: boolean }>(`${base}${path}`, {
          timeout: 5000,
          headers: { authorization: signer.header("GET", `${base}${path}`) },
        });
        const admin = res.data.admin === true;
        cache.set(npub, { admin, at: Date.now() });
        return admin;
      } catch (error) {
        console.error("admin-check failed, denying", error);
        // Fail closed, but do not cache the failure so a transient backend
        // outage does not lock admins out for the whole TTL.
        return false;
      }
    },
  };
}

/**
 * NIP-98 + service-account gate for orchestrator-internal endpoints (the
 * purge call from the notifier). The signer's npub must have an enabled row in
 * db-api's service_account table. There is no admin bypass here: admins are
 * owned by formstr-backend and gate /admin/* through requireAdmin below.
 */
export function createInternalRoleGate(options: {
  db: Pick<DbClient, "getServiceAccount">;
}): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void (async () => {
      let npub: string;
      try {
        npub = verifyNip98(req).npub;
      } catch (error) {
        if (error instanceof Nip98Error) {
          res.setHeader("X-Reason", error.message);
          res.status(error.status).json({ error: "unauthorized" });
          return;
        }
        throw error;
      }

      const service = await options.db.getServiceAccount(npub);
      if (!service || !service.enabled) {
        res.status(403).json({ error: "forbidden_service_account" });
        return;
      }
      next();
    })().catch(next);
  };
}

/**
 * NIP-98 + unified-admin gate for /admin/*. Returns the admin npub on
 * success; writes the error response and returns undefined otherwise.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  adminIdentity: AdminIdentity,
): Promise<string | undefined> {
  try {
    const npub = verifyNip98(req).npub;
    if (!(await adminIdentity.isAdmin(npub))) {
      res.status(403).json({ error: "admin_required" });
      return undefined;
    }
    return npub;
  } catch (error) {
    if (error instanceof Nip98Error) {
      res.setHeader("X-Reason", error.message);
      res.status(error.status).json({ error: error.message });
      return undefined;
    }
    throw error;
  }
}
