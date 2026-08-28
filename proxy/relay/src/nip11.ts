import type express from "express";
import type { RelayConfig } from "./config.js";

function buildNip11Document(relayConfig: RelayConfig) {
  return {
    name: "nostr-storage-orchestrator relay",
    description: "Authenticated-write Nostr relay proxy with multi-backend aggregation",
    supported_nips: [1, 11, 42],
    software: relayConfig.software,
    version: relayConfig.version,
    limitation: {
      auth_required: false,
      restricted_writes: true,
      max_subid_length: 64,
    },
  };
}

function setNip11Cors(res: express.Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

export function registerNip11Routes(app: express.Express, relayConfig: RelayConfig): void {
  const nip11Document = buildNip11Document(relayConfig);

  app.options("/", (_req, res) => {
    setNip11Cors(res);
    res.status(204).end();
  });

  app.get("/", (req, res) => {
    const accept = req.headers.accept ?? "";
    if (accept.includes("application/nostr+json")) {
      setNip11Cors(res);
      res.setHeader("Content-Type", "application/nostr+json");
      res.status(200).json(nip11Document);
      return;
    }
    res.status(200).send("Nostr relay");
  });
}
