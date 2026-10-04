import axios from "axios";
import { createNip98Signer, type Nip98Signer } from "@orchestrator/nip98";

export interface EmailSender {
  send(
    pubkey: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<"sent" | "no_address" | "failed">;
}

/**
 * Email is delivered by formstr-backend (it owns the mail bridge and address
 * tables). The notifier only asks it to render and send a storage template.
 * Requests are signed with the NIP-98 service identity (STORAGE_SERVICE_NSEC);
 * the backend gates on that npub's role.
 */
export function createEmailSender(options: {
  backendUrl: string | undefined;
  serviceNsec: string | undefined;
}): EmailSender {
  let signer: Nip98Signer | undefined;
  if (options.serviceNsec) {
    signer = createNip98Signer(options.serviceNsec);
  }

  return {
    async send(pubkey, event, data) {
      if (!options.backendUrl || !signer) return "failed";
      const base = options.backendUrl.replace(/\/$/, "");
      const path = "/api/storage/notify";
      const body = { pubkey, event, data };
      try {
        const res = await axios.post<{ status: "sent" | "no_address" }>(
          `${base}${path}`,
          body,
          {
            timeout: 10_000,
            headers: { authorization: signer.header("POST", `${base}${path}`, body) },
          },
        );
        return res.data.status === "sent" ? "sent" : "no_address";
      } catch (error) {
        console.error(`storage notify failed for ${pubkey}/${event}`, error);
        return "failed";
      }
    },
  };
}
