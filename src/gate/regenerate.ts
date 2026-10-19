import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { type RefreshOutcome, refreshManagedFile } from "../managed/regions.ts";
import { loadValidProfile } from "../profile/load.ts";
import { loadLocal } from "../profile/local.ts";
import type { Profile } from "../profile/types.ts";
import { cleanup, doctor, launch } from "../verify/launch.ts";
import { GATE_PATH, hasSmoke, renderGate, smokeApplies } from "./script.ts";

/** Boots the run targets once, Doctor, teardown, and times it: the smoke step's cost in the fast tier. */
async function measureSmoke(root: string, profile: Profile): Promise<{ ok: boolean; seconds: number; detail: string }> {
  const local = loadLocal(root);
  const started = Date.now();
  const launched = await launch(root, profile, local, {});
  if (!launched.ok) return { ok: false, seconds: (Date.now() - started) / 1000, detail: `launch failed (${launched.steps.at(-1)?.detail ?? "see the run's logs"})` };
  const health = await doctor(root, profile, launched.runId);
  const done = await cleanup(root, profile, local, launched.runId);
  const seconds = (Date.now() - started) / 1000;
  if (!health.ok) return { ok: false, seconds, detail: `doctor failed: ${health.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}` };
  if (!done.ok) return { ok: false, seconds, detail: `teardown left ${done.survivors.join(", ")}` };
  return { ok: true, seconds, detail: `launch, doctor, and teardown took ${seconds.toFixed(1)}s` };
}

export interface GateRegeneration {
  outcome: RefreshOutcome;
  smoke: boolean;
  reason: string;
}

/**
 * Regenerates gate.sh's managed regions from the profile (conflicts go to gate.sh.plumb-new). Smoke boot: config.json
 * decides when set; else a fresh measurement when asked; else whatever the current gate.sh already does (D61).
 */
export async function regenerateGate(root: string, options: { measure: boolean }): Promise<GateRegeneration> {
  const config = loadConfig(root);
  const profile = loadValidProfile(root);
  const file = path.join(root, GATE_PATH);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  const budget = config.gate?.budgetSec ?? 30;
  let smoke = false;
  let reason: string;
  if (config.gate?.smoke !== undefined) {
    smoke = config.gate.smoke && smokeApplies(profile);
    reason = `config.json gate.smoke is ${String(config.gate.smoke)}${config.gate.smoke && !smoke ? ", but the profile has nothing to boot" : ""}`;
  } else if (!smokeApplies(profile)) {
    reason = `strategy ${profile.strategy} has nothing to boot`;
  } else if (options.measure) {
    const measured = await measureSmoke(root, profile);
    smoke = measured.ok && measured.seconds <= budget / 2;
    reason = measured.ok ? `${measured.detail}; ${smoke ? "within" : "over"} half the ${String(budget)}s budget` : `${measured.detail}; smoke off`;
  } else {
    smoke = current !== null && hasSmoke(current);
    reason = current === null ? "not measured (use --measure); smoke off" : `kept from the current ${GATE_PATH}`;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const outcome = refreshManagedFile(file, renderGate(profile, config, smoke));
  if (outcome !== "conflict") chmodSync(file, 0o755);
  return { outcome, smoke, reason };
}
