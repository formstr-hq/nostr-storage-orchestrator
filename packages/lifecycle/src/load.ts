import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  parseLifecycleConfig,
  type LifecycleConfig,
} from "./state.js";

/**
 * Loads the lifecycle config at boot. `LIFECYCLE_CONFIG_PATH` defaults to
 * `./config/lifecycle.yml` relative to the process working directory; the
 * file is mounted read-only into both the proxy and the notifier. Missing
 * file → built-in defaults; malformed file → throw (fail fast).
 */
export function loadLifecycleConfig(
  path = process.env["LIFECYCLE_CONFIG_PATH"] ?? resolve(process.cwd(), "config/lifecycle.yml"),
): LifecycleConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      console.warn(
        `lifecycle config not found at ${path}, using defaults (purge disabled)`,
      );
      return DEFAULT_LIFECYCLE_CONFIG;
    }
    throw new Error(`lifecycle config: failed to read/parse ${path}: ${(error as Error).message}`);
  }
  return parseLifecycleConfig(raw);
}
