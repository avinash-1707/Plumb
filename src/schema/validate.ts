import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

// Schemas ship with the package at <root>/schemas; this file sits at src/schema or dist/schema.
const SCHEMA_DIR = new URL("../../schemas/", import.meta.url);

export const SCHEMA_NAMES = ["map/manifest", "map/component", "map/resources", "profile", "features", "config"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

// Referenced by other schemas, never validated against directly.
const SHARED_SCHEMAS = ["common"] as const;

export interface SchemaIssue {
  /** JSON pointer into the validated document; "/" is the root. */
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: SchemaIssue[] };

function readSchema(name: string): object {
  const file = new URL(`${name}.json`, SCHEMA_DIR);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${file.pathname} is not a JSON object`);
  }
  return parsed;
}

function toIssue(error: ErrorObject): SchemaIssue {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  const extra =
    error.keyword === "additionalProperties" && "additionalProperty" in error.params
      ? ` (${String(error.params.additionalProperty)})`
      : "";
  return { path, message: `${error.message ?? error.keyword}${extra}` };
}

let validators: Map<SchemaName, ValidateFunction> | undefined;

function compileAll(): Map<SchemaName, ValidateFunction> {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const name of [...SHARED_SCHEMAS, ...SCHEMA_NAMES]) ajv.addSchema(readSchema(name));
  const compiled = new Map<SchemaName, ValidateFunction>();
  for (const name of SCHEMA_NAMES) {
    const validate = ajv.getSchema(`plumb:/schemas/${name}.json`);
    if (validate === undefined) throw new Error(`schema ${name} has no matching $id`);
    compiled.set(name, validate);
  }
  return compiled;
}

/** Validates `data` against a Plumb schema; issues are precise enough to hand back to an agent to fix. */
export function validate(name: SchemaName, data: unknown): ValidationResult {
  validators ??= compileAll();
  const validator = validators.get(name);
  if (validator === undefined) throw new Error(`unknown schema ${name}`);
  if (validator(data)) return { ok: true };
  return { ok: false, issues: (validator.errors ?? []).map(toIssue) };
}
