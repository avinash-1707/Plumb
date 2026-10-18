import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import type { Io } from "../io.ts";
import { readProfileJson } from "../profile/load.ts";
import { isAnswered, loadLocal, setUnknown } from "../profile/local.ts";
import type { Profile } from "../profile/types.ts";
import { validate } from "../schema/validate.ts";

export const LOCAL_USAGE = `Usage:
  plumb local set <unknown-id> [value]   Store an answer in .plumb/local.json; reads stdin when value is - or omitted
  plumb local status                     List the profile's unknowns and whether each is answered

Unknown ids: env.<NAME>, service.<name>.skip|start|stop, note.<id>
Values are never printed.

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

export function localCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: "boolean" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(LOCAL_USAGE);
    return Promise.resolve(ExitCode.Ok);
  }
  const root = path.resolve(values.cwd ?? ".");
  const [sub, id, value, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);

  if (sub === "set") {
    if (id === undefined) throw new UsageError("local set needs an unknown id");
    // Reading from stdin keeps secrets out of shell history and the process list.
    const answer = value === undefined || value === "-" ? readFileSync(0, "utf8").replace(/\r?\n$/, "") : value;
    if (answer === "") throw new UsageError(`no answer given for ${id}; pass it as an argument or on stdin`);
    setUnknown(root, id, answer);
    io.stdout(values.json === true ? `${JSON.stringify({ set: id })}\n` : `stored ${id} in .plumb/local.json (value not shown)\n`);
    return Promise.resolve(ExitCode.Ok);
  }
  if (sub === "status") {
    if (id !== undefined) throw new UsageError(`unexpected argument "${id}"`);
    const data = readProfileJson(root);
    const result = validate("profile", data);
    if (!result.ok) throw new UsageError(".plumb/profile.json is invalid; run plumb profile validate");
    const local = loadLocal(root);
    const rows = (data as Profile).unknowns.map((u) => ({ id: u.id, question: u.question, why: u.why, answered: isAnswered(local, u) }));
    if (values.json === true) io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    else if (rows.length === 0) io.stdout("no unknowns\n");
    else io.stdout(rows.map((r) => `${r.answered ? "✓" : "?"} ${r.id}  ${r.question}${r.answered ? "" : `\n    why: ${r.why}`}`).join("\n") + "\n");
    // Unanswered unknowns block verification of whatever needs them.
    return Promise.resolve(rows.every((r) => r.answered) ? ExitCode.Ok : ExitCode.CheckFailed);
  }
  throw new UsageError(sub === undefined ? "local needs a subcommand: set or status" : `unknown local subcommand "${sub}"`);
}
