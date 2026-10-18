import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { ensureGitignore } from "../managed/block.ts";
import { validate } from "../schema/validate.ts";
import type { LocalConfig, Unknown } from "./types.ts";

export const LOCAL_PATH = ".plumb/local.json";

export function loadLocal(root: string): LocalConfig {
  const file = path.join(root, LOCAL_PATH);
  if (!existsSync(file)) return { env: {}, services: {}, notes: [] };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CouldNotCompleteError(`${LOCAL_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = validate("local", data);
  if (!result.ok) throw new CouldNotCompleteError(`${LOCAL_PATH} is invalid: ${result.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  return data as LocalConfig;
}

function isTracked(root: string, rel: string): boolean {
  // --error-unmatch exits 1 for an untracked path: that's the answer, not a failure.
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root, stdio: "ignore" });
  if (result.error !== undefined) throw result.error;
  return result.status === 0;
}

/** Stores an answer where its unknown id says. local.json holds secrets, so it must never be committable. */
export function setUnknown(root: string, id: string, value: string): LocalConfig {
  if (isTracked(root, LOCAL_PATH)) throw new CouldNotCompleteError(`${LOCAL_PATH} is tracked by git; remove it from the index (git rm --cached ${LOCAL_PATH}) before storing secrets in it`);
  const local = loadLocal(root);
  const env = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(id);
  const service = /^service\.([a-z0-9][a-z0-9_-]*)\.(skip|start|stop)$/.exec(id);
  const note = /^note\.[a-z0-9][a-z0-9_.-]*$/.exec(id);
  if (env?.[1] !== undefined) local.env[env[1]] = value;
  else if (service?.[1] !== undefined && service[2] !== undefined) {
    const entry = local.services[service[1]] ?? {};
    if (service[2] === "skip") {
      if (value !== "true" && value !== "false") throw new UsageError(`${id} takes true or false`);
      entry.skip = value === "true";
    } else if (value.trim() === "") throw new UsageError(`${id} needs a command`);
    else entry[service[2] as "start" | "stop"] = value;
    local.services[service[1]] = entry;
  } else if (note !== null) local.notes = [...local.notes.filter((n) => !n.startsWith(`${id}: `)), `${id}: ${value}`];
  else throw new UsageError(`"${id}" is not an unknown id (env.<NAME>, service.<name>.skip|start|stop, or note.<id>)`);

  ensureGitignore(root);
  mkdirSync(path.join(root, ".plumb"), { recursive: true });
  writeFileSync(path.join(root, LOCAL_PATH), `${JSON.stringify(local, null, 2)}\n`);
  return local;
}

/** Whether local.json already answers an unknown. */
export function isAnswered(local: LocalConfig, unknown: Unknown): boolean {
  const [kind, name, field] = unknown.id.split(".");
  if (kind === "env" && name !== undefined) return Object.hasOwn(local.env, name);
  if (kind === "service" && name !== undefined && field !== undefined) return local.services[name]?.[field as "skip" | "start" | "stop"] !== undefined;
  return local.notes.some((n) => n.startsWith(`${unknown.id}: `));
}
