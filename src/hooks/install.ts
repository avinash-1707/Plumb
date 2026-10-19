import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } from "yaml";
import { CouldNotCompleteError } from "../errors.ts";
import { shQuote } from "../gate/script.ts";
import { GitError } from "../git.ts";

export const INSTALL_RECORD = ".plumb/cache/hooks-install.json";
const CHAINED = "pre-commit.plumb-chained";

export type HookMethod = "core.hooksPath" | "husky" | "lefthook" | "pre-commit" | "git-hooks-chained" | "git-hooks";

/** What install changed, so uninstall can put every byte back. Paths are absolute. */
export interface InstallRecord {
  schemaVersion: 1;
  method: HookMethod;
  /**
   * Files Plumb created (original null) or modified (original = the bytes before, base64, with its mode), and the
   * sha256 of each right after install, to tell whether the user changed it since.
   */
  files: Array<{ path: string; original: string | null; mode: number | null; installed: string }>;
  /** Hooks Plumb moved aside to chain them (moved back on uninstall). */
  renamed: Array<{ from: string; to: string }>;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const stderr = typeof err === "object" && err !== null && "stderr" in err ? String(err.stderr).trim() : "";
    throw new GitError(`git ${args.join(" ")} failed${stderr === "" ? "" : `: ${stderr}`}`);
  }
}

function hooksPathConfig(root: string): string | null {
  try {
    return git(root, ["config", "--get", "core.hooksPath"]);
  } catch (err) {
    // `git config --get` exits 1 when the key isn't set.
    if (err instanceof GitError) return null;
    throw err;
  }
}

/** The gate command a hook runs, from the repository top level (hooks run there). */
function gateCommand(top: string, root: string): string {
  const rel = path.relative(top, path.join(root, ".plumb/gate.sh")).split(path.sep).join("/");
  return `sh ${/^[A-Za-z0-9_./-]+$/.test(rel) ? rel : shQuote(rel)}`;
}

function hookScript(gate: string, chained: boolean): string {
  return [
    "#!/bin/sh",
    "# plumb:managed:start pre-commit",
    "# Installed by `plumb hooks install`; `plumb hooks uninstall` restores what was here before.",
    ...(chained ? [`"$(dirname "$0")/${CHAINED}" "$@" || exit $?`] : []),
    `exec ${gate}`,
    "# plumb:managed:end pre-commit",
    "",
  ].join("\n");
}

export interface Detection {
  method: HookMethod;
  /** The file Plumb writes or edits. */
  target: string;
}

/** Doc 6's detection table, in order. A core.hooksPath inside .husky/ is husky's own wiring, so it counts as husky. */
export function detectHookSetup(root: string): Detection {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const hooksPath = hooksPathConfig(root);
  const huskyDir = path.join(top, ".husky");
  if (hooksPath !== null && hooksPath !== "") {
    const dir = path.resolve(top, hooksPath);
    if (!(existsSync(huskyDir) && (dir === huskyDir || dir.startsWith(`${huskyDir}${path.sep}`)))) return { method: "core.hooksPath", target: path.join(dir, "pre-commit") };
  }
  if (existsSync(huskyDir)) return { method: "husky", target: path.join(huskyDir, "pre-commit") };
  for (const name of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]) {
    if (existsSync(path.join(top, name))) return { method: "lefthook", target: path.join(top, name) };
  }
  if (existsSync(path.join(top, ".pre-commit-config.yaml"))) return { method: "pre-commit", target: path.join(top, ".pre-commit-config.yaml") };
  const hooksDir = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
  const hook = path.join(hooksDir, "pre-commit");
  return { method: existsSync(hook) ? "git-hooks-chained" : "git-hooks", target: hook };
}

function readRecord(root: string): InstallRecord | null {
  const file = path.join(root, INSTALL_RECORD);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as InstallRecord;
}

/**
 * A YAML edit through the Document API re-emits the whole file. Plumb accepts it only if every original line survives
 * unchanged and in order (it may only add lines); otherwise reformatting would touch the user's config.
 */
