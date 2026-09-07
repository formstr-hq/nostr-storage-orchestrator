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

// Mesh-PG endpoints under /pg/*. The auth middleware exempts /pg/health:
// it must be probeable without credentials (Docker healthcheck sends a
// bare fetch, operators probe directly), and it exposes nothing sensitive
// (schema version + public table names). Note Hono's route() mounting has
// no precedence — an earlier "/pg/health" mount would still be caught by
// this "/pg" middleware, so the exemption lives here, in the middleware
// itself (verified: /pg/health -> 200, /pg/apply -> 401).
app.route(
  "/pg",
  new Hono()
    .use("*", async (ctx, next) => {
      if (ctx.req.path === "/pg/health") return next();
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