import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CONFIG_PATH } from "../config.ts";
import { dependencyCruiserVersion } from "../extractors/depcruise-imports.ts";
import { FEATURES_PATH } from "../features.ts";
import { GATE_PATH } from "../gate/script.ts";
import { INSTALL_RECORD, type InstallRecord } from "../hooks/install.ts";
import { MAP_DIR } from "../map/build.ts";
import { LOCAL_PATH } from "../profile/local.ts";
import { PROFILE_PATH } from "../profile/load.ts";
import { type SchemaName, validate } from "../schema/validate.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const NODE_FLOOR = [22, 20, 0];

function atLeast(version: string, floor: readonly number[]): boolean {
  const parts = version.split(".").map(Number);
  for (const [i, min] of floor.entries()) {
    const v = parts[i] ?? 0;
    if (v !== min) return v > min;
  }
  return true;
}

function schemaCheck(root: string, rel: string, schema: SchemaName): DoctorCheck | null {
  const file = path.join(root, rel);
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { name: rel, ok: false, detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = validate(schema, data);
  return { name: rel, ok: result.ok, detail: result.ok ? "matches its schema" : result.issues.map((i) => `${i.path} ${i.message}`).join("; ") };
}

/** `plumb doctor` (doc 8): Plumb's own setup, not the app. */
export function checkPlumb(root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const node = process.versions.node;
  checks.push({ name: "node", ok: atLeast(node, NODE_FLOOR), detail: `${node} (needs >= ${NODE_FLOOR.join(".")})` });
  const tsMajor = Number(ts.version.split(".")[0]);
  checks.push({ name: "typescript", ok: tsMajor >= 5 && tsMajor < 7, detail: `${ts.version} (extractors need the compiler API: 5.x or 6.x)` });
  checks.push({ name: "dependency-cruiser", ok: dependencyCruiserVersion() !== "unknown", detail: dependencyCruiserVersion() });

  const gate = path.join(root, GATE_PATH);
  if (existsSync(gate)) checks.push({ name: GATE_PATH, ok: (statSync(gate).mode & 0o111) !== 0, detail: (statSync(gate).mode & 0o111) !== 0 ? "executable" : "not executable (plumb gate --regenerate fixes it)" });

  const recordFile = path.join(root, INSTALL_RECORD);
  if (existsSync(recordFile)) {
    const record = JSON.parse(readFileSync(recordFile, "utf8")) as InstallRecord;
    const missing = record.files.filter((f) => !existsSync(f.path) || !readFileSync(f.path, "utf8").includes("gate.sh")).map((f) => f.path);
    checks.push({ name: "git hook", ok: missing.length === 0, detail: missing.length === 0 ? `installed via ${record.method}` : `install record says ${record.method}, but the gate is gone from ${missing.join(", ")} (plumb hooks uninstall, then install)` });
  } else checks.push({ name: "git hook", ok: true, detail: "not installed" });

  for (const [rel, schema] of [[PROFILE_PATH, "profile"], [FEATURES_PATH, "features"], [CONFIG_PATH, "config"], [LOCAL_PATH, "local"], [`${MAP_DIR}/manifest.json`, "map/manifest"], [`${MAP_DIR}/resources.json`, "map/resources"]] as const) {
    const check = schemaCheck(root, rel, schema);
    if (check !== null) checks.push(check);
  }
  const components = path.join(root, MAP_DIR, "components");
  if (existsSync(components)) {
    for (const f of readdirSync(components).filter((n) => n.endsWith(".json")).sort()) {
      const check = schemaCheck(root, `${MAP_DIR}/components/${f}`, "map/component");
      if (check !== null && !check.ok) checks.push(check);
    }
  }
  return checks;
}
