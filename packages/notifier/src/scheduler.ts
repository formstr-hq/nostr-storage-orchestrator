import { DbClient, type UserInfo } from "@orchestrator/db-client";
import {
  deriveAccess,
  loadLifecycleConfig,
  type LifecycleConfig,
} from "@orchestrator/lifecycle";
import { createDmSender, type DmSender } from "./dm.js";
import { createEmailSender, type EmailSender } from "./email.js";
import { dueNotifications, type DueNotification } from "./notifications.js";

export interface NotifierOptions {
  db: DbClient;
  dm: DmSender | null;
  email: EmailSender;
  config: LifecycleConfig;
  /** Calls the proxy's internal purge endpoint. */
  purge?: (npub: string) => Promise<{ purged: number }>;
  now?: () => Date;
}

export interface NotifierResult {
  evaluated: number;
  sent: number;
}

/**
 * One scheduler pass: send every due notification on both channels and purge
 * accounts past the retention window. Dedupe is enforced server-side by the
 * NotificationLog unique key, so a crash between send and log at worst sends a
 * duplicate, never drops one.
 */
export async function runOnce(options: NotifierOptions): Promise<NotifierResult> {
  const now = (options.now ?? (() => new Date()))();
  const pageSize = 100;

  let evaluated = 0;
  let sent = 0;

  // Page through the attention set. Notification logs are idempotent, so
  // overlapping passes are safe.
  for (let page = 1; ; page += 1) {
    const result = await options.db.listAttentionUsers(page, pageSize);
    evaluated += result.items.length;

    for (const user of result.items) {
      const access = deriveAccess(
        {
          planExpiresAt: user.planExpiresAt,
          storageBytes: user.storageBytes,
          usedStorage: user.usedStorage,
        },
        now,
        options.config,
      );

      const due = dueNotifications(user, access, options.config, now);
      sent += await deliverAll(options, user, due);

      // purgeAt is the instant READ_BLOCKED ends, which is also when the
      // derived status becomes CLOSED, so a due purge is always seen as CLOSED.
      // Accounts with nothing stored are skipped so a closed account is not
      // re-purged on every pass.
      if (
        options.config.purgeEnabled &&
        (access.status === "READ_BLOCKED" || access.status === "CLOSED") &&
        access.purgeAt !== null &&
        now.getTime() >= access.purgeAt.getTime() &&
        BigInt(user.usedStorage) > 0n &&
        options.purge
      ) {
        try {
          const result2 = await options.purge(user.npub);
          await deliverAll(options, user, [
            {
              kind: "purged",
              ref: access.purgeAt.toISOString(),
              title: "Your storage account was purged",
              body: `All ${result2.purged} blobs were deleted after the retention window. Purchase a new plan to start storing again.`,
            },
          ]);
        } catch (error) {
          console.error(`purge failed for ${user.npub}`, error);
        }
      }
    }

    if (result.items.length < pageSize || page * pageSize >= result.total) break;
  }

  return { evaluated, sent };
}

async function deliverAll(
  options: NotifierOptions,
  user: UserInfo,
  due: DueNotification[],
): Promise<number> {
  let sent = 0;
  for (const notification of due) {
    sent += await deliver(options, user, notification);
  }
  return sent;
}

async function deliver(
  options: NotifierOptions,
  user: UserInfo,
  notification: DueNotification,
): Promise<number> {
  let delivered = 0;

  if (options.dm) {
    try {
      if (
        await options.db.logNotification({
          npub: user.npub,
          kind: notification.kind,
          ref: notification.ref,
          channel: "nostr",
        })
      ) {
        await options.dm.send(user.npub, notification.title, notification.body);
        delivered += 1;
      } else {
        delivered += 1; // already sent on this channel
      }
    } catch (error) {
      console.error(`DM ${notification.kind} to ${user.npub} failed`, error);
    }
  }

  try {
    if (
      await options.db.logNotification({
        npub: user.npub,
        kind: notification.kind,
        ref: notification.ref,
        channel: "email",
      })
    ) {
      const result = await options.email.send(user.npub, notification.kind, {
        title: notification.title,
        body: notification.body,
      });
      if (result === "sent") delivered += 1;
    } else {
      delivered += 1;
    }
  } catch (error) {
    console.error(`email ${notification.kind} to ${user.npub} failed`, error);
  }

  return delivered;
}

export function buildNotifierFromEnv(db: DbClient): { options: NotifierOptions } {
  const dmRecipientsRelays = (process.env.NOTIFY_RELAYS ?? "wss://relay.damus.io,wss://nos.lol")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const dm = createDmSender({
    nsec: process.env.NOTIFY_NSEC,
    relays: dmRecipientsRelays,
  });

  const serviceNsec = process.env.STORAGE_SERVICE_NSEC;
  const email = createEmailSender({
    backendUrl: process.env.FORMSTR_BACKEND_URL,
    serviceNsec,
  });

  const proxyUrl = process.env.BLOSSOM_INTERNAL_URL;
  const purge =
    proxyUrl && serviceNsec
      ? async (npub: string) => {
          const axios = (await import("axios")).default;
          const { createNip98Signer } = await import("@orchestrator/nip98");
          const base = proxyUrl.replace(/\/$/, "");
          const path = `/internal/purge/${encodeURIComponent(npub)}`;
          const signer = createNip98Signer(serviceNsec);
          const res = await axios.post(`${base}${path}`, {}, {
            timeout: 60_000,
            headers: { authorization: signer.header("POST", `${base}${path}`, {}) },
          });
          return res.data as { purged: number };
        }
      : undefined;

  const options: NotifierOptions = {
    db,
    dm,
    email,
    config: loadLifecycleConfig(),
  };
  if (purge) options.purge = purge;
  return { options };
}
