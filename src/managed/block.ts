import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Appends a `# plumb:managed:start <name>` ... `# plumb:managed:end <name>` block to a user's file (creating the
 * file if needed). A block that already exists is left exactly as it is.
 * SIMPLIFIED: append-if-missing only. M7 adds content hashes, in-place regeneration, and .plumb-new on conflict.
 */
export function ensureManagedBlock(root: string, rel: string, name: string, lines: readonly string[]): boolean {
  const file = path.join(root, rel);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes(`# plumb:managed:start ${name}`)) return false;
  const block = [`# plumb:managed:start ${name}`, ...lines, `# plumb:managed:end ${name}`].join("\n");
  const separator = current === "" || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(file, `${current}${separator}${block}\n`);
  return true;
}

/** Plumb's uncommitted paths (doc 2): raw findings, secrets, evidence, stamps, caches. */
export function ensureGitignore(root: string): boolean {
  return ensureManagedBlock(root, ".gitignore", "gitignore", [".plumb/knowledge/", ".plumb/local.json", ".plumb/evidence/", ".plumb/stamps/", ".plumb/cache/"]);
}