function onlyAdds(before: string, after: string, what: string, manual: string): string {
  const old = before.split("\n").filter((l) => l.trim() !== "");
  const next = after.split("\n");
  let j = 0;
  for (const line of next) if (j < old.length && line === old[j]) j++;
  if (j < old.length) throw new CouldNotCompleteError(`adding the gate to ${what} would reformat lines you wrote; add it by hand: ${manual}`);
  return after;
}

function lefthookEdit(text: string, gate: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new CouldNotCompleteError(`lefthook config is not valid YAML: ${doc.errors[0]?.message ?? ""}`);
  let preCommit = doc.get("pre-commit");
  if (preCommit === undefined || preCommit === null) {
    preCommit = new YAMLMap();
    doc.set("pre-commit", preCommit);
  }
  if (!isMap(preCommit)) throw new CouldNotCompleteError("lefthook config's pre-commit is not a mapping; add `sh .plumb/gate.sh` to it by hand");
  let commands = preCommit.get("commands");
  if (commands === undefined || commands === null) {
    commands = new YAMLMap();
    preCommit.set("commands", commands);
  }
  if (!isMap(commands)) throw new CouldNotCompleteError("lefthook config's pre-commit.commands is not a mapping; add `sh .plumb/gate.sh` to it by hand");
  commands.set("plumb-gate", doc.createNode({ run: gate }));
  return onlyAdds(text, doc.toString(), "the lefthook config", `pre-commit.commands.plumb-gate.run: ${gate}`);
}

function preCommitEdit(text: string, gate: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new CouldNotCompleteError(`.pre-commit-config.yaml is not valid YAML: ${doc.errors[0]?.message ?? ""}`);
  let repos = doc.get("repos");
  if (repos === undefined || repos === null) {
    repos = new YAMLSeq();
    doc.set("repos", repos);
  }
  if (!isSeq(repos)) throw new CouldNotCompleteError(".pre-commit-config.yaml's repos is not a list; add a local plumb-gate hook by hand");
  repos.add(doc.createNode({ repo: "local", hooks: [{ id: "plumb-gate", name: "plumb gate", entry: gate, language: "system", pass_filenames: false, always_run: true, stages: ["pre-commit"] }] }));
  return onlyAdds(text, doc.toString(), ".pre-commit-config.yaml", `a repo: local hook with id plumb-gate, entry ${gate}, language system, pass_filenames false, always_run true`);
}

const HOOK_MARKER = "# plumb:managed:start pre-commit";
const HUSKY_START = "# plumb:managed:start plumb-gate";
const HUSKY_END = "# plumb:managed:end plumb-gate";

/** Whether the target already runs Plumb's gate: installed from another clone, or committed by a teammate. */
function alreadyPresent(method: HookMethod, target: string): boolean {
  if (!existsSync(target)) return false;
  const text = readFileSync(target, "utf8");
  if (method === "husky") return text.includes(HUSKY_START);
  if (method === "lefthook") {
    const commands: unknown = parseDocument(text).getIn(["pre-commit", "commands"]);
    return isMap(commands) && commands.has("plumb-gate");
  }
  if (method === "pre-commit") return /\bid:\s*plumb-gate\b/.test(text);
  return text.includes(HOOK_MARKER);
}

