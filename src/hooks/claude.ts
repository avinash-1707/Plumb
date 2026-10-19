import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { FEATURES_PATH, type FeatureIndex } from "../features.ts";
import { GATE_PATH } from "../gate/script.ts";
import { matchesAny } from "../glob.ts";
import { tokenize } from "../profile/commands.ts";
import { STAMPS_DIR } from "../verify/paths.ts";

/** One `git commit` found in a Bash command, with what decides which tree it would commit. */
export interface CommitCall {
  /** Directory git runs in: the payload's cwd, then any `cd` earlier in the command, then `-C`. */
  cwd: string;
  /** `PLUMB_SKIP=1` in the command's environment prefix. */
  skip: boolean;
  /** `-a` / `--all`: tracked changes are staged at commit time. */
  all: boolean;
  /** `-i` / `--include`: pathspecs are added to the index instead of committed alone. */
  include: boolean;
  pathspecs: string[];
}

// git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
const COMMIT_VALUE_OPTIONS = new Set(["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "--author", "--date", "--fixup", "--squash", "-t", "--template", "--cleanup", "--trailer", "--pathspec-from-file", "-S", "--gpg-sign"]);
// Short commit flags that take a value; in a cluster like `-am msg`, letters after one of these are its value.
const SHORT_VALUE_LETTERS = new Set(["m", "F", "C", "c", "t", "S"]);

/** Newlines outside quotes separate commands, like `;`. */
function newlinesToSemicolons(command: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\n") {
      out += ";";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Every `git commit` a Bash command would run (`git -C dir commit`, chained with `&&`, `;`, `|`, newlines).
 * SIMPLIFIED: commits inside `sh -c "..."`, `$(...)`, or aliases are not seen; the git hook still gates them.
 */
export function findCommits(command: string, cwd: string): CommitCall[] {
  const calls: CommitCall[] = [];
  let dir = cwd;
  for (const words of tokenize(newlinesToSemicolons(command))) {
    let i = 0;
    let skip = false;
    if (words[i] === "env") i++;
    for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? ""); i++) if (words[i] === "PLUMB_SKIP=1") skip = true;
    if (words[i] === "cd" && words[i + 1] !== undefined) {
      dir = path.resolve(dir, words[i + 1] ?? ".");
      continue;
    }
    if (words[i] !== "git") continue;
    let gitDir = dir;
    i++;
    for (; i < words.length && (words[i] ?? "").startsWith("-"); i++) {
      const option = words[i] ?? "";
      if (option === "-C") gitDir = path.resolve(gitDir, words[i + 1] ?? ".");
      if (GIT_VALUE_OPTIONS.has(option)) i++;
    }
    if (words[i] !== "commit") continue;
    const call: CommitCall = { cwd: gitDir, skip, all: false, include: false, pathspecs: [] };
    let pathsOnly = false;
    for (i++; i < words.length; i++) {
      const arg = words[i] ?? "";
      // Redirections aren't pathspecs: `2> log` (the target is the next word), `>log`, `2>&1`, `< in`.
      if (/^([0-9]*|&)(>>?|<)$/.test(arg)) {
        i++;
        continue;
      }
      if (/^([0-9]*|&)(>>?|<)/.test(arg)) continue;
      if (pathsOnly || !arg.startsWith("-") || arg === "-") {
        call.pathspecs.push(arg);
        continue;
      }
      if (arg === "--") pathsOnly = true;
      else if (arg === "--all") call.all = true;
      else if (arg === "--include") call.include = true;
      else if (COMMIT_VALUE_OPTIONS.has(arg)) i++;
      else if (/^-[A-Za-z]+$/.test(arg)) {
        for (const letter of arg.slice(1)) {
          if (letter === "a") call.all = true;
          if (letter === "i") call.include = true;
          if (SHORT_VALUE_LETTERS.has(letter)) {
            // `-m msg` takes the next word; `-mmsg` carries its value inline.
            if (arg.endsWith(letter)) i++;
            break;
          }
        }
      }
    }
    calls.push(call);
  }
  return calls;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Plumb projects in the repository: every directory holding a `.plumb/gate.sh`, tracked or not. */
function plumbProjects(top: string): string[] {
  const listed = git(top, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", GATE_PATH, `*/${GATE_PATH}`]);
  return [...new Set(listed.split("\0").filter((f) => f !== "").map((f) => path.join(top, path.dirname(path.dirname(f)))))];
}

/**
 * The index the commit would write. A plain commit uses the real index. `-a` and pathspecs stage at commit time,
 * so they get a temporary index built the same way git builds it, and the gate sees exactly that tree; the git
 * hook later runs with git's own temporary index and finds the same tree's stamp.
 */
function commitIndex(call: CommitCall, top: string): { env: NodeJS.ProcessEnv; dispose: () => void } {
  if (!call.all && call.pathspecs.length === 0) return { env: process.env, dispose: () => undefined };
  const dir = mkdtempSync(path.join(tmpdir(), "plumb-index-"));
  const index = path.join(dir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const real = path.resolve(top, git(call.cwd, ["rev-parse", "--git-path", "index"]));
  if (call.pathspecs.length > 0 && !call.include) {
    // --only (the default with pathspecs): HEAD plus just those paths.
    if (spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: call.cwd }).status === 0) git(call.cwd, ["read-tree", "HEAD"], env);
    else git(call.cwd, ["read-tree", "--empty"], env);
  } else if (existsSync(real)) copyFileSync(real, index);
  if (call.all) git(call.cwd, ["add", "-u"], env);
  if (call.pathspecs.length > 0) git(call.cwd, ["add", "--", ...call.pathspecs], env);
  return { env, dispose: () => { rmSync(dir, { recursive: true, force: true }); } };
}

export interface HookDecision {
  block: boolean;
  /** Shown to the agent when blocking (stderr). */
  reason: string;
}

function loadFeatureIndex(project: string): FeatureIndex | null {
  const file = path.join(project, FEATURES_PATH);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as FeatureIndex) : null;
}

function checkProject(project: string, call: CommitCall, env: NodeJS.ProcessEnv): HookDecision | null {
  const tree = git(project, ["write-tree"], env);
  const staged = git(project, ["diff", "--cached", "--name-only", "--relative", "-z"], env).split("\0").filter((f) => f !== "");
  if (staged.length === 0) return null;
  const where = path.relative(call.cwd, project);
  // The deep check is cheap, so it goes first: a missing deep stamp blocks at once instead of after a long gate run
  // that could outlast the hook's timeout (a timed-out hook doesn't block).
  const features = loadFeatureIndex(project);
  const deepIgnore = loadConfig(project).deepIgnore ?? [];
  const needsDeep = staged.filter((file) => !matchesAny(file, deepIgnore));
  const deep = (features?.features ?? []).filter((f) => f.tier === "deep" && needsDeep.some((file) => matchesAny(file, f.paths))).map((f) => f.id);
  if (deep.length > 0 && !existsSync(path.join(project, STAMPS_DIR, `deep-${tree}`))) {
    const staging = call.all || call.pathspecs.length > 0 ? " The commit stages files itself (-a or pathspecs), but /plumb-verify proves the index: stage the changes with git add first, then commit without -a or paths." : "";
    return {
      block: true,
      reason: `Plumb: the staged changes touch deep-tier features ${deep.join(", ")}${where === "" ? "" : ` (in ${where})`}, and no live verification has passed for this exact staged content. Run /plumb-verify ${deep.join(" ")} (the plumb-verify skill), then commit again.${staging}`,
    };
  }
  if (!existsSync(path.join(project, STAMPS_DIR, `fast-${tree}`))) {
    const gate = spawnSync("sh", [path.join(project, GATE_PATH)], { cwd: project, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (gate.error !== undefined) throw gate.error;
    if (gate.status !== 0) {
      return { block: true, reason: `${`${gate.stdout}${gate.stderr}`.trim()}\n\nFix the failure, stage the fix, and commit again. (For agents, --no-verify doesn't skip this hook; PLUMB_SKIP=1 does, and it is logged.)` };
    }
  }
  return null;
}

/** Records a PLUMB_SKIP bypass for every Plumb project in the repository, with the staged tree it skipped. */
function logBypass(projects: readonly string[], command: string): void {
  for (const project of projects) {
    const tree = git(project, ["write-tree"]);
    mkdirSync(path.join(project, ".plumb/cache"), { recursive: true });
    appendFileSync(path.join(project, ".plumb/cache/bypass.log"), `${new Date().toISOString()}\t${tree}\t${command.replaceAll(/\s+/g, " ")}\n`);
  }
}

/**
 * Doc 6's Claude Code hook. Allows anything that isn't a `git commit`; for a commit in a Plumb project, runs the
 * fast gate unless this staged tree already passed, then blocks while a deep feature is touched without a deep stamp.
 */
export function claudePreCommit(payload: unknown): HookDecision {
  if (typeof payload !== "object" || payload === null) return { block: false, reason: "" };
  const p = payload as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
  if (p.tool_name !== "Bash" || typeof p.tool_input?.command !== "string") return { block: false, reason: "" };
  const command = p.tool_input.command;
  const cwd = typeof p.cwd === "string" ? p.cwd : process.cwd();
  for (const call of findCommits(command, cwd)) {
    if (!existsSync(call.cwd)) continue;
    const inside = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: call.cwd, encoding: "utf8" });
    if (inside.status !== 0) continue;
    const top = inside.stdout.trim();
    // A repository without Plumb is none of this hook's business: nothing below runs there.
    const projects = plumbProjects(top);
    if (projects.length === 0) continue;
    if (call.skip || process.env["PLUMB_SKIP"] === "1") {
      logBypass(projects, command);
      continue;
    }
    const index = commitIndex(call, top);
    try {
      for (const project of projects) {
        const decision = checkProject(project, call, index.env);
        if (decision !== null) return decision;
      }
    } finally {
      index.dispose();
    }
  }
  return { block: false, reason: "" };
}
