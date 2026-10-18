import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CouldNotCompleteError } from "../errors.ts";
import { type SchemaName, validate } from "../schema/validate.ts";
import { MAP_DIR } from "./build.ts";
import { componentFileName } from "./ids.ts";
import type { Component, Manifest, RepoMap, Resources } from "./types.ts";

/** Writes one map file if its content differs; returns whether it did. */
export function writeOne(root: string, rel: string, content: string): boolean {
  const file = path.join(root, MAP_DIR, rel);
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return true;
}

/** Writes changed files only and removes component files for components that no longer exist. Summaries (.md) are left alone. */
export function writeMap(root: string, files: ReadonlyMap<string, string>): { changed: string[]; removed: string[] } {
  const dir = path.join(root, MAP_DIR);
  mkdirSync(path.join(dir, "components"), { recursive: true });
  const changed = [...files].filter(([rel, content]) => writeOne(root, rel, content)).map(([rel]) => rel);
  const removed: string[] = [];
  for (const name of readdirSync(path.join(dir, "components"))) {
    const rel = `components/${name}`;
    if (name.endsWith(".json") && !files.has(rel)) {
      rmSync(path.join(dir, rel));
      removed.push(rel);
    }
  }
  return { changed, removed };
}

/** The map files currently on disk, keyed like renderMap's output; empty when there is no map yet. */
export function readMapFiles(root: string): Map<string, string> {
  const dir = path.join(root, MAP_DIR);
  const files = new Map<string, string>();
  for (const rel of ["manifest.json", "resources.json"]) {
    if (existsSync(path.join(dir, rel))) files.set(rel, readFileSync(path.join(dir, rel), "utf8"));
  }
  if (existsSync(path.join(dir, "components"))) {
    for (const name of readdirSync(path.join(dir, "components")).filter((n) => n.endsWith(".json")).sort()) {
      files.set(`components/${name}`, readFileSync(path.join(dir, "components", name), "utf8"));
    }
  }
  return files;
}

function readValidated(root: string, rel: string, schema: SchemaName): unknown {
  const file = path.join(root, MAP_DIR, rel);
  if (!existsSync(file)) throw new CouldNotCompleteError(`${MAP_DIR}/${rel} is missing; run plumb map`);
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  const result = validate(schema, data);
  if (!result.ok) {
    throw new CouldNotCompleteError(`${MAP_DIR}/${rel} is invalid (${result.issues.map((i) => `${i.path} ${i.message}`).join("; ")}); run plumb map`);
  }
  return data;
}

export function loadMap(root: string): RepoMap {
  // Each file is schema-validated before it is trusted as its type.
  const manifest = readValidated(root, "manifest.json", "map/manifest") as Manifest;
  return {
    manifest,
    components: manifest.components.map((id) => readValidated(root, `components/${componentFileName(id)}.json`, "map/component") as Component),
    resources: readValidated(root, "resources.json", "map/resources") as Resources,
  };
}
