// /pg/health — extends the blossom health with mesh-PG table state; the
// gateway's catch-up loop uses the version to detect stragglers.

import { Hono } from "@hono/hono";
import type postgres from "postgres";
import { currentSchemaVersion } from "./middleware.ts";

export function buildHealthRouter(sql: postgres.Sql) {
  const app = new Hono();

  // Unauthenticated: the Docker healthcheck (deno eval fetch, no headers)
  // and operators probe this endpoint. It carries no secrets — only the
  // schema version and public table names. Data endpoints (apply/schema/
  // query) stay bearer-protected.
  app.get("/health", async (ctx) => {
    try {
      const version = await currentSchemaVersion(sql);
      // Exclude gateway bookkeeping tables (leading underscore). Uses a POSIX
      // regex, not LIKE: in a JS tagged template `'\_%'` collapses to `'_%'`
      // (the backslash is dropped), so `NOT LIKE '_%'` silently excluded EVERY
      // non-empty table name and health always reported an empty list.
      const tables = await sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename !~ '^_'
      `;
      return ctx.json({
        status: "ok",
        version,
        tables: tables.map((row) => row.tablename),
      });
    } catch (error) {
      console.error("pg health failed:", error);
      return ctx.json({ status: "degraded", version: 0, tables: [] });
    }
  });

  return app;
}