// /pg/schema — applies ordered migrations idempotently and reports the
// current schema version. Also called by the catch-up loop for late joiners.

import { Hono } from "@hono/hono";
import type { postgres } from "postgres";
import { z } from "zod";
import { errorResponse } from "./middleware.ts";

const MigrationSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  ddl: z.string().min(1),
});

const BodySchema = z.object({ migrations: z.array(MigrationSchema).max(200) });

export function buildSchemaRouter(sql: postgres.Sql) {
  const app = new Hono();

  app.post("/schema", async (ctx) => {
    const body = await ctx.req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(ctx, 400, "invalid_migrations");
    }
    const migrations = parsed.data.migrations;
    try {
      await sql`CREATE TABLE IF NOT EXISTS _mesh_pg_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`;
      // Track applied migration ids so replays are no-ops.
      await sql`CREATE TABLE IF NOT EXISTS _mesh_pg_migrations (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;

      let version = await currentVersion(sql);
      for (const migration of migrations) {
        const known = await sql`
          SELECT 1 FROM _mesh_pg_migrations WHERE id = ${migration.id}
        `;
        if (known.length > 0) continue;
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.ddl);
          await tx`
            INSERT INTO _mesh_pg_migrations (id, version) VALUES (${migration.id}, ${migration.version})
          `;
        });
        version = Math.max(version, migration.version);
      }
      await sql`
        INSERT INTO _mesh_pg_meta (key, value) VALUES ('schema_version', ${String(version)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
      return ctx.json({ version });
    } catch (error) {
      console.error("schema apply failed:", error);
      return errorResponse(ctx, 500, error instanceof Error ? error.message : "schema_failed");
    }
  });

  return app;
}

async function currentVersion(sql: postgres.Sql): Promise<number> {
  const rows = await sql`
    SELECT value FROM _mesh_pg_meta WHERE key = 'schema_version'
  `;
  return rows.length > 0 ? Number(rows[0].value) : 0;
}