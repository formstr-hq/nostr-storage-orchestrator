// /pg/query — runs a read-only SELECT (verbatim PG SQL from the gateway)
// against the provider's mesh database and returns rows as JSON.

import { Hono } from "@hono/hono";
import type { postgres } from "postgres";
import { z } from "zod";
import { errorResponse } from "./middleware.ts";

const QuerySchema = z.object({
  sql: z.string().min(1),
});

export function buildQueryRouter(sql: postgres.Sql) {
  const app = new Hono();

  app.post("/query", async (ctx) => {
    const body = await ctx.req.json().catch(() => null);
    const parsed = QuerySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(ctx, 400, "invalid_query");
    }
    const text = parsed.data.sql.trim();
    // Read-only: a single statement, SELECT-shaped.
    if (!/^(select|with)\b/i.test(text) || text.includes(";")) {
      return errorResponse(ctx, 400, "only_single_select_supported");
    }
    try {
      const rows = await sql.unsafe(text);
      const json = rows.map((row) => {
        const output: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
          output[column] = serializeValue(value);
        }
        return output;
      });
      return ctx.json({ rows: json });
    } catch (error) {
      console.error("query failed:", error);
      return errorResponse(ctx, 500, error instanceof Error ? error.message : "query_failed");
    }
  });

  return app;
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") return value;
  return value;
}