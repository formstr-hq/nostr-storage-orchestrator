import { pathToFileURL } from "node:url";
import { loadRelayConfig, requireBackendRelays } from "./config.js";
import { createRelayServer, type RelayServer } from "./server.js";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

let relayServer: RelayServer | undefined;

export function startRelayServer(): RelayServer {
  const relayConfig = loadRelayConfig();
  requireBackendRelays(relayConfig.backendRelays);
  relayServer = createRelayServer({ relayConfig });
  relayServer.server.listen(relayConfig.relayPort, () => {
    console.log(`Nostr relay listening on port ${relayConfig.relayPort}`);
  });
  return relayServer;
}

if (isMainModule()) {
  startRelayServer();
}

export function getRelayServer(): RelayServer {
  if (!relayServer) {
    throw new Error("Relay server has not been started");
  }
  return relayServer;
}
