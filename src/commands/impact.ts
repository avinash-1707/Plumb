import path from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { loadFeatures } from "../features.ts";
import { branchChanges, stagedChanges } from "../impact/changes.ts";
import { computeImpact, type Impact } from "../impact/impact.ts";
import type { Io } from "../io.ts";
import { loadConfig } from "../config.ts";
import { buildMap, isIgnored } from "../map/build.ts";

export const IMPACT_USAGE = `Usage:
  plumb impact <base>       Impact set for the diff between <base> and HEAD (from their merge base)
  plumb impact --staged     Impact set for staged changes

Options:
  --format=components|files|features|full   Output shape (default full)
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

const FORMATS = new Set(["components", "files", "features", "full"]);

function renderFull(source: string, impact: Impact): string {
  const lines = [`impact (${source}): ${String(impact.changedFiles.length)} changed files, ${String(impact.components.length)} components`];
  for (const c of impact.components) lines.push(`  ${c.id}  ${c.reasons.join("; ")}`);
  if (impact.unassignedChangedFiles.length > 0) lines.push(`  outside any component: ${impact.unassignedChangedFiles.join(", ")}`);
  if (impact.touchedResources.length > 0) lines.push(`  resources touched: ${impact.touchedResources.join(", ")}`);
  lines.push(
    impact.features === null
      ? "  features: unknown (.plumb/features.json not generated yet)"
      : `  features: ${impact.features.map((f) => `${f.id} (${f.tier})`).join(", ") || "none"}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function impactCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      staged: { type: "boolean" },
      format: { type: "string" },
      json: { type: "boolean" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(IMPACT_USAGE);
    return ExitCode.Ok;
  }
  const format = values.format ?? "full";
  if (!FORMATS.has(format)) throw new UsageError(`--format must be one of ${[...FORMATS].join(", ")}`);
  const [base, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  if ((base === undefined) === (values.staged !== true)) throw new UsageError("give either a base ref or --staged");

  const root = path.resolve(values.cwd ?? ".");
  const config = loadConfig(root);
  const source = base === undefined ? { staged: true as const, files: stagedChanges(root) } : { base, ...branchChanges(root, base) };
  // Always against a fresh map of the current tree: a stale committed map would give a wrong impact set.
  const { map } = await buildMap({ root, config, cache: "read-write" });
  const impact = computeImpact(map, source.files.filter((f) => !isIgnored(f, config)), loadFeatures(root));
  const failures = map.manifest.extractorFailures;

  const label = "staged" in source ? "staged" : `${source.base}...HEAD`;
  const existing = impact.changedFiles.filter((f) => map.components.some((c) => f in c.files) || map.manifest.unassignedFiles.includes(f));
  if (format === "components") {
    const ids = impact.components.map((c) => c.id);
    io.stdout(values.json === true ? `${JSON.stringify(ids)}\n` : ids.map((id) => `${id}\n`).join(""));
  } else if (format === "files") {
    // Files that still exist, for scoped checks like `vitest related {files}`; deletions have nothing to run.
    io.stdout(values.json === true ? `${JSON.stringify(existing)}\n` : existing.map((f) => `${f}\n`).join(""));
  } else if (format === "features") {
    const ids = (impact.features ?? []).map((f) => f.id);
    io.stdout(values.json === true ? `${JSON.stringify(ids)}\n` : ids.map((id) => `${id}\n`).join(""));
  } else if (values.json === true) {
    const meta = "staged" in source ? { staged: true } : { base: source.base, mergeBase: source.mergeBase };
    io.stdout(`${JSON.stringify({ source: meta, ...impact, extractorFailures: failures }, null, 2)}\n`);
  } else {
    io.stdout(renderFull(label, impact));
  }
  // A map missing facts can miss impacted components: the result is printed but not trusted.
  for (const f of failures) io.stderr(`  ✗ ${f.extractor}${f.component === null ? "" : ` (${f.component})`}: ${f.reason}\n`);
  return failures.length > 0 ? ExitCode.CouldNotComplete : ExitCode.Ok;
}
