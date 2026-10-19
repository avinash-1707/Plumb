import { parseArgs } from "node:util";
import { gateCommand } from "./commands/gate.ts";
import { hookCommand, hooksCommand } from "./commands/hooks.ts";
import { impactCommand } from "./commands/impact.ts";
import { doctorCommand, initCommand, statusCommand } from "./commands/init.ts";
import { knowledgeCommand } from "./commands/knowledge.ts";
import { localCommand } from "./commands/local.ts";
import { mapCommand } from "./commands/map.ts";
import { prCommand } from "./commands/pr.ts";
import { profileCommand } from "./commands/profile.ts";
import { verifyCommand } from "./commands/verify.ts";
import { ConfigError } from "./config.ts";
import { CouldNotCompleteError, UsageError } from "./errors.ts";
import { ExitCode } from "./exit-codes.ts";
import { GitError } from "./git.ts";
import type { Io } from "./io.ts";
import { ManagedRegionError } from "./managed/regions.ts";
import { readVersion } from "./version.ts";

export type { Io } from "./io.ts";

const USAGE = `Usage: plumb <command> [options]

Commands:
  init          Deterministic setup, or --refresh managed sections (plumb init --help)
  status        What Plumb has set up and what it last proved
  doctor        Check Plumb's own setup
  map           Build, update, check, show, and query the repo map (plumb map --help)
  impact        Components and features a diff affects (plumb impact --help)
  knowledge     Prepare and validate explorer findings (plumb knowledge --help)
  profile       Validate and verify .plumb/profile.json (plumb profile --help)
  local         Answers to unknowns in .plumb/local.json (plumb local --help)
  pr            Verification plan and report for a branch (plumb pr --help)
  gate          Run, dry-run, or regenerate the fast-tier gate (plumb gate --help)
  hooks         Install or uninstall the git pre-commit gate (plumb hooks --help)
  hook          Hook entry points for agents (plumb hook claude-pre-commit)
  verify        Verify skill: scaffold, validate, launch, doctor, cleanup, plan, stamp (plumb verify --help)

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`;

const COMMANDS: Record<string, (argv: readonly string[], io: Io) => Promise<ExitCode>> = {
  init: initCommand,
  status: statusCommand,
  doctor: doctorCommand,
  map: mapCommand,
  impact: impactCommand,
  knowledge: knowledgeCommand,
  profile: profileCommand,
  local: localCommand,
  verify: verifyCommand,
  gate: gateCommand,
  pr: prCommand,
  hooks: hooksCommand,
  hook: (argv, io) => hookCommand(argv, io),
};

function usageError(io: Io, message: string): ExitCode {
  io.stderr(`plumb: ${message}\n\n${USAGE}`);
  return ExitCode.InvalidUsage;
}

// parseArgs throws errors with ERR_PARSE_ARGS_* codes and readable messages for bad input.
function isParseArgsError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && "code" in err && typeof err.code === "string" && err.code.startsWith("ERR_PARSE_ARGS_");
}

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const commandIndex = argv.findIndex((a) => !a.startsWith("-"));
  const command = commandIndex === -1 ? undefined : argv[commandIndex];
  const handler = command === undefined ? undefined : COMMANDS[command];

  if (handler !== undefined && commandIndex > 0) {
    return usageError(io, `options go after the command: plumb ${command ?? ""} ${argv.slice(0, commandIndex).join(" ")}`);
  }
  if (handler !== undefined) {
    try {
      return await handler(argv.slice(1), io);
    } catch (err) {
      if (isParseArgsError(err) || err instanceof UsageError) {
        io.stderr(`plumb ${command ?? ""}: ${err.message}\n`);
        return ExitCode.InvalidUsage;
      }
      if (err instanceof CouldNotCompleteError || err instanceof ConfigError || err instanceof GitError || err instanceof ManagedRegionError) {
        io.stderr(`plumb ${command ?? ""}: ${err.message}\n`);
        return ExitCode.CouldNotComplete;
      }
      throw err;
    }
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    if (isParseArgsError(err)) return usageError(io, err.message);
    throw err;
  }

  if (parsed.values.version) {
    io.stdout(`${readVersion()}\n`);
    return ExitCode.Ok;
  }
  if (parsed.values.help) {
    io.stdout(USAGE);
    return ExitCode.Ok;
  }

  const [first] = parsed.positionals;
  if (first === undefined) return usageError(io, "missing command");
  return usageError(io, `unknown command "${first}"`);
}

/**
 * Process boundary: an unexpected error is a Plumb crash, not a failed check, so it maps to
 * CouldNotComplete (2). Letting it escape would exit 1 and read as "check failed" to hooks and CI.
 */
export async function main(argv: readonly string[], io: Io): Promise<ExitCode> {
  try {
    return await run(argv, io);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    io.stderr(`plumb: internal error\n${detail}\n`);
    return ExitCode.CouldNotComplete;
  }
}
