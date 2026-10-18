import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Loc } from "../map/types.ts";
import { type SchemaIssue, validate } from "../schema/validate.ts";
import { type ExplorerName, KNOWLEDGE_DIR } from "./explorers.ts";

function collectLocs(value: unknown, at: string, out: Array<{ path: string; loc: Loc }>): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => { collectLocs(v, `${at}/${String(i)}`, out); });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record["file"] === "string" && typeof record["line"] === "number" && Object.keys(record).length === 2) {
    out.push({ path: at, loc: { file: record["file"], line: record["line"] } });
    return;
  }
  for (const [k, v] of Object.entries(record)) collectLocs(v, `${at}/${k}`, out);
}

/**
 * Schema, then evidence: every cited file:line must exist, since "every claim has evidence" is only worth
 * something if the evidence is real.
 */
export function checkKnowledge(root: string, name: ExplorerName): { exists: boolean; issues: SchemaIssue[] } {
  const file = path.join(root, KNOWLEDGE_DIR, `${name}.json`);
  if (!existsSync(file)) return { exists: false, issues: [{ path: "/", message: `${KNOWLEDGE_DIR}/${name}.json is missing` }] };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { exists: true, issues: [{ path: "/", message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const result = validate(`knowledge/${name}`, data);
  if (!result.ok) return { exists: true, issues: result.issues };

  const locs: Array<{ path: string; loc: Loc }> = [];
  collectLocs(data, "", locs);
  const lineCounts = new Map<string, number>();
  const issues: SchemaIssue[] = [];
  for (const { path: at, loc } of locs) {
    const target = path.resolve(root, loc.file);
    if (path.relative(root, target).startsWith("..") || !existsSync(target) || !statSync(target).isFile()) {
      issues.push({ path: at, message: `cites ${loc.file}, which doesn't exist` });
      continue;
    }
    let count = lineCounts.get(loc.file);
    if (count === undefined) {
      count = readFileSync(target, "utf8").split("\n").length;
      lineCounts.set(loc.file, count);
    }
    if (loc.line > count) issues.push({ path: at, message: `cites ${loc.file}:${String(loc.line)}, but the file has ${String(count)} lines` });
  }
  return { exists: true, issues };
}
