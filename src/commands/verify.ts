import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { FEATURES_PATH, loadFeatures } from "../features.ts";
import { listFiles, writeTree } from "../git.ts";
import { matchesAny } from "../glob.ts";
import { branchChanges, stagedChanges } from "../impact/changes.ts";
import { computeImpact } from "../impact/impact.ts";
import type { Io } from "../io.ts";
import { buildMap, isIgnored } from "../map/build.ts";
import type { RepoMap } from "../map/types.ts";
import { loadValidProfile } from "../profile/load.ts";
import { loadLocal } from "../profile/local.ts";
import { formatVerify } from "../profile/verify.ts";
import { cleanup, doctor, launch, parseEnvOverrides } from "../verify/launch.ts";
import { runDir, skillDir } from "../verify/paths.ts";
import { checkStamp, writeDeepStamp } from "../verify/report.ts";
import { scaffold } from "../verify/scaffold.ts";
import { featureFreshness, syncFeatures } from "../verify/sync.ts";
import { checkSkill, editSkill, publishDraft, type SkillIssue, skillUnderValidation } from "../verify/validate.ts";

export const VERIFY_USAGE = `Usage:
  plumb verify --plan [--staged | <base>]   Features the changes touch and the recipe file for each
  plumb verify --validate                   Check the verify skill and feature map structure
  plumb verify --scaffold                   Write the verify skill skeleton (as a draft), features.json, and doctor helper
  plumb verify --edit                       Copy the published skill into the draft directory for changes
  plumb verify --publish                    Validate the draft and move it into .claude/skills/
  plumb verify --launch [--env K=V ...]     Start services and run targets for one run; prints the run id
  plumb verify --doctor <run-id>            Read-only health check of a launched run
  plumb verify --cleanup <run-id>           Tear down what the run started, then check its evidence survived
  plumb verify --stamp <run-id>             Check the run's report and write the deep stamp for the staged tree
  plumb verify --sync <run-id>              Record HEAD as the commit each feature the run verified was last confirmed at
  plumb verify --stale                      Features whose code changed since they were last confirmed live

--env values may use {port:<target>} and {runId}.

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

async function freshMap(root: string): Promise<{ map: RepoMap; files: string[] }> {
  const config = loadConfig(root);
  const { map } = await buildMap({ root, config, cache: "read-write" });
  return { map, files: listFiles(root).filter((f) => !isIgnored(f, config)) };
}

/**
 * Features the given changes touch, from a fresh map of the working tree. `staged` is a commit's own change set, so
 * it honors `deepIgnore` like the commit hook does; a branch's changes (PR verification) do not.
 */
async function touchedFeatures(root: string, changed: string[], staged: boolean): Promise<Array<{ id: string; tier: "fast-only" | "deep" }>> {
  const config = loadConfig(root);
  const deepIgnore = staged ? (config.deepIgnore ?? []) : [];
  const features = loadFeatures(root);
  if (features === null) throw new CouldNotCompleteError(`${FEATURES_PATH} doesn't exist yet; /plumb-init generates it`);
  const { map } = await buildMap({ root, config, cache: "read-write" });
  return computeImpact(map, changed.filter((f) => !isIgnored(f, config) && !matchesAny(f, deepIgnore)), features).features ?? [];
}

function formatIssues(issues: readonly SkillIssue[]): string {
  return issues.map((i) => `  ${i.file}${i.line === null ? "" : `:${String(i.line)}`}  ${i.message}`).join("\n");
}

