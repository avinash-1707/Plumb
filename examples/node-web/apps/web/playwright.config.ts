import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env["PORT"] ?? 3000);
const apiPort = Number(process.env["API_PORT"] ?? 4000);

// Postgres must already be running and seeded: `pnpm db:setup` from the workspace root.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @node-web/api start",
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: process.env["CI"] === undefined,
      env: { API_PORT: String(apiPort) },
    },
    {
      command: "pnpm dev",
      url: `http://localhost:${webPort}`,
      reuseExistingServer: process.env["CI"] === undefined,
      env: { PORT: String(webPort), API_URL: `http://localhost:${apiPort}` },
    },
  ],
});
