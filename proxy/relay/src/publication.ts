import { DbApiError, type DbClient } from "@orchestrator/db-client";
import type { NostrEvent } from "nostr-tools";
import type { RelayConfig } from "./config.js";
import { getNpubFromPubkey } from "./nostr.js";
import { getPlanConfig } from "./plan.js";
import { normalizeReason, okMessage } from "./protocol.js";
import type { PublishResult, RelayPool } from "./relay.js";

type PublicationEvaluation =
  | { success: true; acceptedRelays: string[] }
  | { success: false; reason: string; acceptedRelays: string[] };

function evaluatePublication(results: PublishResult[], requiredCount: number): PublicationEvaluation {
  const accepted = results.filter((entry) => entry.accepted);
  if (accepted.length === 0) {
    const details = results.map((entry) => `${entry.relay}: ${entry.message}`).join("; ");
    return {
      success: false,
      reason: normalizeReason(`no backend relays accepted the event (${details})`),
      acceptedRelays: [],
    };
  }
  if (accepted.length < requiredCount) {
    const details = results
      .filter((entry) => !entry.accepted)
      .map((entry) => `${entry.relay}: ${entry.message}`)
      .join("; ");
    return {
      success: false,
      reason: normalizeReason(
        `replication incomplete; accepted ${accepted.length} of ${requiredCount} backend relays (${details})`,
      ),
      acceptedRelays: accepted.map((entry) => entry.relay),
    };
  }
  return { success: true, acceptedRelays: accepted.map((entry) => entry.relay) };
}

export class EventPublicationService {
  constructor(
    private readonly db: DbClient,
    private readonly relayPool: RelayPool,
    private readonly relayConfig: RelayConfig,
  ) {}

  async publish(event: NostrEvent, authenticatedNpub: string): Promise<ReturnType<typeof okMessage>> {
    if (event.kind === 5) {
      return this.deleteEvent(event, authenticatedNpub);
    }

    const npub = getNpubFromPubkey(event.pubkey);
    const user = await this.db.upsertUser(npub);
    const planConfig = (await getPlanConfig(this.db))[user.plan];
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (size > planConfig.uploadLimit) {
      return okMessage(event.id, false, "restricted: file exceeds upload limit");
    }

    const reserved = await this.reserveStorage(event, npub, size);
    if (!reserved) {
      return okMessage(event.id, false, "restricted: storage limit exceeded");
    }

    let healthyRelays: string[];
    try {
      healthyRelays = await this.relayPool.selectHealthyRelays(planConfig.replicaCount);
    } catch (error) {
      await this.db.rollbackRelayEvent(event.id);
      const reason = error instanceof Error ? error.message : "error: no backend relays are available";
      return okMessage(event.id, false, reason);
    }

    const results = await this.relayPool.publish(event, healthyRelays);
    const evaluation = evaluatePublication(results, planConfig.replicaCount);
    if (!evaluation.success) {
      if (evaluation.acceptedRelays.length === 0) {
        await this.db.rollbackRelayEvent(event.id);
      } else {
        await this.db.setRelayEventReplicas(event.id, evaluation.acceptedRelays);
      }
      return okMessage(event.id, false, evaluation.reason);
    }

    await this.db.setRelayEventReplicas(event.id, evaluation.acceptedRelays);
    return okMessage(event.id, true);
  }

  private async deleteEvent(
    event: NostrEvent,
    authenticatedNpub: string,
  ): Promise<ReturnType<typeof okMessage>> {
    const deletionTarget = event.tags.find((tag) => tag[0] === "e")?.[1];
    if (!deletionTarget) {
      return okMessage(event.id, false, "invalid: deletion target is missing");
    }

    const existing = await this.db.getRelayEvent(deletionTarget);
    if (!existing || existing.npub !== authenticatedNpub) {
      return okMessage(event.id, false, "restricted: deletion is not authorized");
    }

    const targetRelays = existing.replicas.length > 0 ? existing.replicas : this.relayConfig.backendRelays;
    let healthyRelays = targetRelays.filter((relay: string) => this.relayConfig.backendRelays.includes(relay));
    try {
      if (healthyRelays.length === 0) {
        healthyRelays = await this.relayPool.selectHealthyRelays(1);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "error: no backend relays are available";
      return okMessage(event.id, false, reason);
    }

    const results = await this.relayPool.delete({ ...event, kind: 5 }, healthyRelays);
    const evaluation = evaluatePublication(results, healthyRelays.length);
    if (!evaluation.success) {
      const remainingReplicas = results.filter((entry) => !entry.accepted).map((entry) => entry.relay);
      if (remainingReplicas.length > 0) {
        await this.db.setRelayEventReplicas(existing.eventId, remainingReplicas);
      }
      return okMessage(event.id, false, evaluation.reason);
    }

    await this.db.deleteRelayEvent(existing.eventId);
    return okMessage(event.id, true);
  }

  private async reserveStorage(event: NostrEvent, npub: string, size: number): Promise<boolean> {
    try {
      const existing = await this.db.getRelayEvent(event.id);
      if (existing) {
        return true;
      }

      const user = await this.db.getUser(npub);
      if (!user) {
        return false;
      }

      const planConfig = await getPlanConfig(this.db);
      if (Number(user.usedStorage) + size > planConfig[user.plan].storageLimit) {
        return false;
      }

      await this.db.createRelayEvent({ eventId: event.id, npub, kind: event.kind, size });
      return true;
    } catch (error) {
      return error instanceof DbApiError && error.status === 409;
    }
  }
}
