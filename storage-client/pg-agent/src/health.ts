// /pg/health — extends the blossom health with mesh-PG table state; the
// gateway's catch-up loop uses the version to detect stragglers.

import { Hono } from "@hono/hono";
import type postgres from "postgres";
import { currentSchemaVersion } from "./middleware.ts";

export function buildHealthRouter(sql: postgres.Sql) {
  const app = new Hono();

  app.get("/health", async (ctx) => {
    try {
      const version = await currentSchemaVersion(sql);
      const tables = await sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '\_%'
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