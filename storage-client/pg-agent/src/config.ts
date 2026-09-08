import { z } from "zod";

const ConfigSchema = z.object({
  hostname: z.string().default("0.0.0.0"),
  port: z.coerce.number().default(3300),
  token: z.string().optional(),
  pgHost: z.string().default("postgres"),
  pgPort: z.coerce.number().default(5432),
  pgDatabase: z.string().default("mesh"),
  pgUser: z.string().default("mesh"),
  pgPassword: z.string().default("mesh"),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Env-first config (compose injects everything); mirrors blossom's Zod gate. */
export function loadConfig(): Config {
  const raw = {
    hostname: Deno.env.get("PG_AGENT_HOSTNAME"),
    port: Deno.env.get("PG_AGENT_PORT"),
    token: Deno.env.get("PG_AGENT_TOKEN"),
    pgHost: Deno.env.get("MESH_PG_HOST"),
    pgPort: Deno.env.get("MESH_PG_PORT"),
    pgDatabase: Deno.env.get("MESH_PG_DATABASE"),
    pgUser: Deno.env.get("MESH_PG_USER"),
    pgPassword: Deno.env.get("MESH_PG_PASSWORD"),
  };
  const entries = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
  const parsed = ConfigSchema.safeParse(entries);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      console.error(`config: ${issue.path.join(".")} — ${issue.message}`);
    }
    Deno.exit(1);
  }
  return parsed.data;
}