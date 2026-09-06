import type { Blob, Member, RelayEvent, Storage, User } from "./prisma.js";

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

export function relayEventToJson(relayEvent: RelayEvent) {
  return {
    eventId: relayEvent.eventId,
    npub: relayEvent.npub,
    kind: relayEvent.kind,
    size: relayEvent.size.toString(),
    replicas: relayEvent.replicas,
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
    relayPort: storage.relayPort,
    pgAgentPort: storage.pgAgentPort,
    declaredCapacityBytes: storage.declaredCapacityBytes?.toString() ?? null,
    reportedTotalBytes: storage.reportedTotalBytes?.toString() ?? null,
    reportedFreeBytes: storage.reportedFreeBytes?.toString() ?? null,
    lifecycle: storage.lifecycle,
    lastPingAt: storage.lastPingAt?.toISOString() ?? null,
    createdAt: storage.createdAt.toISOString(),
  };
}
