import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import type { Io } from "../io.ts";
import { prepareContext } from "../knowledge/context.ts";
import { EXPLORERS, isExplorer } from "../knowledge/explorers.ts";
import { checkKnowledge } from "../knowledge/validate.ts";

export const KNOWLEDGE_USAGE = `Usage:
  plumb knowledge prepare          Write .plumb/knowledge/context.json (scripts, churn, config files) for the explorers
  plumb knowledge schema <name>    Print the JSON schema an explorer's output must match
  plumb knowledge validate [name]  Validate .plumb/knowledge/<name>.json (all five without a name)

Explorers: ${EXPLORERS.join(", ")}

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

const SCHEMA_DIR = new URL("../../schemas/", import.meta.url);

export function knowledgeCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: "boolean" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(KNOWLEDGE_USAGE);
    return Promise.resolve(ExitCode.Ok);
  }
  const root = path.resolve(values.cwd ?? ".");
  const [sub, name, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  if (name !== undefined && !isExplorer(name)) throw new UsageError(`unknown explorer "${name}"; one of ${EXPLORERS.join(", ")}`);

  if (sub === "prepare") {
    const { file, context } = prepareContext(root);
    // The absolute directory, so whoever writes the explorers' results can't mistype the project path.
    const dir = path.join(root, path.dirname(file));
    io.stdout(values.json === true ? `${JSON.stringify({ knowledgeDir: dir, context }, null, 2)}\n` : `wrote ${file}\nknowledge directory: ${dir}\n`);
    return Promise.resolve(ExitCode.Ok);
  }
  if (sub === "schema") {
    if (name === undefined) throw new UsageError("knowledge schema needs an explorer name");
    // The schema refers to common.json; inline the referenced definitions' source alongside for the reader.
    io.stdout(readFileSync(new URL(`knowledge/${name}.json`, SCHEMA_DIR), "utf8"));
    io.stdout(`\n// Shared definitions referenced as ../common.json#/$defs/...:\n${readFileSync(new URL("common.json", SCHEMA_DIR), "utf8")}`);
    if (name === "runtime") {
      // runtime.json reuses the profile's readiness probe definition.
      const profile = JSON.parse(readFileSync(new URL("profile.json", SCHEMA_DIR), "utf8")) as { $defs: Record<string, unknown> };
      io.stdout(`\n// Referenced as ../profile.json#/$defs/readinessProbe (and port):\n${JSON.stringify({ readinessProbe: profile.$defs["readinessProbe"], port: profile.$defs["port"] }, null, 2)}\n`);
    }
    return Promise.resolve(ExitCode.Ok);
  }
  if (sub === "validate") {
    const results = (name === undefined ? EXPLORERS : [name]).map((n) => ({ name: n, ...checkKnowledge(root, n) }));
    const ok = results.every((r) => r.issues.length === 0);
    if (values.json === true) io.stdout(`${JSON.stringify(results, null, 2)}\n`);
    else {
      for (const r of results) {
        if (r.issues.length === 0) io.stdout(`✓ ${r.name}\n`);
        else io.stdout(`✗ ${r.name}\n${r.issues.map((i) => `    ${i.path} ${i.message}`).join("\n")}\n`);
      }
    }
    return Promise.resolve(ok ? ExitCode.Ok : ExitCode.CheckFailed);
  }
  throw new UsageError(sub === undefined ? "knowledge needs a subcommand: prepare, schema, or validate" : `unknown knowledge subcommand "${sub}"`);
}
