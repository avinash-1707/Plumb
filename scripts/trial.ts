// Runs Plumb against pinned external repositories (scripts/trial-repos.json) and records where it breaks.
// The map tier needs no model and runs none of the repo's code: dependencies install with lifecycle scripts, pnpmfiles,
// and yarnPath off, and a yarn berry repo that configures yarnPath or plugins is not installed at all.
// --init adds a headless /plumb-init per repo: model usage (PLUMB_TRIAL_BUDGET_USD each, default 5) and the repo's own
// install, build, and servers run, so use a machine you don't mind. Needs a logged-in Claude Code; Docker if a repo uses it.
// Usage: node scripts/trial.ts [--init] [--work <dir>] [name...]   (default: every repo, in a new temp dir kept afterwards)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface Trial {
  name: string;
  repo: string;
  commit: string;
  why: string;
  expect: string;
}

interface Timed {
  exit: number | null;
  seconds: number;
}

type Ran = { status: number | null; seconds: number; stdout: string; stderr: string };

interface MapCounts {
  components: number;
  entryPoints: number;
  edges: number;
  resources: number;
  unassignedFiles: number;
  extractorFailures: { extractor: string; component: string; reason: string }[];
}

interface Result {
  name: string;
  repo: string;
  commit: string;
  stoppedAt: string | null;
  install: { ok: boolean; seconds: number; command: string; error?: string } | null;
  map: (Timed & MapCounts) | null;
  deterministic: boolean | null;
  /** `map --check`: 0 fresh, 1 stale, 2 couldn't check because extractors failed. */
  mapCheck: number | null;
  probe: { file: string; impact: Timed & { components: number | null }; update: Timed } | null;
  init: {
    seconds: number;
    costUsd: number | null;
    turns: number | null;
    outcome: string;
    initialized: boolean;
    skill: boolean;
    gate: Timed | null;
    hooks: boolean;
    conflicts: string[];
    containersLeft: string[] | null;
    /** Verify runs whose run.json was never marked cleaned up; the harness tears them down so the next repo starts clean. */
    runsLeft: string[];
  } | null;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/cli.ts");
const codeFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const budget = process.env.PLUMB_TRIAL_BUDGET_USD ?? "5";
const initTools = ["Bash(plumb *)", "Bash(.plumb/bin/doctor *)", "Bash(curl *)", "Bash(node *)", "Read", "Glob", "Grep", "Write", "Edit", "Agent"];

// NODE_ENV=production makes package managers drop dev dependencies (round one, D74).
const { NODE_ENV: _dropped, ...inherited } = process.env;
const childEnv: NodeJS.ProcessEnv = { ...inherited, CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/**
 * The install command for a checkout, from package.json's packageManager or else the lockfile, with every switch that
 * keeps repo code from running; refused when no switch exists (yarn berry's yarnPath and plugins).
 */
export function installCommand(packageManager: string | undefined, read: (file: string) => string | null): { command: string[] } | { refused: string } {
  const has = (file: string): boolean => read(file) !== null;
  const [declared, version] = (packageManager ?? "").split("+")[0]?.split("@") ?? [];
  const name =
    declared !== undefined && declared !== ""
      ? declared
      : has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : has("bun.lock") || has("bun.lockb")
            ? "bun"
            : "npm";
  const spec = version === undefined ? name : `${name}@${version}`;
  switch (name) {
    case "pnpm":
      return { command: ["corepack", spec, "install", ...(has("pnpm-lock.yaml") ? ["--frozen-lockfile"] : []), "--ignore-scripts", "--ignore-pnpmfile"] };
    case "yarn": {
      const yarnrc = read(".yarnrc.yml");
      if (yarnrc !== null && /^(?:yarnPath|plugins):/m.test(yarnrc)) return { refused: "yarn berry with yarnPath or plugins would run repo code" };
      const berry = yarnrc !== null || Number(version?.split(".")[0] ?? "1") >= 2;
      return {
        command: berry
          ? ["corepack", spec, "install", "--immutable", "--mode=skip-build"]
          : ["corepack", spec, "install", "--frozen-lockfile", "--ignore-scripts"],
      };
    }
    case "bun":
      return { command: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] };
    default:
      return { command: ["npm", has("package-lock.json") ? "ci" : "install", "--ignore-scripts"] };
  }
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = childEnv): Ran {
  const started = performance.now();
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  return { status: r.status, seconds, stdout: r.stdout, stderr: r.error === undefined ? r.stderr : `${r.stderr}\n${r.error.message}` };
}

function plumb(args: string[], cwd: string): Ran {
  return run(process.execPath, [cli, ...args], cwd);
}

/** Plumb's --json output, also on exit 2: extractors failed, but everything else was computed and printed. */
function plumbJson(r: Ran): unknown {
  return (r.status === 0 || r.status === 2) && r.stdout.trimStart().startsWith("{") ? JSON.parse(r.stdout) : null;
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n");
}

function hashTree(dir: string): string {
  const hash = createHash("sha256");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
  for (const file of files) hash.update(file).update(readFileSync(path.join(dir, file)));
  return hash.digest("hex");
}

/** Running container ids, or null without Docker. */
function containers(): string[] | null {
  const r = spawnSync("docker", ["ps", "-q"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter((id) => id !== "").sort() : null;
}

/** Cost, turns, and final message from a stream-json transcript's result event. */
function transcriptResult(transcript: string): { costUsd: number | null; turns: number | null; outcome: string } {
  for (const line of transcript.trim().split("\n").reverse()) {
    // A run killed by the timeout can leave a truncated last line; skip it rather than lose the other repos' results.
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    const event = JSON.parse(line) as { type?: string; total_cost_usd?: number; num_turns?: number; result?: string; subtype?: string };
    if (event.type !== "result") continue;
    return { costUsd: event.total_cost_usd ?? null, turns: event.num_turns ?? null, outcome: (event.result ?? event.subtype ?? "").trim().split("\n")[0]?.slice(0, 200) ?? "" };
  }
  return { costUsd: null, turns: null, outcome: "no result event in the transcript" };
}

/** Tears down verify runs left without cleanup (a budget cap or timeout can end init between launch and cleanup). */
function cleanUpRuns(dir: string): string[] {
  const evidence = path.join(dir, ".plumb/evidence");
  if (!existsSync(evidence)) return [];
  const left = readdirSync(evidence)
    .filter((id) => existsSync(path.join(evidence, id, "run.json")))
    .filter((id) => (JSON.parse(readFileSync(path.join(evidence, id, "run.json"), "utf8")) as { cleanedUpAt: string | null }).cleanedUpAt === null)
    .sort();
  for (const id of left) plumb(["verify", "--cleanup", id], dir);
  return left;
}

function initTrial(dir: string, work: string, name: string, probe: string): NonNullable<Result["init"]> {
  const before = containers();
  console.log(`== ${name}: /plumb-init (budget $${budget})`);
  const ran = run(
    "claude",
    ["-p", "/plumb:plumb-init", "--plugin-dir", path.join(root, "plugin"), "--permission-mode", "dontAsk", "--allowedTools", ...initTools,
      "--max-budget-usd", budget, "--no-session-persistence", "--output-format", "stream-json", "--verbose"],
    dir,
  );
  writeFileSync(path.join(work, `${name}.init.jsonl`), ran.stdout);
  writeFileSync(path.join(work, `${name}.init.err`), ran.stderr);
  const summary = transcriptResult(ran.stdout);
  const runsLeft = cleanUpRuns(dir);
  const statusRun = plumb(["status", "--json"], dir);
  const status = statusRun.status === 0
    ? (JSON.parse(statusRun.stdout) as { initialized: boolean; skill: unknown; gate: { present: boolean }; hooks: unknown; conflicts: string[] })
    : { initialized: false, skill: null, gate: { present: false }, hooks: null, conflicts: [] };

  let gate: Timed | null = null;
  if (status.gate.present) {
    console.log(`== ${name}: fast gate on the probe edit`);
    appendFileSync(path.join(dir, probe), "\n// plumb trial probe\n");
    run("git", ["add", "--", probe], dir);
    const g = plumb(["gate"], dir);
    gate = { exit: g.status, seconds: g.seconds };
    run("git", ["reset", "-q", "--", probe], dir);
    run("git", ["checkout", "-q", "--", probe], dir);
    runsLeft.push(...cleanUpRuns(dir));
  }
  const after = containers();
  return {
    seconds: ran.seconds,
    ...summary,
    outcome: ran.status === 0 ? summary.outcome : `exit ${String(ran.status)}: ${summary.outcome || tail(ran.stderr)}`,
    initialized: status.initialized,
    skill: status.skill !== null,
    gate,
    hooks: status.hooks !== null,
    conflicts: status.conflicts,
    containersLeft: before === null || after === null ? null : after.filter((id) => !before.includes(id)),
    runsLeft,
  };
}

/** A code file to edit for the impact probe: the first entry point's file, else the first code file in the map. */
function probeFile(dir: string): string | null {
  const componentsDir = path.join(dir, ".plumb/map/components");
  const components = readdirSync(componentsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(componentsDir, f), "utf8")) as { entryPoints: { location?: { file: string } }[]; files: Record<string, string> });
  const entries = components.flatMap((c) => c.entryPoints.map((e) => e.location?.file ?? "")).filter((f) => codeFile.test(f));
  const files = components.flatMap((c) => Object.keys(c.files)).filter((f) => codeFile.test(f));
  return [...entries.sort(), ...files.sort()][0] ?? null;
}

function blank(t: Trial): Result {
  return { name: t.name, repo: t.repo, commit: t.commit, stoppedAt: null, install: null, map: null, deterministic: null, mapCheck: null, probe: null, init: null };
}

function trial(t: Trial, work: string, withInit: boolean): Result {
  const result = blank(t);
  const dir = path.join(work, t.name);
  const stop = (step: string, why: string): Result => {
    result.stoppedAt = `${step}: ${why}`;
    console.log(`  ✗ ${result.stoppedAt}`);
    return result;
  };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  console.log(`== ${t.name}: fetching ${t.repo}@${t.commit.slice(0, 7)}`);
  for (const args of [["init", "-q"], ["fetch", "-q", "--depth", "1", `https://github.com/${t.repo}`, t.commit], ["checkout", "-q", "FETCH_HEAD"]]) {
    const r = run("git", args, dir);
    if (r.status !== 0) return stop("fetch", tail(r.stderr));
  }

  console.log(`== ${t.name}: installing dependencies`);
  const pkg = path.join(dir, "package.json");
  const manifest = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")) as { packageManager?: string }) : {};
  const install = installCommand(manifest.packageManager, (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : null));
  // A failed or refused install is a finding, not a stop: the map records what the missing dependencies cost it.
  if ("refused" in install) {
    result.install = { command: "", ok: false, seconds: 0, error: `not installed: ${install.refused}` };
  } else {
    const [command = "npm", ...args] = install.command;
    // YARN_IGNORE_PATH: yarn 1 would otherwise hand off to a .yarnrc yarn-path script committed in the repo.
    const installed = run(command, args, dir, { ...childEnv, YARN_IGNORE_PATH: "1" });
    result.install = { command: install.command.join(" "), ok: installed.status === 0, seconds: installed.seconds };
    if (installed.status !== 0) result.install.error = tail(installed.stderr || installed.stdout);
  }

  console.log(`== ${t.name}: building the map`);
  const built = plumb(["map", "--json"], dir);
  const counts = plumbJson(built) as MapCounts | null;
  if (counts === null) return stop("map", tail(built.stderr || built.stdout));
  result.map = { exit: built.status, seconds: built.seconds, ...counts };
  const first = hashTree(path.join(dir, ".plumb/map"));
  rmSync(path.join(dir, ".plumb"), { recursive: true, force: true });
  const rebuilt = plumb(["map", "--json"], dir);
  if (plumbJson(rebuilt) === null) return stop("map rebuild", tail(rebuilt.stderr || rebuilt.stdout));
  result.deterministic = hashTree(path.join(dir, ".plumb/map")) === first;
  result.mapCheck = plumb(["map", "--check"], dir).status;

  const file = probeFile(dir);
  if (file === null) return stop("probe", "no code file in the map");
  console.log(`== ${t.name}: probe edit to ${file}`);
  appendFileSync(path.join(dir, file), "\n// plumb trial probe\n");
  run("git", ["add", "--", file], dir);
  const impact = plumb(["impact", "--staged", "--json"], dir);
  const update = plumb(["map", "--update", "--json"], dir);
  const impacted = plumbJson(impact) as { components: unknown[] } | null;
  result.probe = {
    file,
    impact: { exit: impact.status, seconds: impact.seconds, components: impacted?.components.length ?? null },
    update: { exit: update.status, seconds: update.seconds },
  };
  run("git", ["reset", "-q", "--", file], dir);
  run("git", ["checkout", "-q", "--", file], dir);

  if (withInit) {
    result.init = initTrial(dir, work, t.name, file);
    if (!result.init.initialized) result.stoppedAt = `init: ${result.init.outcome}`;
  }
  return result;
}

function table(results: Result[]): string {
  const yes = (v: boolean | null): string => (v === null ? "–" : v ? "yes" : "**no**");
  const check = (exit: number | null): string => (exit === null ? "–" : exit === 0 ? "fresh" : exit === 1 ? "**stale**" : exit === 2 ? "n/a (extractors)" : `**exit ${String(exit)}**`);
  const secs = (t: Timed): string => `${String(t.seconds)}s${t.exit === 0 || t.exit === 2 ? "" : ` **exit ${String(t.exit)}**`}`;
  const rows = results.map((r) => {
    const m = r.map;
    const shape = m === null ? "–" : `${String(m.components)} / ${String(m.entryPoints)} / ${String(m.edges)} / ${String(m.resources)} / ${String(m.unassignedFiles)}`;
    const failures = m === null ? "–" : m.extractorFailures.map((f) => `${f.extractor} (${f.component})`).join(", ") || "none";
    const install = r.install === null ? "–" : r.install.ok ? `ok ${String(r.install.seconds)}s` : "**failed**";
    const probe = r.probe === null ? "–" : `${secs(r.probe.impact)} (${String(r.probe.impact.components ?? "?")} comp.) / ${secs(r.probe.update)}`;
    const i = r.init;
    const init = i === null ? "–" : `${i.costUsd === null ? "?" : `$${i.costUsd.toFixed(2)}`}, ${String(i.turns ?? "?")} turns, ${String(Math.round(i.seconds / 60))} min`;
    const gate = i?.gate == null ? "–" : `${i.gate.exit === 0 ? "pass" : "**fail**"} ${String(i.gate.seconds)}s`;
    const leaks = i === null ? [] : [...(i.containersLeft ?? []).map(() => "container"), ...i.runsLeft.map(() => "verify run")];
    const left = i === null ? "–" : leaks.length === 0 ? (i.containersLeft === null ? "none (no Docker check)" : "none") : `**${leaks.join(", ")}**`;
    return `| ${r.repo} (\`${r.commit.slice(0, 7)}\`) | ${r.stoppedAt ?? "–"} | ${install} | ${shape} | ${failures} | ${yes(r.deterministic)} | ${check(r.mapCheck)} | ${m === null ? "–" : `${String(m.seconds)}s`} | ${probe} | ${init} | ${gate} | ${left} |`;
  });
  return [
    "| Repo | Stopped at | Install | Components / entries / edges / resources / unassigned | Extractor failures | Deterministic | `map --check` | Map | Impact / update | Init | Gate | Left running |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function main(): void {
  const { values, positionals } = parseArgs({ options: { work: { type: "string" }, init: { type: "boolean" } }, allowPositionals: true });
  const all = JSON.parse(readFileSync(path.join(root, "scripts/trial-repos.json"), "utf8")) as Trial[];
  const unknown = positionals.filter((n) => !all.some((t) => t.name === n));
  if (unknown.length > 0) {
    console.error(`unknown trial: ${unknown.join(", ")} (known: ${all.map((t) => t.name).join(", ")})`);
    process.exit(2);
  }
  const trials = positionals.length === 0 ? all : all.filter((t) => positionals.includes(t.name));
  if (values.init === true && spawnSync("claude", ["--version"]).status !== 0) {
    console.error("--init needs Claude Code (`claude`) on PATH");
    process.exit(2);
  }
  const work = values.work === undefined ? mkdtempSync(path.join(os.tmpdir(), "plumb-trial-")) : path.resolve(values.work);
  mkdirSync(work, { recursive: true });

  // Rerunning a subset in the same work dir replaces only those rows; saved after every repo so a crash loses one.
  const saved = path.join(work, "results.json");
  const byName = new Map((existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")) as Result[]) : []).map((r) => [r.name, r]));
  for (const t of trials) {
    let result: Result;
    try {
      result = trial(t, work, values.init === true);
    } catch (error) {
      result = { ...blank(t), stoppedAt: `crash: ${error instanceof Error ? error.message : String(error)}` };
      console.log(`  ✗ ${String(result.stoppedAt)}`);
    }
    byName.set(t.name, result);
    writeFileSync(saved, `${JSON.stringify(all.flatMap((a) => byName.get(a.name) ?? []), null, 2)}\n`);
  }
  console.log(`\n${table(all.flatMap((a) => byName.get(a.name) ?? []))}\n\nresults: ${saved}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
