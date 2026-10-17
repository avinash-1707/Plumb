import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// The workspace keeps one .env at its root; variables already set in the environment win.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const apiUrl = process.env["API_URL"] ?? "http://localhost:4000";

const config: NextConfig = {
  // next dev otherwise writes an AGENTS.md whose content tracks the Next version, churning the committed tree.
  agentRules: false,
  // @node-web/db ships TypeScript source.
  transpilePackages: ["@node-web/db"],
  // Same-origin proxy so the API's session cookie works from the browser.
  rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default config;
