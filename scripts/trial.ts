// Runs Plumb against pinned external repositories (scripts/trial-repos.json) and records where it breaks.
// The map tier needs no model and runs none of the repo's code: dependencies install with lifecycle scripts off.
// Usage: node scripts/trial.ts [--work <dir>] [name...]   (default: every repo, in a new temp dir kept afterwards)
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
  ok: boolean;
  seconds: number;
}

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
  install: (Timed & { command: string; error?: string }) | null;
  map: (Timed & MapCounts) | null;
  deterministic: boolean | null;
  mapCheckOk: boolean | null;
  probe: { file: string; impact: Timed & { components: number }; update: Timed } | null;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/cli.ts");
const codeFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// NODE_ENV=production makes package managers drop dev dependencies (round one, D74).
const { NODE_ENV: _dropped, ...inherited } = process.env;
const childEnv: NodeJS.ProcessEnv = { ...inherited, CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/** The install command for a checkout, from package.json's packageManager or else the lockfile; lifecycle scripts off. */
export function installCommand(packageManager: string | undefined, has: (file: string) => boolean): string[] {
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
      return ["corepack", spec, "install", ...(has("pnpm-lock.yaml") ? ["--frozen-lockfile"] : []), "--ignore-scripts"];
    case "yarn": {
      const berry = has(".yarnrc.yml") || Number(version?.split(".")[0] ?? "1") >= 2;
      return berry
        ? ["corepack", spec, "install", "--immutable", "--mode=skip-build"]
        : ["corepack", spec, "install", "--frozen-lockfile", "--ignore-scripts"];
    }
    case "bun":
      return ["bun", "install", "--frozen-lockfile", "--ignore-scripts"];
    default:
      return ["npm", has("package-lock.json") ? "ci" : "install", "--ignore-scripts"];
  }
}

function run(command: string, args: string[], cwd: string): { status: number | null; seconds: number; stdout: string; stderr: string } {
  const started = performance.now();
  const r = spawnSync(command, args, { cwd, env: childEnv, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  return { status: r.status, seconds, stdout: r.stdout, stderr: r.error === undefined ? r.stderr : `${r.stderr}\n${r.error.message}` };
}

function plumb(args: string[], cwd: string): ReturnType<typeof run> {
  return run(process.execPath, [cli, ...args], cwd);
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

function trial(t: Trial, work: string): Result {
  const result: Result = { name: t.name, repo: t.repo, commit: t.commit, stoppedAt: null, install: null, map: null, deterministic: null, mapCheckOk: null, probe: null };
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
  const [command = "npm", ...args] = installCommand(manifest.packageManager, (f) => existsSync(path.join(dir, f)));
  const installed = run(command, args, dir);
  result.install = { command: [command, ...args].join(" "), ok: installed.status === 0, seconds: installed.seconds };
  // A failed install is a finding, not a stop: the map records what the missing dependencies cost it.
  if (installed.status !== 0) result.install.error = tail(installed.stderr || installed.stdout);

  console.log(`== ${t.name}: building the map`);
  const built = plumb(["map", "--json"], dir);
  if (built.status !== 0) return stop("map", tail(built.stderr || built.stdout));
  result.map = { ok: true, seconds: built.seconds, ...(JSON.parse(built.stdout) as MapCounts) };
  const first = hashTree(path.join(dir, ".plumb/map"));
  rmSync(path.join(dir, ".plumb"), { recursive: true, force: true });
  const rebuilt = plumb(["map", "--json"], dir);
  if (rebuilt.status !== 0) return stop("map rebuild", tail(rebuilt.stderr || rebuilt.stdout));
  result.deterministic = hashTree(path.join(dir, ".plumb/map")) === first;
  result.mapCheckOk = plumb(["map", "--check"], dir).status === 0;

  const file = probeFile(dir);
  if (file === null) return stop("probe", "no code file in the map");
  console.log(`== ${t.name}: probe edit to ${file}`);
  appendFileSync(path.join(dir, file), "\n// plumb trial probe\n");
  run("git", ["add", "--", file], dir);
  const impact = plumb(["impact", "--staged", "--json"], dir);
  const update = plumb(["map", "--update", "--json"], dir);
  result.probe = {
    file,
    impact: {
      ok: impact.status === 0,
      seconds: impact.seconds,
      components: impact.status === 0 ? (JSON.parse(impact.stdout) as { components: unknown[] }).components.length : 0,
    },
    update: { ok: update.status === 0, seconds: update.seconds },
  };
  run("git", ["reset", "-q", "--", file], dir);
  run("git", ["checkout", "-q", "--", file], dir);
  return result;
}

function table(results: Result[]): string {
  const yes = (v: boolean | null): string => (v === null ? "–" : v ? "yes" : "**no**");
  const rows = results.map((r) => {
    const m = r.map;
    const shape = m === null ? "–" : `${String(m.components)} / ${String(m.entryPoints)} / ${String(m.edges)} / ${String(m.resources)} / ${String(m.unassignedFiles)}`;
    const failures = m === null ? "–" : m.extractorFailures.map((f) => `${f.extractor} (${f.component})`).join(", ") || "none";
    const install = r.install === null ? "–" : r.install.ok ? `ok ${String(r.install.seconds)}s` : "**failed**";
    const probe = r.probe === null ? "–" : `${String(r.probe.impact.seconds)}s (${String(r.probe.impact.components)} comp.) / ${String(r.probe.update.seconds)}s`;
    return `| ${r.repo} (\`${r.commit.slice(0, 7)}\`) | ${r.stoppedAt ?? "–"} | ${install} | ${shape} | ${failures} | ${yes(r.deterministic)} | ${yes(r.mapCheckOk)} | ${m === null ? "–" : `${String(m.seconds)}s`} | ${probe} |`;
  });
  return [
    "| Repo | Stopped at | Install | Components / entries / edges / resources / unassigned | Extractor failures | Deterministic | `map --check` | Map | Impact / update |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function main(): void {
  const { values, positionals } = parseArgs({ options: { work: { type: "string" } }, allowPositionals: true });
  const all = JSON.parse(readFileSync(path.join(root, "scripts/trial-repos.json"), "utf8")) as Trial[];
  const unknown = positionals.filter((n) => !all.some((t) => t.name === n));
  if (unknown.length > 0) {
    console.error(`unknown trial: ${unknown.join(", ")} (known: ${all.map((t) => t.name).join(", ")})`);
    process.exit(2);
  }
  const trials = positionals.length === 0 ? all : all.filter((t) => positionals.includes(t.name));
  const work = values.work === undefined ? mkdtempSync(path.join(os.tmpdir(), "plumb-trial-")) : path.resolve(values.work);
  mkdirSync(work, { recursive: true });

  const results = trials.map((t) => trial(t, work));
  writeFileSync(path.join(work, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${table(results)}\n\nresults: ${path.join(work, "results.json")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