export async function verifyCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      plan: { type: "boolean" },
      staged: { type: "boolean" },
      validate: { type: "boolean" },
      scaffold: { type: "boolean" },
      publish: { type: "boolean" },
      edit: { type: "boolean" },
      launch: { type: "boolean" },
      env: { type: "string", multiple: true },
      doctor: { type: "string" },
      cleanup: { type: "string" },
      stamp: { type: "string" },
      sync: { type: "string" },
      stale: { type: "boolean" },
      json: { type: "boolean" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(VERIFY_USAGE);
    return ExitCode.Ok;
  }
  const modes = (["plan", "validate", "scaffold", "edit", "publish", "launch", "doctor", "cleanup", "stamp", "sync", "stale"] as const).filter((m) => values[m] !== undefined && values[m] !== false);
  if (modes.length !== 1) throw new UsageError(modes.length === 0 ? "verify needs one of --plan, --validate, --scaffold, --edit, --publish, --launch, --doctor, --cleanup, --stamp, --sync, --stale" : `choose one of --${modes.join(", --")}`);
  const mode = modes[0];
  if (values.staged === true && mode !== "plan") throw new UsageError("--staged only applies to --plan");
  if (values.env !== undefined && mode !== "launch") throw new UsageError("--env only applies to --launch");
  if (positionals.length > (mode === "plan" ? 1 : 0)) throw new UsageError(`unexpected argument "${positionals.at(-1) ?? ""}"`);
  // A run id names a directory under .plumb/evidence; reject one that could point elsewhere before touching anything.
  for (const id of [values.doctor, values.cleanup, values.stamp, values.sync]) if (id !== undefined) runDir(id);
  const root = path.resolve(values.cwd ?? ".");
  const json = values.json === true;
  const out = (data: unknown, text: string): void => {
    io.stdout(json ? `${JSON.stringify(data, null, 2)}\n` : text);
  };

  if (mode === "plan") {
    const [base] = positionals;
    if (base !== undefined && values.staged === true) throw new UsageError("give either a base ref or --staged");
    const profile = loadValidProfile(root);
    const changed = base === undefined ? stagedChanges(root) : branchChanges(root, base).files;
    const dir = skillDir(profile.app.slug);
    const features = loadFeatures(root);
    const touched = (await touchedFeatures(root, changed, base === undefined)).map((f) => ({ ...f, recipe: `${dir}/${features?.features.find((x) => x.id === f.id)?.file ?? ""}` }));
    const deep = touched.filter((f) => f.tier === "deep");
    const lines = [`skill: ${dir}/SKILL.md`, `changes: ${base === undefined ? "staged" : `${base}...HEAD`} (${String(changed.length)} files)`];
    if (touched.length === 0) lines.push("no mapped feature is touched; nothing to drive");
    for (const f of touched) lines.push(`  ${f.tier === "deep" ? "drive" : "skip "} ${f.id} (${f.tier})  ${f.recipe}`);
    out({ skill: `${dir}/SKILL.md`, changedFiles: changed.length, features: touched, drive: deep.map((f) => f.id) }, `${lines.join("\n")}\n`);
    return ExitCode.Ok;
  }

  if (mode === "validate") {
    const profile = loadValidProfile(root);
    const { map, files } = await freshMap(root);
    const dir = skillUnderValidation(root, profile.app.slug);
    const issues = checkSkill(root, profile, map, files, dir);
    out({ ok: issues.length === 0, skill: dir, issues }, issues.length === 0 ? `verify skill is valid (${dir})\n` : `verify skill is invalid (${dir}):\n${formatIssues(issues)}\n`);
    return issues.length === 0 ? ExitCode.Ok : ExitCode.CheckFailed;
  }

  if (mode === "edit") {
    const draft = editSkill(root, loadValidProfile(root).app.slug);
    out({ draft }, `copied the published skill to ${draft}; edit it there, then plumb verify --validate and plumb verify --publish\n`);
    return ExitCode.Ok;
  }

  if (mode === "publish") {
    const profile = loadValidProfile(root);
    const { map, files } = await freshMap(root);
    const result = publishDraft(root, profile, map, files);
    out(result, result.published === null ? `not published; fix these in the draft:\n${formatIssues(result.issues)}\n` : `published ${result.published}\n`);
    return result.published === null ? ExitCode.CheckFailed : ExitCode.Ok;
  }

  if (mode === "scaffold") {
    const profile = loadValidProfile(root);
    const { map } = await freshMap(root);
    const result = scaffold(root, profile, map);
    const lines = [`verify skill${result.draft ? " draft" : ""}: ${result.skillDir}`];
    for (const f of result.written) lines.push(`  wrote ${f}`);
    for (const f of result.kept) lines.push(`  kept  ${f} (exists)`);
    for (const d of result.dropped) lines.push(`  left out ${d}`);
    if (result.written.length > 0) lines.push(result.draft ? `Replace every {{fill: ...}} token in ${result.skillDir} and .plumb/bin/doctor, run plumb verify --validate, then plumb verify --publish.` : "Replace every {{fill: ...}} token, then run plumb verify --validate.");
    out(result, `${lines.join("\n")}\n`);
    return ExitCode.Ok;
  }

  if (mode === "launch") {
    const profile = loadValidProfile(root);
    const result = await launch(root, profile, loadLocal(root), parseEnvOverrides(values.env ?? []));
    const text = result.ok
      ? [`launched run ${result.runId}`, `tree ${result.tree}`, ...result.targets.map((t) => `  ${t.name}: ${t.url ?? (t.port === null ? "no port" : `port ${String(t.port)}`)}`), `evidence: ${result.evidenceDir}/`, `when done: plumb verify --cleanup ${result.runId}`, ""].join("\n")
      : formatVerify({ ok: false, evidenceDir: result.evidenceDir, steps: result.steps, teardown: result.teardown });
    out(result, text);
    return result.ok ? ExitCode.Ok : ExitCode.CheckFailed;
  }

  if (mode === "doctor") {
    const result = await doctor(root, loadValidProfile(root), values.doctor ?? "");
    out(result, `${result.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n")}\n${result.ok ? "healthy: worth driving" : "not healthy: don't drive this instance"}\n`);
    return result.ok ? ExitCode.Ok : ExitCode.CheckFailed;
  }

  if (mode === "cleanup") {
    const result = await cleanup(root, loadValidProfile(root), loadLocal(root), values.cleanup ?? "");
    const lines = [...result.teardown.map((l) => `  ${l}`)];
    for (const s of result.survivors) lines.push(`✗ still running: ${s}`);
    if (!result.evidence.report) lines.push("evidence: no report.json in the run directory yet; nothing to check");
    else if (result.evidence.missing.length === 0) lines.push(`✓ evidence intact (${String(result.evidence.checked)} artifacts)`);
    else lines.push(...result.evidence.missing.map((m) => `✗ evidence missing after cleanup: ${m}`));
    out(result, `${lines.join("\n")}\n`);
    return result.ok ? ExitCode.Ok : ExitCode.CheckFailed;
  }

  if (mode === "sync" || mode === "stale") {
    const features = loadFeatures(root);
    if (features === null) throw new CouldNotCompleteError(`${FEATURES_PATH} doesn't exist yet; /plumb-init generates it`);
    if (mode === "sync") {
      const result = syncFeatures(root, values.sync ?? "", features);
      const lines = [`synced at ${result.commit.slice(0, 12)}: ${result.synced.join(", ") || "nothing"}`, ...result.skipped.map((s) => `  not synced ${s.id}: ${s.reason}`)];
      out(result, `${lines.join("\n")}\n`);
      return ExitCode.Ok;
    }
    const freshness = featureFreshness(root, features);
    const lines = freshness.map((f) => `  ${f.state.padEnd(9)} ${f.id}${f.state === "stale" ? `  (${f.changed.join(", ")})` : ""}`);
    out({ features: freshness }, `${lines.join("\n") || "  no features"}\n`);
    return ExitCode.Ok;
  }

  const runId = values.stamp ?? "";
  const features = loadFeatures(root);
  if (features === null) throw new CouldNotCompleteError(`${FEATURES_PATH} doesn't exist yet; /plumb-init generates it`);
  const touchedDeep = (await touchedFeatures(root, stagedChanges(root), true)).filter((f) => f.tier === "deep").map((f) => f.id);
  const check = checkStamp(root, runId, writeTree(root), features, touchedDeep);
  if (!check.ok) {
    out({ ok: false, issues: check.issues }, `not stamped:\n${check.issues.map((i) => `  ✗ ${i}`).join("\n")}\n`);
    return ExitCode.CheckFailed;
  }
  const stamp = writeDeepStamp(root, runId, check);
  out({ ok: true, stamp, tree: check.tree, features: check.verified }, `stamped ${stamp} (verified: ${check.verified.join(", ")})\n`);
  return ExitCode.Ok;
}
