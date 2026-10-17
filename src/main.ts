import { parseArgs } from "node:util";
import { ExitCode } from "./exit-codes.ts";
import { readVersion } from "./version.ts";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: plumb <command> [options]

Options:
  -h, --help     Show this help
  -v, --version  Show the version

No commands are implemented yet.
`;

function usageError(io: Io, message: string): ExitCode {
  io.stderr(`plumb: ${message}\n\n${USAGE}`);
  return ExitCode.InvalidUsage;
}

// parseArgs throws errors with ERR_PARSE_ARGS_* codes and readable messages for bad input.
function isParseArgsError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && "code" in err && typeof err.code === "string" && err.code.startsWith("ERR_PARSE_ARGS_");
}

export function run(argv: readonly string[], io: Io): ExitCode {
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

  const [command] = parsed.positionals;
  if (command === undefined) return usageError(io, "missing command");
  return usageError(io, `unknown command "${command}"`);
}

/**
 * Process boundary: an unexpected error is a Plumb crash, not a failed check, so it maps to
 * CouldNotComplete (2). Letting it escape would exit 1 and read as "check failed" to hooks and CI.
 */
export function main(argv: readonly string[], io: Io): ExitCode {
  try {
    return run(argv, io);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    io.stderr(`plumb: internal error\n${detail}\n`);
    return ExitCode.CouldNotComplete;
  }
}
