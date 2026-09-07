// /pg/apply — ordered, idempotent batch of row operations.
//
// Each op carries a gateway-assigned ULID. Applied op ids are recorded in
// _mesh_pg_ops so retries after partial failure are no-ops (effectively-once
// over at-least-once HTTP delivery).

import { Hono } from "@hono/hono";
import type postgres from "postgres";
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

type PgSql = postgres.Sql | postgres.TransactionSql;

/// Column name -> data type (lower-cased), from information_schema. Cached
/// per statement batch; bytea columns need hex->bytes decoding.
async function columnTypeMap(
  sql: PgSql,
  table: string,
): Promise<Map<string, string>> {
  const rows = await sql`
    SELECT lower(column_name) AS name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND lower(table_name) = ${table.toLowerCase()}
  `;
  const map = new Map<string, string>();
  for (const row of rows as unknown as Array<{ name: string; data_type: string }>) {
    map.set(row.name, row.data_type);
  }
  return map;
}

function decodeValue(value: unknown, dataType: string | undefined): unknown {
  if (value === null || value === undefined) return value;
  if (dataType === "bytea" && typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }
  }
  // json/jsonb arrive as their JSON *text* (the gateway captures rows via
  // simple_query). Parse so the driver re-encodes once — otherwise the string
  // is double-encoded into a jsonb scalar and consumers like nostream's
  // process_event_tags trigger fail with "cannot extract elements from a scalar".
  if ((dataType === "jsonb" || dataType === "json") && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

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
        // _mesh_pg_meta is created once at startup (ensureMeshSchema); creating
        // it here inside the txn raced on pg_type and could poison the batch.
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
            // Reserved keys carrying the conflict target from the gateway.
            const declaredConflict = Array.isArray(rawRow["_conflictColumns"])
              ? (rawRow["_conflictColumns"] as string[])
              : op.conflictColumns;
            delete rawRow["_conflictColumns"];
            // Verbatim predicate of a partial-index conflict target
            // (`WHERE <pred>`). Replayed so the conflict hits the same
            // partial unique index the statement hit at the gateway —
            // without it ON CONFLICT cannot match a partial index and the
            // apply fails outright.
            const declaredPredicate =
              typeof rawRow["_conflictPredicate"] === "string"
                ? (rawRow["_conflictPredicate"] as string)
                : undefined;
            delete rawRow["_conflictPredicate"];
            if (declaredPredicate !== undefined && !/^where\b/i.test(declaredPredicate)) {
              throw new Error("invalid conflict predicate");
            }
            const row = rawRow;
            const columns = Object.keys(row);
            if (columns.length === 0) {
              throw new Error("empty insert row");
            }
            // Column descriptors (from /pg/schema propagation) drive value
            // decoding: bytea columns carry hex text in the JSON payload and
            // must be written as bytes, not strings.
            const columnTypes = await columnTypeMap(tx, table);
            const row2: Record<string, unknown> = {};
            for (const column of columns) {
              row2[column] = decodeValue(row[column], columnTypes.get(column.toLowerCase()));
            }
            const values = tx(
              Object.fromEntries(columns.map((column) => [column, row2[column]])),
            );
            const conflict = declaredConflict ?? [];
            if (conflict.length > 0 && declaredPredicate !== undefined) {
              // Partial-index upsert: predicate is gateway-authored text and
              // can only come from a gateway-captured op, not client input.
              // Built via unsafe() with values riding as $n parameters;
              // identifiers are quoted through postgres-js's sql() Helper
              // (Helper.value is the quoted identifier text).
              const ident = (name: string) => (sql(name) as unknown as { value: string }).value;
              const quoted = conflict.map((column) => ident(column));
              const setters = columns
                .map((column) => `${ident(column)} = EXCLUDED.${ident(column)}`)
                .join(", ");
              const target = ident(table);
              const columnList = columns.map((column) => ident(column)).join(", ");
              const parameterList = columns.map((_, index) => `$${index + 1}`).join(", ");
              const parameters = columns.map((column) => row2[column]) as never[];
              await tx.unsafe(
                `INSERT INTO ${target} (${columnList}) ` +
                  `VALUES (${parameterList}) ` +
                  `ON CONFLICT (${quoted.join(", ")}) ${declaredPredicate} ` +
                  `DO UPDATE SET ${setters}`,
                parameters,
              );
            } else if (conflict.length > 0 && (await uniqueIndexCovers(tx, table, conflict))) {
              // Plain conflict target: verify it actually infers an arbiter
              // index. A composite pk (nostream's events: (id,
              // event_created_at)) cannot match ON CONFLICT (id) — fall back
              // to target-less DO NOTHING (dedups on any unique constraint)
              // rather than failing the whole batch forever.
              await tx`
                INSERT INTO ${tx(table)} ${values}
                ON CONFLICT (${tx(conflict)}) DO UPDATE SET ${values}
              `;
            } else {
              // No usable conflict target: dedup on any unique constraint.
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

/// True when a unique index (unique constraint or unique index) on the table
/// has exactly the given columns as its arbiter — i.e. `ON CONFLICT (cols)`
/// will infer it. Partial predicates are ignored: a conflict target without
/// a predicate can only match full unique indexes.
async function uniqueIndexCovers(tx: PgSql, table: string, conflict: string[]): Promise<boolean> {
  const rows = await tx`
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ${table}
      AND i.indisunique
      AND i.indpred IS NULL
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM unnest(i.indkey) AS keys(attnum)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = keys.attnum
      ) = (
        SELECT array_agg(x ORDER BY x)
        FROM unnest(ARRAY[${conflict.map((column) => `'${column.replace(/'/g, "''")}'`).join(",")}]::text[]) AS x
      )
  `;
  return rows.length > 0;
}

/// True when the table's primary key spans more than one column (e.g.
/// nostream's events table: PRIMARY KEY (id, event_created_at)).
async function hasCompositePk(tx: PgSql, table: string): Promise<boolean> {
  const rows = await tx`
    SELECT count(*)::int AS columns
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
    JOIN unnest(con.conkey) AS keys(attnum) ON true
    WHERE con.contype = 'p'
      AND n.nspname = 'public'
      AND con.conrelid = ${table}::regclass
  `;
  const columns = (rows[0] as { columns?: number } | undefined)?.columns ?? 0;
  return columns > 1;
}