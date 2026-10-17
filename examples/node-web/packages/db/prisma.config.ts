import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// The workspace keeps one .env at its root, shared by every app.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Read lazily rather than with env(), which throws: `prisma generate` must work before .env exists.
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
