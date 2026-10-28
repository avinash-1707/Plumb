import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { GATE_PATH, hasSmoke } from "../gate/script.ts";
import { writeTree } from "../git.ts";
import { INSTALL_RECORD, type InstallRecord } from "../hooks/install.ts";
import { CouldNotCompleteError } from "../errors.ts";
import { loadFeatures } from "../features.ts";
import { buildMap } from "../map/build.ts";
import { staleMapFiles } from "../map/freshness.ts";
import { loadValidProfile, PROFILE_PATH } from "../profile/load.ts";
import { EVIDENCE_DIR, skillDir, STAMPS_DIR } from "../verify/paths.ts";
import { featureFreshness } from "../verify/sync.ts";

export interface StatusReport {
  initialized: boolean;
  map: { upToDate: boolean; stale: string[]; failures: number };
  profile: { strategy: string; runTargets: string[]; services: string[] } | null;
  skill: string | null;
  /** Feature recipes by freshness against their code (plumb verify --stale); null before features.json exists. */
  features: { total: number; stale: string[]; unaudited: string[]; unknown: string[] } | { invalid: string } | null;
  gate: { present: boolean; smoke: boolean; stagedTreePassed: boolean; last: { dir: string; passed: boolean } | null };
  lastDeepVerification: { tree: string; report: string; features: string[]; stampedAt: string } | null;
  /** The newest launched run that wrote a report.json and was cleaned up: proof the verify skill has run. */
  lastProvenRun: string | null;
  recentBypasses: string[];
  hooks: string | null;
  conflicts: string[];
}

function provenRun(root: string): string | null {
  const dir = path.join(root, EVIDENCE_DIR);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir)
    .filter((name) => name.startsWith("run-") && existsSync(path.join(dir, name, "report.json")) && existsSync(path.join(dir, name, "run.json")))
    .filter((name) => (JSON.parse(readFileSync(path.join(dir, name, "run.json"), "utf8")) as { cleanedUpAt?: string | null }).cleanedUpAt != null)
    .sort();
  return runs.at(-1) ?? null;
}

function newest(dir: string, prefix: string): { name: string; mtime: number } | null {
  if (!existsSync(dir)) return null;
  let best: { name: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const mtime = statSync(path.join(dir, name)).mtimeMs;
    if (best === null || mtime > best.mtime) best = { name, mtime };
  }
  return best;
}

/** `<file>.plumb-new` files: regenerations that found a managed region edited by hand. */
function conflicts(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs, { recursive: true, encoding: "utf8" })) if (f.endsWith(".plumb-new")) out.push(path.posix.join(dir, f.split(path.sep).join("/")));
  }
  return out.sort();
}

/** `plumb status` (doc 8). Reads state only; the map freshness check builds the map in memory. */
export async function collectStatus(root: string): Promise<StatusReport> {
  const initialized = existsSync(path.join(root, PROFILE_PATH));
  const { map } = await buildMap({ root, cache: "read-write" });
  const stale = staleMapFiles(root, map);
  const profile = initialized ? loadValidProfile(root) : null;
  const gateFile = path.join(root, GATE_PATH);
  const gatePresent = existsSync(gateFile);
  const tree = writeTree(root);
  const stamps = path.join(root, STAMPS_DIR);
  const lastGate = newest(path.join(root, EVIDENCE_DIR), "gate-");
  const lastDeep = newest(stamps, "deep-");
  const bypassLog = path.join(root, ".plumb/cache/bypass.log");
  const record = existsSync(path.join(root, INSTALL_RECORD)) ? (JSON.parse(readFileSync(path.join(root, INSTALL_RECORD), "utf8")) as InstallRecord) : null;
  const skill = profile === null ? null : skillDir(profile.app.slug);
  let features: StatusReport["features"] = null;
  try {
    const index = loadFeatures(root);
    if (index !== null) {
      const freshness = featureFreshness(root, index);
      const inState = (state: string): string[] => freshness.filter((f) => f.state === state).map((f) => f.id);
      features = { total: freshness.length, stale: inState("stale"), unaudited: inState("unaudited"), unknown: inState("unknown") };
    }
  } catch (err) {
    // Status reports a broken features.json rather than failing on it; plumb doctor names the schema issue.
    if (!(err instanceof CouldNotCompleteError)) throw err;
    features = { invalid: err.message };
  }
  return {
    initialized,
    map: { upToDate: stale.length === 0, stale, failures: map.manifest.extractorFailures.length },
    profile: profile === null ? null : { strategy: profile.strategy, runTargets: profile.run.map((t) => t.name), services: profile.services.map((s) => s.name) },
    skill: skill !== null && existsSync(path.join(root, skill, "SKILL.md")) ? skill : null,
    features,
    gate: {
      present: gatePresent,
      smoke: gatePresent && hasSmoke(readFileSync(gateFile, "utf8")),
      stagedTreePassed: existsSync(path.join(stamps, `fast-${tree}`)),
      last: lastGate === null ? null : { dir: `${EVIDENCE_DIR}/${lastGate.name}`, passed: existsSync(path.join(stamps, `fast-${lastGate.name.slice("gate-".length)}`)) },
    },
    lastDeepVerification: lastDeep === null ? null : (JSON.parse(readFileSync(path.join(stamps, lastDeep.name), "utf8")) as StatusReport["lastDeepVerification"]),
    lastProvenRun: provenRun(root),
    recentBypasses: existsSync(bypassLog) ? readFileSync(bypassLog, "utf8").trim().split("\n").filter((l) => l !== "").slice(-5) : [],
    hooks: record === null ? null : record.method,
    conflicts: conflicts(root, [".plumb", ...(skill === null ? [] : [skill])]),
  };
}

