import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { DbClient } from "@orchestrator/db-client";
import { buildNotifierFromEnv, runOnce } from "./scheduler.js";

export * from "./notifications.js";
export * from "./scheduler.js";
export { createDmSender, notifierNpub } from "./dm.js";
export { createEmailSender } from "./email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

// Scheduler period. Notifications are day-scale and deduped, so 15 minutes is
// plenty; not a per-deployment concern.
const INTERVAL_MS = 15 * 60_000;

async function main() {
  const db = new DbClient({
    baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
    ...(process.env.DB_API_SERVICE_NSEC
      ? { serviceNsec: process.env.DB_API_SERVICE_NSEC }
      : {}),
  });

  const { options } = buildNotifierFromEnv(db);

  const tick = async () => {
    try {
      const result = await runOnce(options);
      if (result.evaluated > 0 || result.sent > 0) {
        console.log(
          JSON.stringify({
            event: "notify_pass",
            evaluated: result.evaluated,
            statusMirrored: result.statusMirrored,
            sent: result.sent,
          }),
        );
      }
    } catch (error) {
      console.error("notifier pass failed", error);
    }
  };

  await tick();
  setInterval(tick, INTERVAL_MS);
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
