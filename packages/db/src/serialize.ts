import type { NotificationLog, StorageGrant, User } from "./prisma.js";
import { summarizeGrants } from "./grants.js";

export function grantToJson(grant: StorageGrant) {
  return {
    id: grant.id,
    npub: grant.npub,
    planId: grant.planId,
    storageBytes: grant.storageBytes.toString(),
    startsAt: grant.startsAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    source: grant.source,
    sourceRef: grant.sourceRef,
    createdAt: grant.createdAt.toISOString(),
  };
}

/**
 * The wire shape keeps `planExpiresAt` / `storageBytes` because the proxy and
 * lifecycle consume them, but both are now **derived** from the grant ledger:
 * `storageBytes` is the sum active right now, `planExpiresAt` is the latest
 * expiry (so the lifecycle starts when the last grant lapses).
 */
export function userToJson(user: User, grants: StorageGrant[] = [], now = new Date()) {
  const summary = summarizeGrants(grants, now);
  return {
    npub: user.npub,
    planExpiresAt: summary.lastExpiresAt?.toISOString() ?? null,
    storageBytes: grants.length === 0 ? null : summary.activeStorageBytes.toString(),
    usedStorage: user.usedStorage.toString(),
    createdAt: user.createdAt.toISOString(),
    nextExpiresAt: summary.nextExpiresAt?.toISOString() ?? null,
    grants: grants.map(grantToJson),
  };
}

export function blobToJson(blob: {
  hash: string;
  npub: string;
  size: bigint;
  replicas: string[];
  createdAt: Date;
}) {
  return {
    hash: blob.hash,
    npub: blob.npub,
    size: blob.size.toString(),
    replicas: blob.replicas,
    createdAt: blob.createdAt.toISOString(),
  };
}

export function meshMemberToJson(member: {
  npub: string;
  role: string;
  status: string;
  addedByNpub: string | null;
  createdAt: Date;
  updatedAt: Date;
}, storageCount?: number) {
  return {
    npub: member.npub,
    role: member.role,
    status: member.status,
    addedByNpub: member.addedByNpub,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
    ...(storageCount === undefined ? {} : { storageCount }),
  };
}

export function storageProviderToJson(storage: {
  npub: string;
  ownerNpub: string;
  tunnelIp: string | null;
  blossomPort: number | null;
  pgAgentPort: number | null;
  declaredCapacityBytes: bigint | null;
  reportedTotalBytes: bigint | null;
  reportedFreeBytes: bigint | null;
  lifecycle: string;
  lastPingAt: Date | null;
  createdAt: Date;
}) {
  return {
    npub: storage.npub,
    ownerNpub: storage.ownerNpub,
    tunnelIp: storage.tunnelIp,
    blossomPort: storage.blossomPort,
    pgAgentPort: storage.pgAgentPort,
    declaredCapacityBytes: storage.declaredCapacityBytes?.toString() ?? null,
    reportedTotalBytes: storage.reportedTotalBytes?.toString() ?? null,
    reportedFreeBytes: storage.reportedFreeBytes?.toString() ?? null,
    lifecycle: storage.lifecycle,
    lastPingAt: storage.lastPingAt?.toISOString() ?? null,
    createdAt: storage.createdAt.toISOString(),
  };
}

export function notificationToJson(notification: NotificationLog) {
  return {
    id: notification.id,
    npub: notification.npub,
    kind: notification.kind,
    ref: notification.ref,
    channel: notification.channel,
    sentAt: notification.sentAt.toISOString(),
  };
}

export function moderationToJson(action: {
  id: string;
  hash: string;
  npub: string;
  adminNpub: string;
  reason: string;
  createdAt: Date;
}) {
  return {
    id: action.id,
    hash: action.hash,
    npub: action.npub,
    adminNpub: action.adminNpub,
    reason: action.reason,
    createdAt: action.createdAt.toISOString(),
  };
}
