import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_NAMES, type SchemaName, validate } from "../src/schema/validate.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const root = fileURLToPath(new URL("../", import.meta.url));

function fixture(name: SchemaName): Json {
  return JSON.parse(readFileSync(new URL(`fixtures/schemas/${name}.json`, import.meta.url), "utf8")) as Json;
}

// Returns the issue paths after setting `path` (object keys and array indexes) to `value` in a copy of the valid fixture.
function issuesWith(name: SchemaName, path: Array<string | number>, value: Json): string[] {
  const doc = structuredClone(fixture(name));
  let node: Json = doc;
  for (const key of path.slice(0, -1)) {
    node = (node as Record<string | number, Json>)[key] as Json;
  }
  (node as Record<string | number, Json>)[path.at(-1) as string | number] = value;
  const result = validate(name, doc);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe("schemas", () => {
  it("registers every schema file under schemas/", () => {
    const onDisk = globSync("schemas/**/*.json", { cwd: root })
      .map((file) => file.replace(/^schemas\//, "").replace(/\.json$/, ""))
      .filter((name) => name !== "common")
      .sort();
    expect(onDisk).toEqual([...SCHEMA_NAMES].sort());
  });

  it.each(SCHEMA_NAMES)("accepts the valid %s fixture", (name) => {
    expect(validate(name, fixture(name))).toEqual({ ok: true });
  });

  it("rejects an edge without evidence", () => {
    expect(issuesWith("map/component", ["edges", 0, "evidence"], [])).toContain("/edges/0/evidence");
  });

  it("rejects inferred provenance that names an extractor", () => {
    const provenance = { source: "inferred", confidence: "low", extractor: "x" };
    expect(issuesWith("map/component", ["edges", 1, "provenance"], provenance)).toContain("/edges/1/provenance");
  });

  it("rejects a manifest from a future schema version", () => {
    expect(issuesWith("map/manifest", ["schemaVersion"], 2)).toContain("/schemaVersion");
  });

  it("rejects an unknown profile strategy", () => {
    expect(issuesWith("profile", ["strategy"], "desktop")).toContain("/strategy");
  });

  it("rejects a scoped test command without a {files} placeholder", () => {
    expect(issuesWith("profile", ["checks", "unit", "scoped"], "pnpm vitest related --run")).toContain("/checks/unit/scoped");
  });

  it.each(["/abs/path", "../outside", "apps/../../x"])("rejects a non-repo-relative cwd %s", (cwd) => {
    expect(issuesWith("profile", ["install", "cwd"], cwd)).toContain("/install/cwd");
  });

  it("rejects a feature tier outside fast-only and deep", () => {
    expect(issuesWith("features", ["features", 0, "tier"], "slow")).toContain("/features/0/tier");
  });

  it("names the unexpected key in a config", () => {
    const result = validate("config", { schemaVersion: 1, strategies: "web-app" });
    expect(result).toEqual({ ok: false, issues: [{ path: "/", message: "must NOT have additional properties (strategies)" }] });
  });
});
