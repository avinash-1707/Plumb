import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { matchGlob } from "../glob.ts";

// What the profile's commands will need to find when they run. Unrecognized tools are only checked for
// existence on PATH, and forms Plumb can't evaluate (selectors, subshells) are skipped, so a valid command is never
// rejected on a guess.

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PM_BUILTINS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "exec", "dlx", "x", "create", "init",
  "link", "unlink", "prune", "rebuild", "store", "publish", "pack", "outdated", "list", "ls", "why", "audit", "config",
  "set", "get", "import", "deploy", "fetch", "patch", "env", "setup", "version", "help", "approve-builds", "self-update",
  "workspaces",
]);
const NPM_SCRIPT_ALIASES: Record<string, string> = { test: "test", t: "test", start: "start", stop: "stop", restart: "restart" };
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const COMPOSE_OVERRIDES = ["compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"];
const COMPOSE_FLAGS_WITH_VALUE = new Set([
  "-f", "--file", "-p", "--project-name", "--profile", "--env-file", "-t", "--timeout", "--scale", "--wait-timeout",
  "--project-directory", "-e", "--env", "-w", "--workdir", "-u", "--user", "--entrypoint", "-l", "--label", "--name",
  "-v", "--volume", "--pull",
]);
const COMPOSE_SERVICE_COMMANDS = new Set(["up", "start", "stop", "restart", "down", "logs", "run", "exec", "pull", "build", "rm", "kill", "create"]);
const SCRIPT_RUNNERS = new Set(["node", "tsx", "ts-node", "bash", "sh", "zsh", "python", "python3"]);
// Shell builtins have no executable to find on PATH.
const SHELL_BUILTINS = new Set(["cd", "export", "set", "unset", "source", ".", "echo", "printf", "true", "false", "test", "[", "exit", "wait", "exec", "eval", "trap", "umask", "ulimit"]);

/**
 * Splits a command line into segments (&&, ||, ;, |, &) of shell-like tokens. Quotes group, nothing expands,
 * redirections (`2>&1`, `&>file`) stay inside their token, and subshell parentheses are dropped.
 */
export function tokenize(command: string): string[][] {
  const segments: string[][] = [[]];
  let token = "";
  let quote: string | null = null;
  let inToken = false;
  const push = (): void => {
    const word = token.replace(/^\(+/, "").replace(/\)+$/, "");
    if (inToken && word !== "") segments.at(-1)?.push(word);
    token = "";
    inToken = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    const next = command.charAt(i + 1);
    const prev = command.charAt(i - 1);
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === " " || ch === "\t" || ch === "\n") push();
    else if (ch === "&" && (prev === ">" || prev === "<" || next === ">")) {
      // Part of a redirection, not a separator.
      token += ch;
      inToken = true;
    } else if (ch === ";" || ch === "|" || ch === "&") {
      push();
      if ((ch === "&" || ch === "|") && next === ch) i++;
      segments.push([]);
    } else {
      token += ch;
      inToken = true;
    }
  }
  push();
  return segments.filter((s) => s.length > 0);
}

interface PackageInfo {
  dir: string;
  name: string | undefined;
  scripts: Record<string, string>;
}

function packages(root: string, files: readonly string[], issues: string[]): PackageInfo[] {
  return files
    .filter((f) => f === "package.json" || (f.endsWith("/package.json") && !f.includes("node_modules/")))
    .flatMap((f) => {
      try {
        const pkg = JSON.parse(readFileSync(path.join(root, f), "utf8")) as { name?: string; scripts?: Record<string, string> };
        return [{ dir: path.posix.dirname(f), name: pkg.name, scripts: pkg.scripts ?? {} }];
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        issues.push(`${f} is not valid JSON, so scripts in it can't be checked`);
        return [];
      }
    });
}

function localBinDirs(cwd: string, root: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(path.join(dir, "node_modules/.bin"));
    if (dir === root || dir === path.dirname(dir)) break;
  }
  return dirs;
}

