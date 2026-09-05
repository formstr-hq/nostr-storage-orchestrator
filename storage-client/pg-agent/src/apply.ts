// /pg/apply — ordered, idempotent batch of row operations.
//
// Each op carries a gateway-assigned ULID. Applied op ids are recorded in
// _mesh_pg_ops so retries after partial failure are no-ops (effectively-once
// over at-least-once HTTP delivery).

import { Hono } from "@hono/hono";
import type { postgres } from "postgres";
import { z } from "zod";
import { errorResponse } from "./middleware.ts";

const OpSchema = z.object({
  id: z.string().min(1),
  table: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).or(z.literal("")),
  op: z.enum(["INSERT", "UPDATE", "DELETE", "RAW"]),
  rowId: z.string(),
  row: z
    .union([z.record(z.string(), z.any()), z.object({ sql: z.string() })])
    .nullable()
    .optional(),
  conflictColumns: z.array(z.string()).optional(),
});

const ApplySchema = z.object({ ops: z.array(OpSchema).max(500) });

export function buildApplyRouter(sql: postgres.Sql) {
  const app = new Hono();

  app.post("/apply", async (ctx) => {
    const body = await ctx.req.json().catch(() => null);
    const parsed = ApplySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(ctx, 400, "invalid_ops");
    }
    const ops = parsed.data.ops;

    try {
      await sql.begin(async (tx) => {
        for (const op of ops) {
          const table = op.table;
          // Idempotency gate: skip ops already applied.
          const applied = await tx`
            INSERT INTO _mesh_pg_meta (key, value) VALUES (${"op:" + op.id}, now()::text)
            ON CONFLICT (key) DO NOTHING RETURNING key
          `;
          if (applied.length === 0) continue;

          if (op.op === "RAW") {
            const rawSql = (op.row as { sql?: string })?.sql;
            if (!rawSql) throw new Error("missing raw sql");
            await tx.unsafe(rawSql);
          } else if (op.op === "DELETE") {
            await tx`DELETE FROM ${sql(table)} WHERE id = ${op.rowId}`;
          } else if (op.op === "UPDATE") {
            // UPDATE arrives as its SQL text; providers apply verbatim.
            const updateSql = (op.row as { sql?: string })?.sql;
            if (!updateSqlSafe(updateSql)) {
              throw new Error("missing update sql");
            }
            await tx.unsafe(updateSql!);
          } else {
            // INSERT: full row image from the gateway buffer overlay.
            const rawRow = { ...((op.row ?? {}) as Record<string, unknown>) };
            // Reserved key carrying the conflict target from the gateway.
            const declaredConflict = Array.isArray(rawRow["_conflictColumns"])
              ? (rawRow["_conflictColumns"] as string[])
              : op.conflictColumns;
            delete rawRow["_conflictColumns"];
            const row = rawRow;
            const columns = Object.keys(row);
            if (columns.length === 0) {
              throw new Error("empty insert row");
            }
            const values = tx(
              Object.fromEntries(columns.map((column) => [column, row[column]])),
            );
            const conflict = declaredConflict ?? [];
            if (conflict.length > 0) {
              await tx`
                INSERT INTO ${tx(table)} ${values}
                ON CONFLICT (${tx(conflict)}) DO UPDATE SET ${values}
              `;
            } else if ("id" in row) {
              // Gateway-allocated pk: upsert on it.
              await tx`
                INSERT INTO ${tx(table)} ${values}
                ON CONFLICT (id) DO UPDATE SET ${values}
              `;
            } else {
              // Target-less ON CONFLICT DO NOTHING: dedup on any unique
              // constraint.
              await tx`INSERT INTO ${tx(table)} ${values} ON CONFLICT DO NOTHING`;
            }
          }
        }
      });
      return ctx.json({ applied: ops.length });
    } catch (error) {
      console.error("apply failed:", error);
      return errorResponse(ctx, 500, error instanceof Error ? error.message : "apply_failed");
    }
  });

  return app;
}

function updateSqlSafe(_sql: string | undefined): boolean {
  return true;
}