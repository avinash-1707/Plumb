import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import { claudePreCommit } from "../hooks/claude.ts";
import { sessionDigest } from "../hooks/digest.ts";
import { installHooks, uninstallHooks } from "../hooks/install.ts";
import type { Io } from "../io.ts";

export const HOOKS_USAGE = `Usage:
  plumb hooks install     Chain .plumb/gate.sh into the repo's pre-commit setup (husky, lefthook, pre-commit,
                          core.hooksPath, or .git/hooks), recording every change
  plumb hooks uninstall   Reverse exactly what install recorded

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

export function hooksCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: "boolean" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(HOOKS_USAGE);
    return Promise.resolve(ExitCode.Ok);
  }
  const [sub, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  const root = path.resolve(values.cwd ?? ".");
  if (sub === "install") {
    const { installed, record } = installHooks(root);
    io.stdout(values.json === true ? `${JSON.stringify({ installed, record }, null, 2)}\n` : installed ? `installed the gate via ${record.method} (${record.files.map((f) => f.path).join(", ")})\n` : `the gate already runs via ${record.method}; nothing changed\n`);
    return Promise.resolve(ExitCode.Ok);
  }
  if (sub === "uninstall") {
    const { uninstalled, record, kept } = uninstallHooks(root);
    const keptLines = kept.map((k) => `  ${k}: changed since install, so only Plumb's entry was removed\n`).join("");
    io.stdout(values.json === true ? `${JSON.stringify({ uninstalled, record, kept }, null, 2)}\n` : uninstalled ? `uninstalled the gate (${record?.method ?? ""}); restored what was there before\n${keptLines}` : "nothing to uninstall: no install record\n");
    return Promise.resolve(ExitCode.Ok);
  }
  throw new UsageError(sub === undefined ? "hooks needs a subcommand: install or uninstall" : `unknown hooks subcommand "${sub}"`);
}

export const HOOK_USAGE = `Usage:
  plumb hook claude-pre-commit     Claude Code PreToolUse hook: reads the payload on stdin; exit 2 blocks the commit
  plumb hook claude-session-start  Claude Code SessionStart hook: prints the map digest for the session's context
`;

/**
 * Hook entry points. Claude Code treats exit 2 as "block, show stderr" and any other non-zero exit as a
 * non-blocking error, so every failure here is mapped deliberately: a crash blocks, with the bypass named.
 */
export function hookCommand(argv: readonly string[], io: Io, readStdin: () => string = () => readFileSync(0, "utf8")): Promise<ExitCode> {
  const [name, extra] = argv;
  if (name === "--help" || name === "-h") {
    io.stdout(HOOK_USAGE);
    return Promise.resolve(ExitCode.Ok);
  }
  if (name === "claude-session-start" && extra === undefined) {
    try {
      const payload = JSON.parse(readStdin()) as { cwd?: unknown };
      const digest = sessionDigest(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
      if (digest !== null) io.stdout(`${digest}\n`);
    } catch (err) {
      // Session start must not fail on a broken map; the agent is told instead, so it doesn't trust a stale picture.
      io.stdout(`Plumb couldn't read this repo's map (${err instanceof Error ? err.message : String(err)}); run plumb map.\n`);
    }
    return Promise.resolve(ExitCode.Ok);
  }
  if (name !== "claude-pre-commit" || extra !== undefined) throw new UsageError(name === undefined ? "hook needs a name: claude-pre-commit or claude-session-start" : `unknown hook "${name}"`);
  try {
    const decision = claudePreCommit(JSON.parse(readStdin()) as unknown);
    if (!decision.block) return Promise.resolve(ExitCode.Ok);
    io.stderr(`${decision.reason}\n`);
  } catch (err) {
    io.stderr(`plumb hook failed: ${err instanceof Error ? err.message : String(err)}\nTo commit without the Plumb gate, prefix the command with PLUMB_SKIP=1 (it is logged).\n`);
  }
  return Promise.resolve(ExitCode.CouldNotComplete);
}
