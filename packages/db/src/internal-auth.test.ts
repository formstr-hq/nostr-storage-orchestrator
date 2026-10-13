import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import express from "express";
import { requireServiceAccount } from "./internal-auth.js";

// Regression guard for a silent hole that existed in production: the gate was
// exported with four parameters, so Express classified it as an error handler
// and skipped it on normal requests — every "service-gated" route was actually
// open. Arity must stay at three, and the route must reject anonymous callers.
test("the service-account gate runs as normal middleware and rejects anonymous requests", async () => {
  assert.equal(requireServiceAccount.length, 3, "four-argument middleware is skipped by Express");

  const app = express();
  app.get("/guarded", requireServiceAccount, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/guarded`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "unauthorized");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