export function formatStatus(s: StatusReport): string {
  const lines = [`plumb: ${s.initialized ? "initialized" : "not initialized (run /plumb-init in Claude Code)"}`];
  lines.push(`  map        ${s.map.upToDate ? "up to date" : `stale (${String(s.map.stale.length)} files; run plumb map --update)`}${s.map.failures > 0 ? `, ${String(s.map.failures)} extractor failures` : ""}`);
  if (s.profile !== null) lines.push(`  profile    ${s.profile.strategy}; run targets: ${s.profile.runTargets.join(", ") || "none"}; services: ${s.profile.services.join(", ") || "none"}`);
  lines.push(`  skill      ${s.skill ?? "not generated"}`);
  if (s.features !== null && "invalid" in s.features) lines.push(`  features   ${s.features.invalid}`);
  else if (s.features !== null) {
    const parts = [`${String(s.features.total)} mapped`];
    if (s.features.stale.length > 0) parts.push(`stale since last confirmed: ${s.features.stale.join(", ")}`);
    if (s.features.unaudited.length > 0) parts.push(`never confirmed live: ${s.features.unaudited.join(", ")}`);
    if (s.features.unknown.length > 0) parts.push(`sync commit not in this clone: ${s.features.unknown.join(", ")}`);
    lines.push(`  features   ${parts.join("; ")}${parts.length > 1 ? " (/plumb-refine)" : ""}`);
  }
  lines.push(`  gate       ${s.gate.present ? `${GATE_PATH} (smoke boot ${s.gate.smoke ? "on" : "off"}); staged tree ${s.gate.stagedTreePassed ? "passed" : "not checked yet"}` : "not generated"}`);
  if (s.gate.last !== null) lines.push(`  last gate  ${s.gate.last.passed ? "passed" : "failed"} (${s.gate.last.dir})`);
  lines.push(`  deep       ${s.lastDeepVerification === null ? "never verified" : `${s.lastDeepVerification.features.join(", ")} at ${s.lastDeepVerification.stampedAt} (${s.lastDeepVerification.report})`}`);
  lines.push(`  proven     ${s.lastProvenRun === null ? "the verify skill has never run to a report (the init self-proof didn't finish)" : `${s.lastProvenRun} (${EVIDENCE_DIR}/${s.lastProvenRun}/)`}`);
  lines.push(`  hooks      ${s.hooks === null ? "not installed (plumb hooks install)" : `installed via ${s.hooks}`}`);
  if (s.recentBypasses.length > 0) lines.push("  bypasses", ...s.recentBypasses.map((b) => `    ${b}`));
  if (s.conflicts.length > 0) lines.push("  conflicts  managed regions edited by hand; merge these and delete them:", ...s.conflicts.map((c) => `    ${c}`));
  return `${lines.join("\n")}\n`;
}
