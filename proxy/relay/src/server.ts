import { createServer, type Server } from "node:http";
import { DbClient } from "@orchestrator/db-client";
import express from "express";
import { WebSocketServer } from "ws";
import { type RelayConfig, loadRelayConfig } from "./config.js";
import { FrontendSubscriptionManager } from "./frontend-subscriptions.js";
import { registerNip11Routes } from "./nip11.js";
import { EventPublicationService } from "./publication.js";
import { RelayPool } from "./relay.js";
import { registerRelaySocketHandlers } from "./socket-handler.js";

export type RelayServer = {
  app: express.Express;
  server: Server;
  wss: WebSocketServer;
  relayPool: RelayPool;
  relayConfig: RelayConfig;
  listen: () => Promise<number>;
  close: () => Promise<void>;
};

export type CreateRelayServerOptions = {
  relayConfig?: RelayConfig;
  relayPool?: RelayPool;
  db?: DbClient;
};

export function createRelayServer(options: CreateRelayServerOptions = {}): RelayServer {
  const relayConfig = options.relayConfig ?? loadRelayConfig();
  const relayPool = options.relayPool ?? createRelayPool(relayConfig);
  const db = options.db ?? createDbClient();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  registerNip11Routes(app, relayConfig);

  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const publicationService = new EventPublicationService(db, relayPool, relayConfig);
  const subscriptions = new FrontendSubscriptionManager(relayPool, relayConfig.backendRelays);
  registerRelaySocketHandlers(wss, relayConfig.publicUrl, publicationService, subscriptions);

  return {
    app,
    server,
    wss,
    relayPool,
    relayConfig,
    listen: () => listen(server),
    close: () => close(server, wss, relayPool),
  };
}

function createRelayPool(relayConfig: RelayConfig): RelayPool {
  return new RelayPool({
    relays: relayConfig.backendRelays,
    initialEoseTimeoutMs: relayConfig.initialEoseTimeoutMs,
    publishAckTimeoutMs: relayConfig.publishAckTimeoutMs,
    ...(relayConfig.backendAuthSecretKey ? { backendAuthSecretKey: relayConfig.backendAuthSecretKey } : {}),
  });
}

function createDbClient(): DbClient {
  return new DbClient({
    baseUrl: process.env.DB_API_URL ?? `http://localhost:${process.env.DB_API_PORT}`,
  });
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind relay server"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server, wss: WebSocketServer, relayPool: RelayPool): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    relayPool.closeAll();
    wss.close((wssError) => {
      if (wssError) {
        reject(wssError);
        return;
      }
      server.close((serverError) => {
        if (serverError) {
          reject(serverError);
          return;
        }
        resolve();
      });
    });
  });
}
