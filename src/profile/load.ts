import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CouldNotCompleteError } from "../errors.ts";
import type { Profile } from "./types.ts";

export const PROFILE_PATH = ".plumb/profile.json";

/** The raw profile JSON; validation happens separately so its issues can be reported precisely. */
export function readProfileJson(root: string): unknown {
  const file = path.join(root, PROFILE_PATH);
  if (!existsSync(file)) throw new CouldNotCompleteError(`${PROFILE_PATH} doesn't exist yet; /plumb-init writes it`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CouldNotCompleteError(`${PROFILE_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type { Profile };
