import type { Blob, RelayEvent, User } from "./prisma.js";

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
