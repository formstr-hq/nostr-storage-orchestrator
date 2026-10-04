import type { NotificationLog, UserStatus, User } from "./prisma.js";
import { UserStatus as UserStatusValues } from "./prisma.js";

export type { UserStatus };

export function userToJson(user: User) {
  return {
    npub: user.npub,
    role: user.role,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt?.toISOString() ?? null,
    storageBytes: user.storageBytes?.toString() ?? null,
    status: user.status,
    statusChangedAt: user.statusChangedAt?.toISOString() ?? null,
    termsVersion: user.termsVersion,
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
    usedStorage: user.usedStorage.toString(),
    createdAt: user.createdAt.toISOString(),
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

export function memberToJson(member: {
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

export function storageToJson(storage: {
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

export function isUserStatus(value: unknown): value is UserStatus {
  return (
    typeof value === "string" &&
    (Object.values(UserStatusValues) as string[]).includes(value)
  );
}
