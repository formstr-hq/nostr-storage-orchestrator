import type { UserInfo } from "@orchestrator/db-client";
import { daysUntil, type AccessState, type LifecycleConfig } from "@orchestrator/lifecycle";

export interface DueNotification {
  kind: string;
  ref: string;
  title: string;
  body: string;
}

/**
 * Pure computation of which notifications a user is due. Dedupe is handled by
 * db-api's NotificationLog unique key (npub, kind, ref, channel), so this can
 * safely re-emit the same candidates on every poll.
 */
export function dueNotifications(
  user: UserInfo,
  access: AccessState,
  config: LifecycleConfig,
  now = new Date(),
): DueNotification[] {
  if (user.planExpiresAt === null) return [];
  const expiryRef = user.planExpiresAt;
  const due: DueNotification[] = [];

  const expiry = new Date(user.planExpiresAt);

  if (access.status === "CLOSED") {
    return [];
  }

  if (user.termsAcceptedAt) {
    due.push({
      kind: "purchase",
      ref: user.termsAcceptedAt,
      title: `${user.plan ?? "Storage"} plan active`,
      body: `Your ${user.plan ?? "storage"} plan is active. Total allowance: ${formatBytes(user.storageBytes)}. Plan expires ${expiry.toUTCString()}.`,
    });
  }

  for (const warningDays of config.notify.expiryWarningDays) {
    const remaining = daysUntil(expiry, now);
    if (remaining >= 0 && remaining <= warningDays) {
      due.push({
        kind: `expiry_warning_${warningDays}`,
        ref: expiryRef,
        title: `Plan expires in ${remaining} day${remaining === 1 ? "" : "s"}`,
        body: `Your storage plan expires ${expiry.toUTCString()}. Renew from the pricing page to add days and keep uploads enabled.`,
      });
    }
  }

  if (user.storageBytes !== null && BigInt(user.storageBytes) > 0n) {
    const percent = Number((BigInt(user.usedStorage) * 100n) / BigInt(user.storageBytes));
    for (const threshold of config.notify.quotaWarningPercent) {
      if (percent >= threshold) {
        due.push({
          kind: `quota_warning_${threshold}`,
          ref: expiryRef,
          title:
            threshold >= 100
              ? "Storage allowance reached"
              : `Storage ${threshold}% full`,
          body: `You are using ${formatBytes(user.usedStorage)} of your ${formatBytes(user.storageBytes)} allowance (${percent}%). Delete blobs or upgrade to avoid uploads being blocked.`,
        });
      }
    }
  }

  if (access.status === "GRACE") {
    due.push({
      kind: "grace_entered",
      ref: expiryRef,
      title:
        access.reason === "grace_over_quota"
          ? "Over your storage allowance — grace period started"
          : "Plan expired — grace period started",
      body:
        access.reason === "grace_over_quota"
          ? `You are over your allowance. Uploads are blocked until you delete blobs or upgrade. Grace ends ${access.graceUntil?.toUTCString()}.`
          : `Uploads are blocked. Delete blobs or renew before ${access.graceUntil?.toUTCString()} to avoid the next stage.`,
    });
  }

  if (access.status === "WRITE_BLOCKED") {
    due.push({
      kind: "write_blocked",
      ref: expiryRef,
      title: "Uploads are blocked",
      body: `The grace period has ended and uploads are now blocked. Your data is still readable. Renew or free space before reads are blocked on ${access.readBlockedUntil?.toUTCString()}.`,
    });
  }

  if (access.status === "READ_BLOCKED") {
    due.push({
      kind: "read_blocked",
      ref: expiryRef,
      title: "Reads are blocked — data scheduled for purge",
      body: `Reads are blocked and your blobs are scheduled for purge on ${access.purgeAt?.toUTCString()}. Renew before then to keep your data.`,
    });
  }

  return due;
}

export function moderationNotification(action: {
  id: string;
  hash: string;
  reason: string;
}): DueNotification {
  return {
    kind: "moderation_deleted",
    ref: action.id,
    title: "A blob was removed following a report",
    body: `Blob ${action.hash} was removed by moderation. Reason: ${action.reason}. If you believe this was a mistake, contact the operator to appeal.`,
  };
}

export function formatBytes(value: string | number | bigint | null): string {
  if (value === null) return "unlimited";
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return String(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(n >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
