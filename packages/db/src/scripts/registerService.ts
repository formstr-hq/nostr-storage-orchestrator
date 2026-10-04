// Registers (or updates) an internal service identity. The npub's role in the
// User table is what gates NIP-98 access to the internal endpoints; there is
// no shared token. Run on the host with the same DATABASE_URL the db-api uses:
//
//   npm run register:service -- <npub|hex>            # role=service (default)
//   npm run register:service -- <npub|hex> admin      # role=admin
//
// The service account's nsec belongs in the caller's environment
// (DB_API_SERVICE_NSEC / STORAGE_SERVICE_NSEC); it never needs to be stored
// here.
import { prisma } from "../prisma.js";
import { nip19 } from "nostr-tools";

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("--"));
  // Optional role: a bare positional ("service"/"admin") or --role <value>.
  const flagIndex = args.indexOf("--role");
  const role =
    (flagIndex >= 0 ? args[flagIndex + 1] : undefined) ??
    args.find((arg) => arg === "service" || arg === "admin") ??
    "service";

  if (!target) {
    console.error("usage: register:service -- <npub|hex> [service|admin]");
    process.exit(1);
  }
  if (role !== "service" && role !== "admin") {
    console.error("role must be 'service' or 'admin'");
    process.exit(1);
  }

  const npub = target.startsWith("npub1") ? target : nip19.npubEncode(target);
  try {
    const user = await prisma.user.upsert({
      where: { npub },
      update: { role },
      create: { npub, role },
    });
    console.log(JSON.stringify({ npub: user.npub, role: user.role }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
