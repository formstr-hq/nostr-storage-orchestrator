const BYTES_PER_GB = 1_000_000_000n;

function bytes(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function sumBytes(values: Array<string | null>): bigint {
  return values.reduce<bigint>((sum, value) => sum + (bytes(value) ?? 0n), 0n);
}

export function formatBytes(value: string | bigint | null): string {
  const amount = typeof value === "bigint" ? value : bytes(value);
  if (amount === null) return "-";
  const whole = amount / BYTES_PER_GB;
  const tenth = (amount % BYTES_PER_GB) / 100_000_000n;
  return `${whole}${tenth === 0n ? "" : `.${tenth}`} GB`;
}

export function bytesToGbInput(value: string | null): string {
  const amount = bytes(value);
  if (amount === null) return "";
  const whole = amount / BYTES_PER_GB;
  const fraction = (amount % BYTES_PER_GB).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Convert decimal GB to an exact integer byte string without floating point. */
export function gbToBytes(value: string): string | null {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(9, "0") || "0");
  const result = whole * BYTES_PER_GB + fraction;
  return result > 0n ? result.toString() : null;
}

export function percent(part: string | bigint | null, total: string | bigint | null): number {
  const numerator = typeof part === "bigint" ? part : bytes(part);
  const denominator = typeof total === "bigint" ? total : bytes(total);
  if (numerator === null || denominator === null || denominator === 0n) return 0;
  return Number((numerator * 100n) / denominator > 100n ? 100n : (numerator * 100n) / denominator);
}

export function relativeTime(value: string | null): string {
  if (!value) return "never";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function shortDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(time);
}
