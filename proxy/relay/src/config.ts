import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { hexToBytes } from "nostr-tools/utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

export type RelayConfig = {
  relayPort: number;
  publicUrl: string;
  backendRelays: string[];
  initialEoseTimeoutMs: number;
  publishAckTimeoutMs: number;
  backendAuthSecretKey?: Uint8Array;
  software: string;
  version: string;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBackendAuthSecretKey(): Uint8Array | undefined {
  const raw = process.env.BACKEND_AUTH_SECRET_KEY?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const secretKey = hexToBytes(raw);
    if (secretKey.length !== 32) {
      throw new Error("invalid secret key length");
    }
    return secretKey;
  } catch {
    throw new Error("BACKEND_AUTH_SECRET_KEY must be a 32-byte hex string");
  }
}

export function loadRelayConfig(): RelayConfig {
  const relayPort = parsePositiveInt(process.env.RELAY_PORT, 8007);
  // Treat empty/whitespace PUBLIC_URL as unset (Docker often injects "").
  const publicUrl = process.env.PUBLIC_URL?.trim() || `ws://localhost:${relayPort}`;
  const backendRelays = (process.env.BACKEND_RELAYS ?? "")
    .split(",")
    .map((relay) => relay.trim())
    .filter(Boolean);

  const config: RelayConfig = {
    relayPort,
    publicUrl,
    backendRelays,
    initialEoseTimeoutMs: parsePositiveInt(process.env.RELAY_INITIAL_EOSE_TIMEOUT_MS, 5000),
    publishAckTimeoutMs: parsePositiveInt(process.env.RELAY_PUBLISH_ACK_TIMEOUT_MS, 5000),
    software: "nostr-storage-orchestrator-relay",
    version: "1.0.0",
  };
  const backendAuthSecretKey = parseBackendAuthSecretKey();
  if (backendAuthSecretKey) {
    config.backendAuthSecretKey = backendAuthSecretKey;
  }
  return config;
}

export function requireBackendRelays(backendRelays: string[]): void {
  if (backendRelays.length === 0) {
    throw new Error("BACKEND_RELAYS is not configured");
  }
}
