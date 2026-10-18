import path from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import type { Io } from "../io.ts";
import { buildMap, MAP_DIR, renderMap } from "../map/build.ts";
import { MapIndex, type EdgeRef, type MapNode } from "../map/query.ts";
import { factsVersion } from "../map/serialize.ts";
import { loadMap, writeMap } from "../map/store.ts";
import type { Loc, Provenance } from "../map/types.ts";

export const MAP_USAGE = `Usage:
  plumb map                 Build the repo map into ${MAP_DIR}/
  plumb map show <id>       Print a node with its edges and reverse edges
  plumb map query <expr>    dependents:<id> | writers:<resource> | entries:<component>

Options:
  --json        Machine-readable output on stdout
  --cwd <dir>   Project root (default: current directory)
`;

function json(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function where(evidence: readonly Loc[]): string {
  const first = evidence[0];
  if (first === undefined) return "";
  const more = evidence.length > 1 ? `, +${String(evidence.length - 1)} more` : "";
  return `${first.file}:${String(first.line)}${more}`;
}

function provenance(p: Provenance): string {
  return p.source === "extracted" ? p.extractor : `inferred, ${p.confidence} confidence`;
}

async function build(root: string, asJson: boolean, io: Io): Promise<ExitCode> {
  const { map, summaryIssues } = await buildMap({ root });
  const { changed, removed } = writeMap(root, renderMap(map));
  const failures = map.manifest.extractorFailures;
  const counts = {
    components: map.components.length,
    entryPoints: map.components.reduce((n, c) => n + c.entryPoints.length, 0),
    edges: map.components.reduce((n, c) => n + c.edges.length, 0),
    resources: map.resources.resources.length,
    unassignedFiles: map.manifest.unassignedFiles.length,
  };
  if (asJson) {
    json(io, { ...counts, changed, removed, extractorFailures: failures, summaryIssues });
  } else {
    io.stdout(
      `map: ${String(counts.components)} components, ${String(counts.entryPoints)} entry points, ${String(counts.edges)} edges, ` +
        `${String(counts.resources)} resources, ${String(counts.unassignedFiles)} unassigned files -> ${MAP_DIR} ` +
        `(${String(changed.length + removed.length)} files changed)\n`,
    );
    for (const f of failures) io.stderr(`  ✗ ${f.extractor}${f.component === null ? "" : ` (${f.component})`}: ${f.reason}\n`);
    for (const s of summaryIssues) io.stderr(`  ! summary ${s.component}: ${s.issues.join("; ")}\n`);
  }
  // The map is still written so the failure is on record, but a map missing facts is not a success.
  return failures.length > 0 ? ExitCode.CouldNotComplete : ExitCode.Ok;
}

function describeNode(node: MapNode): string {
  switch (node.type) {
    case "component": {
      const c = node.component;
      return [
        `${c.id} (${c.kind}) ${c.root}`,
        `  framework: ${c.framework.join(", ") || "none"}; language: ${c.language.join(", ") || "none"}`,
        `  files: ${String(Object.keys(c.files).length)}; exports: ${c.exports.join(", ") || "none"}`,
        `  summary: ${c.summaryStatus}; factsVersion: ${factsVersion(c)}`,
        ...(c.entryPoints.length > 0 ? ["  entry points:", ...c.entryPoints.map((e) => `    ${e.id}  ${where([e.location])}`)] : []),
        ...(c.state.length > 0 ? ["  shared state:", ...c.state.map((s) => `    ${s.kind} ${s.id}`)] : []),
      ].join("\n");
    }
    case "entry":
      return `${node.id} (${node.entry.kind}) in ${node.owners.join(", ")} at ${where([node.entry.location])}`;
    case "resource":
      return `${node.id} (${node.resource.kind}) defined at ${node.resource.definedAt === null ? "unknown (seen only in code)" : where([node.resource.definedAt])}`;
    case "state":
      return `${node.id} (${node.state.kind}) in ${node.owner} at ${where([node.state.location])}, mutated from ${String(node.state.mutatedFrom.length)} places`;
  }
}

function edgeLine(ref: EdgeRef, direction: "out" | "in"): string {
  const target = direction === "out" ? ref.edge.to : `${ref.from} -> ${ref.edge.to}`;
  return `    ${ref.edge.kind} ${target}  (${where(ref.edge.evidence)}) [${provenance(ref.edge.provenance)}]`;
}

function show(root: string, id: string | undefined, asJson: boolean, io: Io): ExitCode {
  if (id === undefined) throw new UsageError("map show needs a node id, e.g. component:api");
  const index = new MapIndex(loadMap(root));
  const node = index.node(id);
  if (node === undefined) throw new UsageError(`no node "${id}" in the map`);
  const outgoing = index.outgoing(id);
  const incoming = index.incoming(id);
  if (asJson) {
    json(io, { node, ...(node.type === "component" ? { factsVersion: factsVersion(node.component) } : {}), outgoing, incoming });
    return ExitCode.Ok;
  }
  io.stdout(`${describeNode(node)}\n`);
  if (outgoing.length > 0) io.stdout(`  edges out:\n${outgoing.map((r) => edgeLine(r, "out")).join("\n")}\n`);
  if (incoming.length > 0) io.stdout(`  edges in:\n${incoming.map((r) => edgeLine(r, "in")).join("\n")}\n`);
  return ExitCode.Ok;
}

function query(root: string, expr: string | undefined, asJson: boolean, io: Io): ExitCode {
  const match = expr === undefined ? null : /^(dependents|writers|entries):(.+)$/.exec(expr);
  if (match?.[1] === undefined || match[2] === undefined) throw new UsageError("map query needs dependents:<id>, writers:<resource>, or entries:<component>");
  const [, kind, id] = match;
  const index = new MapIndex(loadMap(root));
  if (index.node(id) === undefined) throw new UsageError(`no node "${id}" in the map`);
  const results = kind === "dependents" ? index.dependents(id) : kind === "writers" ? index.writers(id) : index.entries(id);
  if (asJson) json(io, results);
  else if (results.length > 0) io.stdout(`${results.join("\n")}\n`);
  return ExitCode.Ok;
}

export async function mapCommand(argv: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: "boolean" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    io.stdout(MAP_USAGE);
    return ExitCode.Ok;
  }
  const root = path.resolve(values.cwd ?? ".");
  const asJson = values.json === true;
  const [sub, arg, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  if (sub === undefined) {
    if (arg !== undefined) throw new UsageError(`unexpected argument "${arg}"`);
    return build(root, asJson, io);
  }
  if (sub === "show") return show(root, arg, asJson, io);
  if (sub === "query") return query(root, arg, asJson, io);
  throw new UsageError(`unknown map subcommand "${sub}"`);
}
