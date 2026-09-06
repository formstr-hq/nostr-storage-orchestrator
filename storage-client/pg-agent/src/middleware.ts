import type { Context, Next } from "@hono/hono";

export function errorResponse(ctx: Context, status: 400 | 401 | 500 | 503, reason: string) {
  return ctx.json({ error: reason }, status);
}

export const corsMiddleware = () => async (_ctx: Context, next: Next) => {
  await next();
};

/** Track mesh table versions in a metadata table (idempotent, additive). */
export const META_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _mesh_pg_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export async function currentSchemaVersion(sql: postgres.Sql): Promise<number> {
  try {
    const rows = await sql`
      SELECT value FROM _mesh_pg_meta WHERE key = 'schema_version'
    `;
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch {
    return 0;
  }
}