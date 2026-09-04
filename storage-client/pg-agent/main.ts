// pg-agent: HTTP facade over the provider-local postgres `mesh` database.
// The orchestrator's pg-gateway reaches these /pg/* endpoints over the NVPN
// mesh; postgres itself is never exposed.

import { Hono } from "@hono/hono";
import postgres from "postgres";
import { z } from "zod";
import { corsMiddleware, errorResponse } from "./src/middleware.ts";
import { buildApplyRouter } from "./src/apply.ts";
import { buildQueryRouter } from "./src/query.ts";
import { buildSchemaRouter } from "./src/schema.ts";
import { buildHealthRouter } from "./src/health.ts";
import { loadConfig } from "./src/config.ts";

const config = loadConfig();

// postgres-js: max 5 connections; only the gateway talks to this instance.
const sql = postgres({
  host: config.pgHost,
  port: config.pgPort,
  database: config.pgDatabase,
  username: config.pgUser,
  password: config.pgPassword,
  max: 8,
  idle_timeout: 30,
  connect_timeout: 10,
});

const app = new Hono<{ Variables: { token?: string } }>();

app.onError((error, ctx) => {
  console.error("pg-agent error:", error);
  return errorResponse(ctx, 500, "internal_error");
});

app.use("*", corsMiddleware());

// Mesh-PG endpoints sit under /pg/* and are mounted first.
app.route(
  "/pg",
  new Hono()
    .use("*", async (ctx, next) => {
      const token = ctx.req.header("authorization")?.replace(/^Bearer\s+/i, "");
      if (config.token && token !== config.token) {
        return errorResponse(ctx, 401, "invalid_token");
      }
      await next();
    })
    .route("/", buildHealthRouter(sql))
    .route("/", buildApplyRouter(sql))
    .route("/", buildSchemaRouter(sql))
    .route("/", buildQueryRouter(sql)),
);

Deno.serve({ hostname: config.hostname, port: config.port }, app.fetch);
console.log(`pg-agent listening on ${config.hostname}:${config.port}`);