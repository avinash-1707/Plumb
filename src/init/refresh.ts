import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FEATURES_PATH, type FeatureIndex } from "../features.ts";
import { type GateRegeneration, regenerateGate } from "../gate/regenerate.ts";
import { ensureGitignore } from "../managed/block.ts";
import { type RefreshOutcome, refreshManagedFile } from "../managed/regions.ts";
import { buildMap, renderMap } from "../map/build.ts";
import { staleMapFiles } from "../map/freshness.ts";
import { writeMap } from "../map/store.ts";
import { loadValidProfile, PROFILE_PATH } from "../profile/load.ts";
import { DOCTOR_HELPER, skillDir } from "../verify/paths.ts";
import { featureTitle, renderDoctor, renderFeaturesReadme, renderSkill } from "../verify/scaffold.ts";

export interface RefreshReport {
  map: { changed: string[]; removed: string[]; failures: string[] };
  gate: GateRegeneration | null;
  /** Managed files and what regeneration did to each; "conflict" left the file alone and wrote `<file>.plumb-new`. */
  files: Array<{ file: string; outcome: RefreshOutcome }>;
}

/**
 * `plumb init --refresh`, the deterministic half: rebuild the map, then regenerate every managed region Plumb owns
 * (gate.sh, the published verify skill's SKILL.md and features/README.md, the doctor helper) from the current
 * profile and features. Regions edited by hand are never overwritten (doc 2). Unchanged inputs give unchanged files.
 */
export async function refreshSetup(root: string): Promise<RefreshReport> {
  ensureGitignore(root);
  const { map } = await buildMap({ root, cache: "read-write" });
  // Only a stale map is rewritten: builtAtCommit alone moves with every commit and isn't a change (D42).
  const written = staleMapFiles(root, map).length > 0 ? writeMap(root, renderMap(map)) : { changed: [], removed: [] };
  const report: RefreshReport = {
    map: { ...written, failures: map.manifest.extractorFailures.map((f) => `${f.extractor}${f.component === null ? "" : ` (${f.component})`}: ${f.reason}`) },
    gate: null,
    files: [],
  };
  if (!existsSync(path.join(root, PROFILE_PATH))) return report;
  const profile = loadValidProfile(root);
  report.gate = await regenerateGate(root, { measure: false });

  const dir = skillDir(profile.app.slug);
  const refresh = (rel: string, generated: string): void => {
    if (existsSync(path.join(root, rel))) report.files.push({ file: rel, outcome: refreshManagedFile(path.join(root, rel), generated) });
  };
  refresh(`${dir}/SKILL.md`, renderSkill(profile));
  const featuresFile = path.join(root, FEATURES_PATH);
  if (existsSync(featuresFile)) {
    const index = JSON.parse(readFileSync(featuresFile, "utf8")) as FeatureIndex;
    refresh(`${dir}/features/README.md`, renderFeaturesReadme(profile, index, (f) => featureTitle(root, dir, f) ?? f.id));
  }
  refresh(DOCTOR_HELPER, renderDoctor(profile));
  return report;
}