function sha(text: Buffer | string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Chains Plumb's gate into whatever runs pre-commit today, never replacing it (doc 6), and records every change so
 * uninstall can undo it. A setup that already runs the gate (this clone or a teammate's commit) is left as it is.
 */
export function installHooks(projectRoot: string): { installed: boolean; record: InstallRecord } {
  // git reports real paths (/private/var on macOS); the gate path must be relative to the same form.
  const root = realpathSync(projectRoot);
  const existing = readRecord(root);
  if (existing !== null) return { installed: false, record: existing };
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const gate = gateCommand(top, root);
  const detection = detectHookSetup(root);
  const record: InstallRecord = { schemaVersion: 1, method: detection.method, files: [], renamed: [] };
  const target = detection.target;
  if (alreadyPresent(detection.method, target)) return { installed: false, record };
  const snapshot = (): void => {
    const present = existsSync(target);
    record.files.push({ path: target, original: present ? readFileSync(target).toString("base64") : null, mode: present ? statSync(target).mode & 0o7777 : null, installed: "" });
  };

  if (detection.method === "core.hooksPath" || detection.method === "git-hooks" || detection.method === "git-hooks-chained") {
    const chain = existsSync(target);
    if (chain) {
      const to = path.join(path.dirname(target), CHAINED);
      if (existsSync(to)) throw new CouldNotCompleteError(`${to} already exists; Plumb won't overwrite it`);
      renameSync(target, to);
      record.renamed.push({ from: target, to });
    }
    mkdirSync(path.dirname(target), { recursive: true });
    record.files.push({ path: target, original: null, mode: null, installed: "" });
    writeFileSync(target, hookScript(gate, chain));
    chmodSync(target, 0o755);
  } else if (detection.method === "husky") {
    snapshot();
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    const block = [HUSKY_START, gate, HUSKY_END].join("\n");
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(target, `${current}${separator}${block}\n`);
    if (current === "") chmodSync(target, 0o755);
  } else if (detection.method === "lefthook") {
    snapshot();
    writeFileSync(target, lefthookEdit(readFileSync(target, "utf8"), gate));
  } else {
    snapshot();
    writeFileSync(target, preCommitEdit(readFileSync(target, "utf8"), gate));
  }
  for (const file of record.files) file.installed = sha(readFileSync(file.path));

  mkdirSync(path.join(root, path.dirname(INSTALL_RECORD)), { recursive: true });
  writeFileSync(path.join(root, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return { installed: true, record };
}

/** Plumb's entry taken out of a file the user has edited since install; everything else stays. */
function removeEntry(method: HookMethod, text: string): string {
  if (method === "husky") {
    const start = text.indexOf(HUSKY_START);
    const end = text.indexOf(HUSKY_END);
    if (start === -1 || end === -1) return text;
    return text.slice(0, start) + text.slice(end + HUSKY_END.length).replace(/^\n/, "");
  }
  const doc = parseDocument(text);
  if (method === "lefthook") doc.deleteIn(["pre-commit", "commands", "plumb-gate"]);
  else {
    const repos = doc.get("repos");
    if (isSeq(repos)) {
      const index = repos.items.findIndex((r) => isMap(r) && JSON.stringify((r.toJSON() as { hooks?: unknown }).hooks ?? []).includes('"id":"plumb-gate"'));
      if (index !== -1) repos.delete(index);
    }
  }
  return doc.toString();
}

/**
 * Reverses what install recorded. A file still exactly as install left it is restored byte for byte (or removed, if
 * Plumb created it); a file the user changed since keeps those changes and loses only Plumb's entry. Renames are undone.
 */
export function uninstallHooks(root: string): { uninstalled: boolean; record: InstallRecord | null; kept: string[] } {
  const record = readRecord(realpathSync(root));
  if (record === null) return { uninstalled: false, record: null, kept: [] };
  const kept: string[] = [];
  for (const file of [...record.files].reverse()) {
    const current = existsSync(file.path) ? readFileSync(file.path) : null;
    const untouched = current !== null && sha(current) === file.installed;
    if (file.original === null) {
      if (untouched) rmSync(file.path);
      else if (current !== null) kept.push(file.path);
    } else if (untouched) {
      writeFileSync(file.path, Buffer.from(file.original, "base64"));
      if (file.mode !== null) chmodSync(file.path, file.mode);
    } else if (current !== null) {
      writeFileSync(file.path, removeEntry(record.method, current.toString("utf8")));
      kept.push(file.path);
    }
  }
  for (const r of [...record.renamed].reverse()) {
    if (existsSync(r.from)) kept.push(`${r.to} (not moved back: ${r.from} exists)`);
    else renameSync(r.to, r.from);
  }
  rmSync(path.join(realpathSync(root), INSTALL_RECORD));
  return { uninstalled: true, record, kept };
}
