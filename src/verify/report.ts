import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FeatureIndex } from "../features.ts";
import { validate } from "../schema/validate.ts";
import { runDir, STAMPS_DIR, staysInside } from "./paths.ts";

/** Mirrors schemas/verify-report.json. */
export interface VerifyReport {
  schemaVersion: 1;
  runId: string;
  tree: string;
  features: Array<{
    id: string;
    subFeatures: Array<{
      id: string;
      status: "verified" | "verified-unreachable" | "failed";
      entryPoint: string;
      artifacts: string[];
      observed: string;
      prerequisite?: string;
    }>;
  }>;
}

export type ReportRead = { ok: true; report: VerifyReport } | { ok: false; issues: string[] };

export function readReport(root: string, runId: string): ReportRead | null {
  const file = path.join(root, runDir(runId), "report.json");
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, issues: [`report.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const result = validate("verify-report", data);
  if (!result.ok) return { ok: false, issues: result.issues.map((i) => `report.json ${i.path} ${i.message}`) };
  return { ok: true, report: data as VerifyReport };
}

/**
 * Artifacts a report lists that are missing, not files, outside the run directory, or not under their feature's
 * folder. An empty file counts: "no console errors" is an empty log, and still proof.
 */
export function artifactIssues(root: string, report: VerifyReport): { checked: number; missing: string[] } {
  const dir = path.join(root, runDir(report.runId));
  let checked = 0;
  const missing: string[] = [];
  for (const feature of report.features) {
    for (const sub of feature.subFeatures) {
      for (const artifact of sub.artifacts) {
        checked++;
        if (!staysInside(artifact) || !path.posix.normalize(artifact).startsWith(`${feature.id}/`)) {
          missing.push(`${artifact} (must be under ${feature.id}/ in the run directory)`);
          continue;
        }
        const file = path.join(dir, artifact);
        if (!existsSync(file)) missing.push(artifact);
        else if (!statSync(file).isFile()) missing.push(`${artifact} (not a file)`);
      }
    }
  }
  return { checked, missing };
}

/** The evidence-survives-cleanup check: every artifact report.json names still exists. No report yet is not a failure. */
export function checkReportArtifacts(root: string, runId: string): { report: boolean; checked: number; missing: string[] } {
  const read = readReport(root, runId);
  if (read === null) return { report: false, checked: 0, missing: [] };
  if (!read.ok) return { report: true, checked: 0, missing: read.issues };
  return { report: true, ...artifactIssues(root, read.report) };
}

export interface StampCheck {
  ok: boolean;
  issues: string[];
  tree: string;
  verified: string[];
  /** The report itself, when it could be read. */
  report?: VerifyReport;
}

/**
 * Whether a run proves the staged tree: report.md and a schema-valid report.json exist, every artifact exists, the
 * launched run was cleaned up, the report is for this exact tree, every feature is known, nothing failed, and every
 * deep feature the staged diff touches has at least one verified sub-feature (unreachable alone isn't proof).
 */
export function checkStamp(root: string, runId: string, tree: string, features: FeatureIndex, touchedDeep: readonly string[], treeLabel = "the staged tree"): StampCheck {
  const issues: string[] = [];
  const dir = runDir(runId);
  const read = readReport(root, runId);
  if (read === null) return { ok: false, issues: [`${dir}/report.json doesn't exist`], tree, verified: [] };
  if (!read.ok) return { ok: false, issues: read.issues, tree, verified: [] };
  const report = read.report;
  if (report.runId !== runId) issues.push(`report.json runId is "${report.runId}", not "${runId}"`);
  if (!existsSync(path.join(root, dir, "report.md"))) issues.push(`${dir}/report.md doesn't exist`);
  issues.push(...artifactIssues(root, report).missing.map((m) => `artifact missing: ${m}`));
  // The tree comes from run.json, which Plumb wrote at launch, not from the agent's report: a run proves only the
  // content it actually drove.
  const stateFile = path.join(root, dir, "run.json");
  let launched: string | null = null;
  if (!existsSync(stateFile)) issues.push(`${dir}/run.json doesn't exist; only a run started with plumb verify --launch can be stamped`);
  else {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { cleanedUpAt?: string | null; tree?: string };
    launched = state.tree ?? null;
    if (state.cleanedUpAt == null) issues.push(`run ${runId} is still running; run plumb verify --cleanup ${runId} first`);
    if (report.tree !== launched) issues.push(`report.json names tree ${report.tree}, but the run was launched on ${launched ?? "an unrecorded tree"}`);
  }
  if (launched !== null && launched !== tree) issues.push(`the run drove tree ${launched}, but ${treeLabel} is ${tree}; the content changed after the drive, so verify again`);
  const known = new Set(features.features.map((f) => f.id));
  for (const f of report.features) if (!known.has(f.id)) issues.push(`feature "${f.id}" is not in .plumb/features.json`);
  for (const f of report.features) {
    for (const s of f.subFeatures) if (s.status === "failed") issues.push(`${f.id}/${s.id} failed: ${s.observed}`);
  }
  const verified = report.features.filter((f) => f.subFeatures.some((s) => s.status === "verified")).map((f) => f.id);
  for (const id of touchedDeep) if (!verified.includes(id)) issues.push(`the changes touch deep feature "${id}", which this run didn't verify`);
  return { ok: issues.length === 0, issues, tree, verified, report };
}

/** Writes .plumb/stamps/deep-<tree> pointing at the evidence report (doc 6). */
export function writeDeepStamp(root: string, runId: string, check: StampCheck): string {
  const rel = `${STAMPS_DIR}/deep-${check.tree}`;
  mkdirSync(path.join(root, STAMPS_DIR), { recursive: true });
  const stamp = { tree: check.tree, runId, report: `${runDir(runId)}/report.md`, features: check.verified, stampedAt: new Date().toISOString() };
  writeFileSync(path.join(root, rel), `${JSON.stringify(stamp, null, 2)}\n`);
  return rel;
}
