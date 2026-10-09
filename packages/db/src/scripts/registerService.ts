// Registers (or updates) an internal service account. The npub's presence in
// the service_account table (with enabled = true) is what gates NIP-98 access
// to the internal endpoints; there is no shared token. Run on the host with
// the same DATABASE_URL the db-api uses:
//
//   npm run register:service -- <npub|hex>              # create/enable
//   npm run register:service -- <npub|hex> --label "backend"
//   npm run register:service -- <npub|hex> --disable    # revoke without delete
//
// The service account's nsec belongs in the caller's environment
// (SERVICE_NSEC / STORAGE_SERVICE_NSEC); it never needs to be stored here.
import { prisma } from "../prisma.js";
import { nip19 } from "nostr-tools";

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("--"));
  const labelIndex = args.indexOf("--label");
  const label = labelIndex >= 0 ? args[labelIndex + 1] : undefined;
  const enabled = !args.includes("--disable");

  if (!target) {
    console.error("usage: register:service -- <npub|hex> [--label <name>] [--disable]");
    process.exit(1);
  }

  const npub = target.startsWith("npub1") ? target : nip19.npubEncode(target);
  try {
    const account = await prisma.serviceAccount.upsert({
      where: { npub },
      update: { enabled, ...(label !== undefined ? { label } : {}) },
      create: { npub, enabled, ...(label !== undefined ? { label } : {}) },
    });
    console.log(JSON.stringify({ npub: account.npub, enabled: account.enabled, label: account.label }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
