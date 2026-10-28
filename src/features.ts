import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CouldNotCompleteError } from "./errors.ts";
import { validate } from "./schema/validate.ts";

export interface Feature {
  id: string;
  file: string;
  paths: string[];
  components: string[];
  entryPoints: string[];
  tier: "fast-only" | "deep";
  /** Commit at which a live run last confirmed the recipe (plumb verify --sync). */
  syncedAt?: string;
}

export interface FeatureIndex {
  features: Feature[];
}

export const FEATURES_PATH = ".plumb/features.json";

/** .plumb/features.json, or null before init has generated it. */
export function loadFeatures(root: string): FeatureIndex | null {
  const file = path.join(root, FEATURES_PATH);
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CouldNotCompleteError(`${FEATURES_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = validate("features", data);
  if (!result.ok) throw new CouldNotCompleteError(`${FEATURES_PATH} is invalid: ${result.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  return data as FeatureIndex;
}
