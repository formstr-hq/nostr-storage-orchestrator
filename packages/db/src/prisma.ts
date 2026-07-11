import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

// Connection info is derived from the POSTGRES_* vars unless DATABASE_URL
// is explicitly set (e.g. to point at an external database like Neon).
// Docker overrides POSTGRES_HOST/POSTGRES_PORT via docker-compose.yml to
// point at the compose-managed postgres instead of localhost.
//
// Structured config (not a hand-built connection string) so
// POSTGRES_PASSWORD never needs URL-encoding — arbitrary passwords
// containing `/`, `@`, `:`, etc. would otherwise silently corrupt a
// naively interpolated `postgresql://user:pass@host/db` string.
const adapter = process.env.DATABASE_URL
  ? new PrismaPg({ connectionString: process.env.DATABASE_URL })
  : new PrismaPg({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
    });

export const prisma = new PrismaClient({ adapter });

export * from "../generated/prisma/client.js";
