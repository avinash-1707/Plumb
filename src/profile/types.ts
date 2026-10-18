// Mirrors schemas/profile.json.
import type { Loc } from "../map/types.ts";

export type Strategy = "library-cli" | "api-backend" | "web-app" | "monorepo";

export interface Command {
  cmd: string;
  cwd: string;
  timeoutSec: number;
}

export interface ScopedCommand extends Command {
  scoped: string | null;
}

export type ReadinessProbe = { kind: "http"; url: string; expectStatus: number } | { kind: "port"; port: number } | { kind: "log"; pattern: string };

export interface RunTarget {
  name: string;
  start: Command;
  ready: ReadinessProbe;
  stop: "signal" | Command;
  port: number | null;
  portEnv: string | null;
}

export interface Service {
  name: string;
  source: "docker-compose" | "local" | "external";
  start: Command | null;
  stop: Command | null;
  ready: ReadinessProbe | null;
}

export interface EnvRequirement {
  name: string;
  required: boolean;
  secret: boolean;
  defaultForVerification: string | null;
  source: "env-example" | "code" | "compose";
}

export interface Unknown {
  id: string;
  question: string;
  why: string;
  storesIn: "local.json";
}

export interface Profile {
  schemaVersion: 1;
  app: { name: string; slug: string };
  strategy: Strategy;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "pip" | "poetry" | "uv" | "go" | "cargo" | null;
  install: Command | null;
  build: Command | null;
  checks: {
    lint: Command | null;
    typecheck: Command | null;
    unit: ScopedCommand | null;
    integration: ScopedCommand | null;
    e2e: Command | null;
  };
  run: RunTarget[];
  services: Service[];
  env: EnvRequirement[];
  ui: {
    present: boolean;
    framework: string | null;
    baseUrl: string | null;
    harness: "existing-playwright" | "existing-cypress" | "playwright-mcp" | null;
    authRequired: boolean;
  };
  unknowns: Unknown[];
  evidence: Record<string, Loc[]>;
}

export interface LocalConfig {
  env: Record<string, string>;
  services: Record<string, { skip?: boolean; start?: string; stop?: string }>;
  notes: string[];
}
