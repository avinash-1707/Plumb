import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkConfig, CONFIG_PATH, type Config, loadConfig } from "../config.ts";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { GATE_PATH } from "../gate/script.ts";
import { isGitRepo } from "../git.ts";
import { installHooks } from "../hooks/install.ts";
import { checkPlumb } from "../init/doctor.ts";
import { refreshSetup } from "../init/refresh.ts";
import { collectStatus, formatStatus } from "../init/status.ts";
import type { Io } from "../io.ts";
import { ensureGitignore } from "../managed/block.ts";
import { buildMap, renderMap } from "../map/build.ts";
import { writeMap } from "../map/store.ts";
import { PROFILE_PATH } from "../profile/load.ts";

export const INIT_USAGE = `Usage:
  plumb init [--no-hooks] [--strategy <s>]   Deterministic setup: preflight, map, .gitignore block, and the git
                                             hook once gate.sh exists; prints the agent steps still needed
  plumb init --refresh [--no-hooks]          On an initialized repo: rebuild the map and regenerate every managed
                                             region; a region edited by hand gets <file>.plumb-new instead

Discovery, the profile, the verify skill, and the self-proof are judgment work: run /plumb-init in Claude Code.

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

const STRATEGIES = new Set(["library-cli", "api-backend", "web-app", "monorepo"]);

/** `--strategy` is a user choice, so it goes into config.json, the user's file (created if missing). */
function forceStrategy(root: string, strategy: string): void {
  if (!STRATEGIES.has(strategy)) throw new UsageError(`--strategy must be one of ${[...STRATEGIES].join(", ")}`);
  const file = path.join(root, CONFIG_PATH);
  const config: Config = existsSync(file) ? loadConfig(root) : { schemaVersion: 1 };
  const next = checkConfig({ ...config, strategy: strategy as NonNullable<Config["strategy"]> }, CONFIG_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  // Rewrites the whole file: config.json holds data only, so there is nothing outside the fields to preserve.
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const after = `${JSON.stringify(next, null, 2)}\n`;
  if (before !== after) writeFileSync(file, after);
}

export async function initCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      refresh: { type: "boolean" },
      "no-hooks": { type: "boolean" },
      strategy: { type: "string" },
      json: { type: "boolean" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(INIT_USAGE);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
  const root = path.resolve(values.cwd ?? ".");
  if (!isGitRepo(root)) throw new CouldNotCompleteError(`${root} is not inside a git repository; Plumb's gate and stamps need git`);
  if (values.strategy !== undefined) forceStrategy(root, values.strategy);
  const initialized = existsSync(path.join(root, PROFILE_PATH));
  const hooks = (): string => {
    if (values["no-hooks"] === true || !existsSync(path.join(root, GATE_PATH))) return "";
    const { installed, record } = installHooks(root);
    return installed ? `installed the git hook via ${record.method}` : `git hook already installed via ${record.method}`;
  };

  if (values.refresh === true) {
    if (!initialized) throw new CouldNotCompleteError(`${PROFILE_PATH} doesn't exist; nothing to refresh. Run /plumb-init in Claude Code first`);
    const report = await refreshSetup(root);
    const hookLine = hooks();
    const conflicts = report.files.filter((f) => f.outcome === "conflict").map((f) => f.file);
    if (report.gate?.outcome === "conflict") conflicts.unshift(GATE_PATH);
    if (values.json === true) io.stdout(`${JSON.stringify({ ...report, hooks: hookLine, conflicts }, null, 2)}\n`);
    else {
      const lines = [`map: ${String(report.map.changed.length)} files changed, ${String(report.map.removed.length)} removed`];
      if (report.gate !== null) lines.push(`${GATE_PATH}: ${report.gate.outcome} (smoke boot ${report.gate.smoke ? "on" : "off"}: ${report.gate.reason})`);
      for (const f of report.files) lines.push(`${f.file}: ${f.outcome}`);
      if (hookLine !== "") lines.push(hookLine);
      for (const c of conflicts) lines.push(`✗ ${c} has a managed region edited by hand; Plumb left it alone and wrote ${c}.plumb-new. Merge the two and delete the .plumb-new file.`);
      lines.push("To re-run discovery as well, run /plumb-init in Claude Code.");
      io.stdout(`${lines.join("\n")}\n`);
    }
    for (const f of report.map.failures) io.stderr(`  ✗ ${f}\n`);
    if (report.map.failures.length > 0) return ExitCode.CouldNotComplete;
    return conflicts.length > 0 ? ExitCode.CheckFailed : ExitCode.Ok;
  }

  if (initialized) {
    const status = await collectStatus(root);
    io.stdout(values.json === true ? `${JSON.stringify(status, null, 2)}\n` : `${formatStatus(status)}Already initialized; plumb init --refresh regenerates managed sections.\n`);
    return ExitCode.Ok;
  }

  ensureGitignore(root);
  const { map } = await buildMap({ root, cache: "write-only" });
  const written = writeMap(root, renderMap(map));
  const hookLine = hooks();
  const failures = map.manifest.extractorFailures;
  if (values.json === true) io.stdout(`${JSON.stringify({ map: written, extractorFailures: failures, hooks: hookLine, next: "/plumb-init" }, null, 2)}\n`);
  else {
    io.stdout(
      [
        `mapped ${String(map.components.length)} components (${String(written.changed.length)} map files written)`,
        ...(hookLine === "" ? [] : [hookLine]),
        "Next, in Claude Code: /plumb-init. It explores how the app builds, runs, and tests, writes .plumb/profile.json,",
        "proves the app boots, generates the verify skill and .plumb/gate.sh, proves the skill on one feature, and",
        "installs the git hook.",
        "",
      ].join("\n"),
    );
  }
  for (const f of failures) io.stderr(`  ✗ ${f.extractor}${f.component === null ? "" : ` (${f.component})`}: ${f.reason}\n`);
  return failures.length > 0 ? ExitCode.CouldNotComplete : ExitCode.Ok;
}

export async function statusCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({ args: [...argv], options: { json: { type: "boolean" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  if (values.help === true) {
    io.stdout("Usage: plumb status [--json] [--cwd <dir>]\n\nInitialization, map freshness, profile, gate, last deep verification, bypasses, hooks, and managed-region conflicts.\n");
    return ExitCode.Ok;
  }
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
  const root = path.resolve(values.cwd ?? ".");
  if (!isGitRepo(root)) throw new CouldNotCompleteError(`${root} is not inside a git repository`);
  const status = await collectStatus(root);
  io.stdout(values.json === true ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
  return ExitCode.Ok;
}

export function doctorCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({ args: [...argv], options: { json: { type: "boolean" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  if (values.help === true) {
    io.stdout("Usage: plumb doctor [--json] [--cwd <dir>]\n\nChecks Plumb's own setup: Node, extractor dependencies, the git hook, gate.sh, and every .plumb file's schema. Exit 1 on a problem.\n");
    return Promise.resolve(ExitCode.Ok);
  }
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
  const checks = checkPlumb(path.resolve(values.cwd ?? "."));
  const ok = checks.every((c) => c.ok);
  io.stdout(values.json === true ? `${JSON.stringify({ ok, checks }, null, 2)}\n` : `${checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n")}\n`);
  return Promise.resolve(ok ? ExitCode.Ok : ExitCode.CheckFailed);
}
