import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

function createClient(): PrismaClient {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is not set; copy .env.example to .env at the workspace root");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Dev servers re-evaluate modules on reload; reuse one client so reloads don't leak connection pools.
const globalForPrisma = globalThis as typeof globalThis & { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createClient();
if (process.env["NODE_ENV"] !== "production") globalForPrisma.prisma = prisma;
