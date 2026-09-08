// /pg/schema — applies ordered migrations idempotently and reports the
// current schema version. Also called by the catch-up loop for late joiners.

import { Hono } from "@hono/hono";
import type postgres from "postgres";
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
      // _mesh_pg_meta / _mesh_pg_migrations are created once at startup
      // (ensureMeshSchema); creating them here per-request raced on pg_type
      // ("duplicate key ... pg_type_typname_nsp_index") and failed the apply.
      let version = await currentVersion(sql);
      for (const migration of migrations) {
        const known = await sql`
          SELECT 1 FROM _mesh_pg_migrations WHERE id = ${migration.id}
        `;
        if (known.length > 0) continue;
        const ddl = stripServerGenerators(migration.ddl);
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(ddl);
            await tx`
              INSERT INTO _mesh_pg_migrations (id, version) VALUES (${migration.id}, ${migration.version})
            `;
          });
        } catch (error) {
          // Catch-up replays are not transactionally synchronized with the
          // gateway's direct RAW applies (fallback DDL is both pushed here
          // and applied via /pg/apply RAW ops). An "already exists" failure
          // means the object is present — the intended end state — so record
          // the migration as applied rather than wedging the provider. Any
          // other error is fatal (real schema drift).
          const message = error instanceof Error ? error.message : String(error);
          if (!ALREADY_EXISTS.test(message) && !DOES_NOT_EXIST.test(message)) {
            throw error;
          }
          await sql`
            INSERT INTO _mesh_pg_migrations (id, version) VALUES (${migration.id}, ${migration.version})
          `;
        }
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
/**
 * Strips server-side generators from propagated DDL. The gateway
 * materializes every generated value (serial via its central sequence,
 * gen_random_uuid, now()) before ops reach providers, so a provider that
 * also ran its own sequence/default would produce diverging replicas.
 * Providers become dumb row stores for defaults.
 *
 * Transformations:
 *   `bigserial`/`serial`  -> `bigint`/`integer` (no sequence at all)
 *   DEFAULT nextval(...)  -> removed
 *   DEFAULT gen_random_uuid() -> removed (gateway supplies)
 *   DEFAULT now()/CURRENT_TIMESTAMP -> removed (gateway supplies)
 */
export function stripServerGenerators(ddl: string): string {
  return ddl
    // serial -> plain integer types
    .replace(/\b(bigserial|serial8)\b/gi, "bigint")
    .replace(/\b(smallserial|serial2)\b/gi, "smallint")
    .replace(/\bserial4\b|\bserial(?![0-9a-zA-Z_])/gi, "integer")
    // GENERATED ... AS IDENTITY -> plain type (keep NOT NULL from the clause)
    .replace(/\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY(\s*\([^)]*\))?/gi, "")
    // DEFAULT nextval('...') -> drop the DEFAULT clause
    .replace(/DEFAULT\s+nextval\s*\(\s*'[^']*'\s*(::[^)\s]+)?\s*\)/gi, "")
    // NOTE: uuid defaults (gen_random_uuid / uuid_generate_v4) are intentionally
    // KEPT. The gateway supplies full rows (RETURNING *), so the default never
    // fires for gateway-applied rows; but locally-derived rows — e.g. those a
    // propagated trigger inserts (nostream's event_tags) — need it to generate
    // a local pk. A random uuid per provider is fine for such derived tables.
    // DEFAULT now() / CURRENT_TIMESTAMP / clock_timestamp()
    .replace(/DEFAULT\s+(?:pg_catalog\.)?(?:now|clock_timestamp)\s*\(\s*\)|DEFAULT\s+CURRENT_TIMESTAMP(\(\d*\))?|DEFAULT\s+'now'::text::timestamp(\s+with\s+time\s+zone)?/gi, "DEFAULT NULL")
    ;
}

/// PG error classes for "object already exists": duplicate_table (42P07),
/// duplicate_object (42710), duplicate_function (42723), duplicate_trigger
/// (42701), duplicate_schema (42P06), duplicate_database (42P04),
/// duplicate_index without a table (42P11 belongs to others; 42P07 covers
/// named indexes via duplicate_table semantics).
const ALREADY_EXISTS =
  /42P07|42710|42723|42701|42P06|42P04|already exists/i;

/// PG error classes for "object does not exist": undefined_object (42P01),
/// undefined_column (42703), undefined_parameter (42P02),
/// undefined_function (42883), invalid_name (42602). Catch-up replays may
/// re-send DROPs whose target is already gone (the DDL ran directly or the
/// provider replayed it before the ack was recorded) — the end state is the
/// intended one, so record the migration instead of wedging the provider.
const DOES_NOT_EXIST =
  /42P01|42703|42P02|42704|42602|42883|does not exist/i;
