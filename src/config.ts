import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type SchemaIssue, validate } from "./schema/validate.ts";

export interface Config {
  schemaVersion: 1;
  strategy?: "library-cli" | "api-backend" | "web-app" | "monorepo";
  components?: Array<{ id: string; include: string[] }>;
  ignore?: string[];
  deepIgnore?: string[];
  gate?: { smoke?: boolean; budgetSec?: number };
  review?: {
    concerns?: Array<"architecture" | "resilience" | "concurrency" | "resources">;
    blockAt?: "critical" | "high" | "medium";
    maxAgents?: number;
  };
}

export class ConfigError extends Error {
  readonly issues: SchemaIssue[];

  constructor(file: string, issues: SchemaIssue[]) {
    super(`${file} is invalid: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
    this.issues = issues;
  }
}

export const CONFIG_PATH = ".plumb/config.json";

/** Reads .plumb/config.json; a repo without one gets the defaults. */
export function loadConfig(root: string): Config {
  const file = path.join(root, CONFIG_PATH);
  if (!existsSync(file)) return { schemaVersion: 1 };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(CONFIG_PATH, [{ path: "/", message: err instanceof Error ? err.message : String(err) }]);
  }
  const result = validate("config", data);
  if (!result.ok) throw new ConfigError(CONFIG_PATH, result.issues);
  return checkConfig(data as Config, CONFIG_PATH);
}

/** Rules JSON Schema can't express. */
export function checkConfig(config: Config, source: string): Config {
  const ids = (config.components ?? []).map((c) => c.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new ConfigError(source, [{ path: "/components", message: `component id "${duplicate}" appears more than once` }]);
  return config;
}
