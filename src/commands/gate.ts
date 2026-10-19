import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { regenerateGate } from "../gate/regenerate.ts";
import { GATE_PATH } from "../gate/script.ts";
import type { Io } from "../io.ts";

export const GATE_USAGE = `Usage:
  plumb gate                           Run .plumb/gate.sh (the fast tier) for the staged changes
  plumb gate --dry-run                 Show what the gate would run for the staged changes, without running it
  plumb gate --regenerate [--measure]  Rewrite gate.sh's managed regions from the profile; --measure times a
                                       smoke boot and turns it on only within half the gate budget

Options:
  --json        Machine-readable output on stdout (--regenerate)
  --cwd <dir>   Project root (default: current directory)
`;

/** Runs gate.sh with the caller's stdio; exit 1 is a failed check, anything else unexpected means it couldn't run. */
export function runGate(root: string, env: NodeJS.ProcessEnv, io: Io): ExitCode {
  const script = path.join(root, GATE_PATH);
  if (!existsSync(script)) throw new CouldNotCompleteError(`${GATE_PATH} doesn't exist; generate it with plumb gate --regenerate`);
  const result = spawnSync("sh", [script], { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  io.stdout(result.stdout);
  io.stderr(result.stderr);
  if (result.status === 0) return ExitCode.Ok;
  if (result.status === 1) return ExitCode.CheckFailed;
  return ExitCode.CouldNotComplete;
}

export async function gateCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      "dry-run": { type: "boolean" },
      regenerate: { type: "boolean" },
      measure: { type: "boolean" },
      json: { type: "boolean" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(GATE_USAGE);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
  if (values["dry-run"] === true && values.regenerate === true) throw new UsageError("choose one of --dry-run, --regenerate");
  if (values.measure === true && values.regenerate !== true) throw new UsageError("--measure only applies to --regenerate");
  const root = path.resolve(values.cwd ?? ".");

  if (values.regenerate !== true) return runGate(root, values["dry-run"] === true ? { ...process.env, PLUMB_DRY_RUN: "1" } : process.env, io);

  const { outcome, smoke, reason } = await regenerateGate(root, { measure: values.measure === true });
  const summary = { gate: GATE_PATH, outcome, smoke, reason };
  const said = outcome === "conflict" ? `kept ${GATE_PATH}: a managed region was edited by hand; the regenerated version is in ${GATE_PATH}.plumb-new` : `${outcome} ${GATE_PATH}`;
  io.stdout(values.json === true ? `${JSON.stringify(summary, null, 2)}\n` : `${said} (smoke boot ${smoke ? "on" : "off"}: ${reason})\n`);
  if (outcome === "conflict") return ExitCode.CheckFailed;
  return ExitCode.Ok;
}
