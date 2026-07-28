const PROTOCOL_PREFIXES = [
  "invalid:",
  "auth-required:",
  "restricted:",
  "blocked:",
  "rate-limited:",
  "duplicate:",
  "error:",
] as const;

export type ProtocolPrefix = (typeof PROTOCOL_PREFIXES)[number];

export function hasProtocolPrefix(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return PROTOCOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function normalizeReason(reason: string, fallbackPrefix: ProtocolPrefix = "error:"): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    return `${fallbackPrefix} unknown error`;
  }
  if (hasProtocolPrefix(trimmed)) {
    return trimmed;
  }
  return `${fallbackPrefix} ${trimmed}`;
}

export function validateSubscriptionId(subId: unknown): { valid: true; subId: string } | { valid: false; reason: string } {
  if (typeof subId !== "string") {
    return { valid: false, reason: "invalid: subscription id must be a string" };
  }
  if (subId.length === 0) {
    return { valid: false, reason: "invalid: subscription id must not be empty" };
  }
  if (subId.length > 64) {
    return { valid: false, reason: "invalid: subscription id must not exceed 64 characters" };
  }
  return { valid: true, subId };
}

export function closedMessage(subId: string, reason: string): ["CLOSED", string, string] {
  return ["CLOSED", subId, normalizeReason(reason, "error:")];
}

export function okMessage(eventId: string, accepted: boolean, reason = ""): ["OK", string, boolean, string] {
  return ["OK", eventId, accepted, accepted ? "" : normalizeReason(reason, "error:")];
}
