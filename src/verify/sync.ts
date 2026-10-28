import { writeFileSync } from "node:fs";
import path from "node:path";
import { CouldNotCompleteError } from "../errors.ts";
import { FEATURES_PATH, type FeatureIndex } from "../features.ts";
import { changedBetween, headCommit } from "../git.ts";
import { matchesAny } from "../glob.ts";
import { checkRun } from "./report.ts";

/**
 * Whether a feature's recipe was confirmed live since its code last changed: fresh, stale (code under its paths
 * changed after syncedAt), unaudited (never synced), or unknown (syncedAt isn't in this clone).
 */
export interface FeatureFreshness {
  id: string;
  state: "fresh" | "stale" | "unaudited" | "unknown";
  syncedAt: string | null;
  /** For stale: the changed files under the feature's paths. */
  changed: string[];
}

export function featureFreshness(root: string, features: FeatureIndex): FeatureFreshness[] {
  const diffs = new Map<string, string[] | null>();
  return features.features.map((f) => {
    if (f.syncedAt === undefined) return { id: f.id, state: "unaudited", syncedAt: null, changed: [] };
    if (!diffs.has(f.syncedAt)) diffs.set(f.syncedAt, changedBetween(root, f.syncedAt, "HEAD"));
    const diff = diffs.get(f.syncedAt) ?? null;
    if (diff === null) return { id: f.id, state: "unknown", syncedAt: f.syncedAt, changed: [] };
    const changed = diff.filter((file) => matchesAny(file, f.paths));
    return { id: f.id, state: changed.length === 0 ? "fresh" : "stale", syncedAt: f.syncedAt, changed };
  });
}

export interface SyncResult {
  commit: string;
  synced: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Records HEAD as syncedAt for every feature the run verified live whose code is the same at HEAD as in the tree the
 * run drove. A failed or unreachable-only feature, or one whose code changed after the drive, keeps its old value.
 */
export function syncFeatures(root: string, runId: string, features: FeatureIndex): SyncResult {
  // The same trust model as a stamp: the tree comes from run.json, which Plumb wrote at launch, and the evidence
  // must all be there; any problem refuses the whole run.
  const run = checkRun(root, runId);
  if (run.report === null || run.issues.length > 0 || run.launched === null) throw new CouldNotCompleteError(`not synced: ${run.issues.join("; ")}`);
  const commit = headCommit(root);
  if (commit === null) throw new CouldNotCompleteError("the repository has no commits yet");
  const sinceDrive = changedBetween(root, run.launched, "HEAD");
  if (sinceDrive === null) throw new CouldNotCompleteError(`can't read the tree run ${runId} drove`);

  const result: SyncResult = { commit, synced: [], skipped: [] };
  const known = new Map(features.features.map((f) => [f.id, f]));
  for (const reported of run.report.features) {
    const feature = known.get(reported.id);
    if (feature === undefined) result.skipped.push({ id: reported.id, reason: `not in ${FEATURES_PATH}` });
    else if (reported.subFeatures.some((s) => s.status === "failed")) result.skipped.push({ id: reported.id, reason: "a sub-feature failed" });
    else if (!reported.subFeatures.some((s) => s.status === "verified")) result.skipped.push({ id: reported.id, reason: "nothing was verified (only unreachable)" });
    else if (sinceDrive.some((f) => matchesAny(f, feature.paths))) result.skipped.push({ id: reported.id, reason: "its code changed after the drive; commit what was driven, or verify again" });
    else result.synced.push(reported.id);
  }
  if (result.synced.length > 0) {
    const updated: FeatureIndex = { ...features, features: features.features.map((f) => (result.synced.includes(f.id) ? { ...f, syncedAt: commit } : f)) };
    writeFileSync(path.join(root, FEATURES_PATH), `${JSON.stringify(updated, null, 2)}\n`);
  }
  return result;
}
