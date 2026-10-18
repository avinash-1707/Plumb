import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import type { Io } from "../io.ts";
import { buildMap, isIgnored } from "../map/build.ts";
import { listFiles } from "../git.ts";
import { readProfileJson } from "../profile/load.ts";
import { loadLocal } from "../profile/local.ts";
import { checkProfile } from "../profile/validate.ts";
import { formatVerify, verifyProfile } from "../profile/verify.ts";

export const PROFILE_USAGE = `Usage:
  plumb profile schema               Print the JSON schema .plumb/profile.json must match
  plumb profile validate             Check .plumb/profile.json: schema, every command runnable, derived strategy
  plumb profile verify [--boot-only] Run every profile command, boot services and run targets, then tear down

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

async function validated(root: string): Promise<ReturnType<typeof checkProfile>> {
  const config = loadConfig(root);
  const { map } = await buildMap({ root, config, cache: "read-write" });
  const files = listFiles(root).filter((f) => !isIgnored(f, config));
  return checkProfile(root, files, readProfileJson(root), map, config);
}

export async function profileCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: "boolean" }, cwd: { type: "string" }, "boot-only": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(PROFILE_USAGE);
    return ExitCode.Ok;
  }
  const root = path.resolve(values.cwd ?? ".");
  const [sub, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  if (values["boot-only"] === true && sub !== "verify") throw new UsageError("--boot-only only applies to profile verify");

  if (sub === "schema") {
    const dir = new URL("../../schemas/", import.meta.url);
    io.stdout(readFileSync(new URL("profile.json", dir), "utf8"));
    io.stdout(`\n// Shared definitions referenced as common.json#/$defs/...:\n${readFileSync(new URL("common.json", dir), "utf8")}`);
    return ExitCode.Ok;
  }
  if (sub === "validate") {
    const check = await validated(root);
    if (values.json === true) io.stdout(`${JSON.stringify({ ok: check.issues.length === 0, issues: check.issues, strategy: check.strategy }, null, 2)}\n`);
    else if (check.issues.length === 0) io.stdout(`profile is valid (strategy ${check.strategy?.strategy ?? "?"}: ${check.strategy?.reason ?? ""})\n`);
    else io.stdout(`profile is invalid:\n${check.issues.map((i) => `  ${i.path} ${i.message}`).join("\n")}\n`);
    return check.issues.length === 0 ? ExitCode.Ok : ExitCode.CheckFailed;
  }
  if (sub === "verify") {
    const check = await validated(root);
    if (check.profile === null || check.issues.length > 0) {
      throw new CouldNotCompleteError(`.plumb/profile.json is invalid; run plumb profile validate (${String(check.issues.length)} issues)`);
    }
    const result = await verifyProfile(root, check.profile, loadLocal(root), { bootOnly: values["boot-only"] === true });
    io.stdout(values.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatVerify(result));
    return result.ok ? ExitCode.Ok : ExitCode.CheckFailed;
  }
  throw new UsageError(sub === undefined ? "profile needs a subcommand: validate or verify" : `unknown profile subcommand "${sub}"`);
}
