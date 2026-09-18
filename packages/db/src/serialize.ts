import type { Blob, Member, Storage, User } from "./prisma.js";

export function userToJson(user: User) {
  return {
    npub: user.npub,
    plan: user.plan,
    usedStorage: user.usedStorage.toString(),
  };
}

export function blobToJson(blob: Blob) {
  return {
    hash: blob.hash,
    npub: blob.npub,
    size: blob.size.toString(),
    replicas: blob.replicas,
    createdAt: blob.createdAt.toISOString(),
  };
}

export function memberToJson(member: Member, storageCount?: number) {
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

export function storageToJson(storage: Storage) {
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