function executableIn(tool: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => {
    try {
      accessSync(path.join(d, tool), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** On PATH, or a local bin the command's folder can reach (package-manager scripts call those). */
function onPath(tool: string, cwd: string, root: string): boolean {
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((d) => d !== "");
  return executableIn(tool, [...pathDirs, ...localBinDirs(cwd, root)]);
}

/** The nearest folder at or above `dir` (within the project) holding a package.json: where npm/pnpm look for scripts. */
function nearestPackageDir(dir: string, root: string, all: readonly PackageInfo[]): string {
  const dirs = new Set(all.map((p) => p.dir));
  for (let d = path.relative(root, dir) || "."; ; d = path.posix.dirname(d)) {
    if (dirs.has(d) || d === ".") return d;
  }
}

interface PmArgs {
  filter?: string;
  dir: string;
  recursive: boolean;
  workspaceRoot: boolean;
  rest: string[];
}

/** Splits a package-manager invocation into its selection flags and the remaining words. */
function parsePmArgs(tool: string, args: readonly string[], cwd: string): PmArgs {
  const parsed: PmArgs = { dir: cwd, recursive: false, workspaceRoot: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("-")) {
      parsed.rest.push(a);
      continue;
    }
    const [flag = "", inline] = a.split("=", 2);
    const value = (): string => inline ?? args[++i] ?? "";
    if (flag === "-r" || flag === "--recursive") parsed.recursive = true;
    else if (flag === "--filter" || flag === "-F") parsed.filter = value();
    else if (flag === "--workspace" || (flag === "-w" && tool === "npm")) parsed.filter = value();
    else if (flag === "-w" || flag === "--workspace-root") parsed.workspaceRoot = true;
    else if (flag === "--dir" || flag === "-C" || flag === "--prefix" || flag === "--cwd") parsed.dir = path.resolve(cwd, value());
    else if (flag === "--reporter" || flag === "--loglevel") value();
  }
  return parsed;
}

function checkPackageManager(tool: string, args: readonly string[], cwd: string, root: string, all: PackageInfo[]): string[] {
  const parsed = parsePmArgs(tool, args, cwd);
  let [sub, ...rest] = parsed.rest;
  // `yarn workspace <name> <script>` selects a package by name.
  if (tool === "yarn" && sub === "workspace") {
    parsed.filter = rest[0] ?? "";
    [sub, ...rest] = rest.slice(1);
  }
  if (sub === undefined || PM_BUILTINS.has(sub)) return [];
  let script = sub;
  if (sub === "run" || sub === "run-script") script = rest[0] ?? "";
  else if (tool === "npm") {
    const alias = NPM_SCRIPT_ALIASES[sub];
    if (alias === undefined) return [`\`npm ${sub}\` is not an npm command; did you mean \`npm run ${sub}\`?`];
    script = alias;
  }
  if (script === "") return [`\`${tool} ${sub}\` names no script`];

  const filter = parsed.filter;
  // pnpm selector syntax (web..., ...web, {dir}, !x, ./apps/*) isn't evaluated here; trust it rather than guess.
  if (filter !== undefined && /[.]{3}|[{}!]|\*.*\/|^\.\/.*\*/.test(filter)) return [];
  const rel = parsed.workspaceRoot ? "." : nearestPackageDir(parsed.dir, root, all);
  const asPath = (f: string): string => path.posix.normalize(path.posix.join(rel, f));
  const candidates =
    filter !== undefined
      ? all.filter((p) => (p.name !== undefined && matchGlob(p.name, filter)) || (!filter.startsWith("@") && path.posix.normalize(p.dir) === asPath(filter)))
      : parsed.recursive
        ? all
        : all.filter((p) => p.dir === rel);
  if (filter !== undefined && candidates.length === 0) return [`no workspace package matches ${filter}`];
  if (candidates.length === 0) return [`no package.json in ${rel} for \`${tool} ${sub}\``];
  if (candidates.some((p) => Object.hasOwn(p.scripts, script))) return [];
  // pnpm, yarn, and bun run a local node_modules/.bin binary when no script has that name (`pnpm vitest ...`).
  if (tool !== "npm" && sub !== "run" && candidates.some((p) => executableIn(script, localBinDirs(path.join(root, p.dir), root)))) return [];
  const where = filter !== undefined ? filter : parsed.recursive ? "any workspace package" : `${rel}/package.json`;
  return [`"${script}" is neither a script in ${where} nor a local binary`];
}

function composeServices(files: readonly string[], issues: string[], root: string): Set<string> {
  return new Set(
    files.flatMap((f) => {
      let doc: unknown;
      try {
        doc = parseYaml(readFileSync(f, "utf8"));
      } catch (err) {
        issues.push(`${path.relative(root, f)} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
      const s = typeof doc === "object" && doc !== null && "services" in doc ? doc.services : undefined;
      return typeof s === "object" && s !== null ? Object.keys(s) : [];
    }),
  );
}

function checkCompose(args: readonly string[], cwd: string, root: string): string[] {
  const files: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("-")) break;
    if (a === "-f" || a === "--file") files.push(args[++i] ?? "");
    else if (COMPOSE_FLAGS_WITH_VALUE.has(a)) i++;
  }
  const resolved =
    files.length > 0
      ? files.map((f) => path.resolve(cwd, f))
      : [
          ...COMPOSE_FILES.map((f) => path.join(cwd, f)).filter((f) => existsSync(f)).slice(0, 1),
          // Compose merges an override file automatically when no -f is given.
          ...COMPOSE_OVERRIDES.map((f) => path.join(cwd, f)).filter((f) => existsSync(f)),
        ];
  if (resolved.length === 0) return [`no compose file in ${path.relative(root, cwd) || "."}`];
  const missing = resolved.filter((f) => !existsSync(f));
  if (missing.length > 0) return missing.map((f) => `compose file ${path.relative(root, f)} does not exist`);
  const sub = args[i];
  if (sub === undefined || !COMPOSE_SERVICE_COMMANDS.has(sub)) return [];
  const issues: string[] = [];
  const services = composeServices(resolved, issues, root);
  if (issues.length > 0) return issues;
  const named: string[] = [];
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j] ?? "";
    if (a.startsWith("-")) {
      if (COMPOSE_FLAGS_WITH_VALUE.has(a)) j++;
      continue;
    }
    named.push(a);
    // `run`/`exec` take one service, then the command to run inside it.
    if (sub === "run" || sub === "exec") break;
  }
  return named.filter((n) => !services.has(n)).map((n) => `compose service "${n}" is not defined`);
}

export interface CheckOptions {
  /** The profile has a build step, so scripts under untracked build output may appear once it runs. */
  hasBuild?: boolean;
}

/** Problems that would stop `cmd` from running in `cwd` (relative to the project root); empty when none are found. */
export function checkCommand(root: string, files: readonly string[], cmd: string, cwd: string, options: CheckOptions = {}): string[] {
  let dir = path.resolve(root, cwd);
  if (path.relative(root, dir).startsWith("..")) return [`cwd "${cwd}" is outside the project`];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`cwd "${cwd}" is not a directory`];
  const issues: string[] = [];
  const all = packages(root, files, issues);
  const tracked = new Set(files);
  for (const segment of tokenize(cmd.replaceAll("{files}", ""))) {
    // Leading VAR=value words set the environment; the tool is the first word after them.
    const start = segment.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (start === -1) continue;
    const [tool = "", ...args] = segment.slice(start).filter((w) => !/^\d*[<>]/.test(w) && !/^&>/.test(w));
    if (tool === "cd") {
      // Later segments run in the new directory.
      if (args[0] !== undefined) dir = path.resolve(dir, args[0]);
      continue;
    }
    if (SHELL_BUILTINS.has(tool)) continue;
    if (PACKAGE_MANAGERS.has(tool)) issues.push(...checkPackageManager(tool, args, dir, root, all));
    else if (tool === "docker" || tool === "docker-compose") {
      if (!onPath(tool, dir, root)) issues.push(`\`${tool}\` is not on PATH`);
      else if (tool === "docker-compose") issues.push(...checkCompose(args, dir, root));
      else if (args[0] === "compose") issues.push(...checkCompose(args.slice(1), dir, root));
    } else if (tool === "npx") continue;
    else if (tool.includes("/")) {
      if (!existsSync(path.resolve(dir, tool))) issues.push(`${tool} does not exist`);
    } else if (!onPath(tool, dir, root)) issues.push(`\`${tool}\` is not on PATH or in node_modules/.bin`);
    else if (SCRIPT_RUNNERS.has(tool)) {
      const script = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-e" && args[i - 1] !== "--eval" && a !== "watch");
      if (script === undefined || !/\.[cm]?[jt]sx?$|\.sh$|\.py$/.test(script)) continue;
      const abs = path.resolve(dir, script);
      const isTracked = tracked.has(path.relative(root, abs));
      // Build output (dist/server.js) is untracked and appears only after the profile's build runs.
      if (!existsSync(abs) && !(options.hasBuild === true && !isTracked)) issues.push(`${script} does not exist`);
    }
  }
  return issues;
}
