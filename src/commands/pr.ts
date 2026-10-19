import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { FEATURES_PATH, loadFeatures } from "../features.ts";
import { headTree } from "../git.ts";
import { branchChanges } from "../impact/changes.ts";
import { computeImpact, type Impact } from "../impact/impact.ts";
import type { Io } from "../io.ts";
import { buildMap, isIgnored } from "../map/build.ts";
import { staleMapFiles } from "../map/freshness.ts";
import { loadValidProfile } from "../profile/load.ts";
import { runDir, skillDir } from "../verify/paths.ts";
import { checkStamp, type StampCheck } from "../verify/report.ts";

export const PR_USAGE = `Usage:
  plumb pr <base>                 Map freshness, impact set, and the deep features to verify for this branch
  plumb pr <base> --run <run-id>  Check a finished verification run covers exactly those features; write the PR report

/plumb-pr in Claude Code runs both, driving the features in between.

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

interface PrPlan {
  base: string;
  mergeBase: string;
  changedFiles: number;
  map: { upToDate: boolean; stale: string[] };
  impact: Impact;
  drive: Array<{ id: string; recipe: string }>;
}

async function plan(root: string, base: string): Promise<PrPlan> {
  const config = loadConfig(root);
  const profile = loadValidProfile(root);
  const features = loadFeatures(root);
  if (features === null) throw new CouldNotCompleteError(`${FEATURES_PATH} doesn't exist yet; /plumb-init generates it`);
  const { mergeBase, files } = branchChanges(root, base);
  const { map } = await buildMap({ root, config, cache: "read-write" });
  const stale = staleMapFiles(root, map);
  const impact = computeImpact(map, files.filter((f) => !isIgnored(f, config)), features);
  const dir = skillDir(profile.app.slug);
  const drive = (impact.features ?? []).filter((f) => f.tier === "deep").map((f) => ({ id: f.id, recipe: `${dir}/${features.features.find((x) => x.id === f.id)?.file ?? ""}` }));
  return { base, mergeBase, changedFiles: files.length, map: { upToDate: stale.length === 0, stale }, impact, drive };
}

function formatPlan(p: PrPlan): string {
  const lines = [`plumb pr ${p.base} (merge base ${p.mergeBase.slice(0, 12)}): ${String(p.changedFiles)} changed files`];
  lines.push(`  map        ${p.map.upToDate ? "up to date" : `stale: run plumb map --update and commit .plumb/map (${String(p.map.stale.length)} files)`}`);
  lines.push(`  components ${p.impact.components.map((c) => c.id).join(", ") || "none"}`);
  const fastOnly = (p.impact.features ?? []).filter((f) => f.tier !== "deep").map((f) => f.id);
  if (fastOnly.length > 0) lines.push(`  fast-only  ${fastOnly.join(", ")} (covered by the gate)`);
  if (p.drive.length === 0) lines.push("  verify     nothing: no deep-tier feature is touched");
  for (const d of p.drive) lines.push(`  verify     ${d.id}  ${d.recipe}`);
  return `${lines.join("\n")}\n`;
}

/** The PR report (doc 8): what changed, what was verified live, with evidence, and anything still open. */
function prReport(p: PrPlan, runId: string, check: StampCheck): string {
  const lines = [`# Plumb PR verification: ${p.base}...HEAD`, "", `- Merge base: \`${p.mergeBase}\``, `- Changed files: ${String(p.changedFiles)}`, `- Impacted components: ${p.impact.components.map((c) => `\`${c.id}\``).join(", ") || "none"}`, `- Map: ${p.map.upToDate ? "up to date" : "stale (commit `plumb map --update`)"}`, `- Run: \`${runId}\` (evidence in \`${runDir(runId)}/\`)`, "", `## Result: ${check.ok ? "verified" : "not verified"}`, ""];
  for (const f of check.report?.features ?? []) {
    lines.push(`### ${f.id}${p.drive.some((d) => d.id === f.id) ? "" : " (not touched by this branch)"}`, "");
    for (const s of f.subFeatures) lines.push(`- \`${s.id}\` **${s.status}** via ${s.entryPoint}: ${s.observed}${s.prerequisite === undefined ? "" : ` (missing: ${s.prerequisite})`}${s.artifacts.length === 0 ? "" : ` [${s.artifacts.map((a) => `\`${a}\``).join(", ")}]`}`);
    lines.push("");
  }
  if (check.issues.length > 0) lines.push("## Open issues", "", ...check.issues.map((i) => `- ${i}`), "");
  return lines.join("\n");
}

export async function prCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { run: { type: "string" }, json: { type: "boolean" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(PR_USAGE);
    return ExitCode.Ok;
  }
  const [base, extra] = positionals;
  if (base === undefined) throw new UsageError("pr needs a base ref, e.g. plumb pr main");
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  if (values.run !== undefined) runDir(values.run);
  const root = path.resolve(values.cwd ?? ".");
  const p = await plan(root, base);
  if (values.run === undefined) {
    io.stdout(values.json === true ? `${JSON.stringify(p, null, 2)}\n` : formatPlan(p));
    return ExitCode.Ok;
  }
  const features = loadFeatures(root);
  if (features === null) throw new CouldNotCompleteError(`${FEATURES_PATH} doesn't exist yet`);
  const check = checkStamp(root, values.run, headTree(root), features, p.drive.map((d) => d.id), "HEAD's tree");
  const reportFile = `${runDir(values.run)}/pr-report.md`;
  mkdirSync(path.join(root, runDir(values.run)), { recursive: true });
  writeFileSync(path.join(root, reportFile), prReport(p, values.run, check));
  if (values.json === true) io.stdout(`${JSON.stringify({ ok: check.ok, report: reportFile, verified: check.verified, issues: check.issues }, null, 2)}\n`);
  else io.stdout(`${check.ok ? "✓ PR verified" : "✗ PR not verified"}: ${check.verified.join(", ") || "nothing verified"}\n${check.issues.map((i) => `  ✗ ${i}\n`).join("")}report: ${reportFile}\n`);
  return check.ok ? ExitCode.Ok : ExitCode.CheckFailed;
}
