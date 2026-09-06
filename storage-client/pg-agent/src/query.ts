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
    // A single statement with one optional trailing semicolon.
    const text = parsed.data.sql.trim().replace(/;\s*$/, "");
    if (!/^(select|with)\b/i.test(text) || text.includes(";")) {
      return errorResponse(ctx, 400, "only_single_select_supported");
    }
    try {
      // describe() prepares (no execution); run it on its own pending query
      // before executing — awaiting a pending query twice would deadlock.
      let described: { columns: Array<{ name: string; type: number }> } | undefined;
      try {
        const d = await sql.unsafe(text).describe();
        described = d as { columns: Array<{ name: string; type: number }> };
      } catch (describeError) {
        console.error("describe failed:", describeError);
      }
      const rows = await sql.unsafe(text);
      const json = rows.map((row) => {
        const output: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
          output[column] = serializeValue(value);
        }
        return output;
      });
      // Column OIDs (via prepare/Describe) so the gateway can emit real PG
      // types on the wire instead of everything-as-TEXT. Boolean "f" as a
      // TEXT string is truthy in JS clients — a real correctness bug.
      const columns = (described?.columns ?? []).map((column: { name: string; type: number }) => ({
        name: column.name,
        oid: column.type,
      }));
      return ctx.json({ rows: json, columns });
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
  // bytea -> hex text ("\\x79be..."). Row ids and pk filters at the gateway
  // compare value_as_string against hex; arrays of ints lose round-trips.
  if (value instanceof Uint8Array) return "\\x" + Array.from(value).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") return value;
  return value;
}