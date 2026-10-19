import path from "node:path";
import { parseArgs } from "node:util";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { ExitCode } from "../exit-codes.ts";
import type { Io } from "../io.ts";
import { buildMap, MAP_DIR, renderMap } from "../map/build.ts";
import { componentFileName } from "../map/ids.ts";
import { MapIndex, type EdgeRef, type MapNode } from "../map/query.ts";
import { staleMapFiles } from "../map/freshness.ts";
import { factsVersions } from "../map/serialize.ts";
import { loadMap, writeMap, writeOne } from "../map/store.ts";
import type { Loc, Provenance, RepoMap } from "../map/types.ts";

export const MAP_USAGE = `Usage:
  plumb map                    Build the repo map into ${MAP_DIR}/ from scratch
  plumb map --update           Update it, re-extracting only files that changed
  plumb map --check            Exit 1 if the committed map is stale for the current tree
  plumb map rebuild <id>       Rewrite one component's file (after a merge conflict)
  plumb map show <id>          Print a node with its edges and reverse edges
  plumb map query <expr>       dependents:<id> | writers:<resource> | entries:<component>

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

/** File path -> blob hash across a map's components (unassigned files carry no hash in the map). */
function fileHashes(map: RepoMap): Map<string, string> {
  return new Map(map.components.flatMap((c) => Object.entries(c.files)));
}

function reportFailures(map: RepoMap, io: Io): boolean {
  for (const f of map.manifest.extractorFailures) io.stderr(`  ✗ ${f.extractor}${f.component === null ? "" : ` (${f.component})`}: ${f.reason}\n`);
  return map.manifest.extractorFailures.length > 0;
}

function previousMap(root: string): RepoMap | null {
  try {
    return loadMap(root);
  } catch (err) {
    // No map yet, or one mangled by a merge: the update simply has nothing to compare against.
    if (err instanceof CouldNotCompleteError || err instanceof SyntaxError) return null;
    throw err;
  }
}

async function build(root: string, update: boolean, asJson: boolean, io: Io): Promise<ExitCode> {
  const before = update ? previousMap(root) : null;
  const { map, summaryIssues } = await buildMap({ root, cache: update ? "read-write" : "write-only" });
  const { changed, removed } = writeMap(root, renderMap(map));

  const oldFiles = before === null ? new Map<string, string>() : fileHashes(before);
  const newFiles = fileHashes(map);
  const changedFiles = before === null ? [] : [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter((f) => oldFiles.get(f) !== newFiles.get(f)).sort();
  const wasFresh = new Set(before?.components.filter((c) => c.summaryStatus === "fresh").map((c) => c.id) ?? []);
  const newlyStale = map.components.filter((c) => c.summaryStatus === "stale" && wasFresh.has(c.id)).map((c) => c.id);
  const failures = map.manifest.extractorFailures;
  const counts = {
    components: map.components.length,
    entryPoints: map.components.reduce((n, c) => n + c.entryPoints.length, 0),
    edges: map.components.reduce((n, c) => n + c.edges.length, 0),
    resources: map.resources.resources.length,
    unassignedFiles: map.manifest.unassignedFiles.length,
  };
  if (asJson) {
    json(io, { ...counts, changed, removed, ...(update ? { changedFiles, newlyStaleSummaries: newlyStale } : {}), extractorFailures: failures, summaryIssues });
  } else {
    io.stdout(
      `map: ${String(counts.components)} components, ${String(counts.entryPoints)} entry points, ${String(counts.edges)} edges, ` +
        `${String(counts.resources)} resources, ${String(counts.unassignedFiles)} unassigned files -> ${MAP_DIR} ` +
        `(${String(changed.length + removed.length)} files changed)\n`,
    );
    if (update && before !== null) io.stdout(`  ${String(changedFiles.length)} component files added, removed, or changed since the last map\n`);
    if (newlyStale.length > 0) io.stdout(`  summaries now stale: ${newlyStale.join(", ")}\n`);
    reportFailures(map, io);
    for (const s of summaryIssues) io.stderr(`  ! summary ${s.component}: ${s.issues.join("; ")}\n`);
  }
  // The map is still written so the failure is on record, but a map missing facts is not a success.
  return failures.length > 0 ? ExitCode.CouldNotComplete : ExitCode.Ok;
}

/** builtAtCommit names the commit the map was built at, so a committed map can never contain its own commit. */
async function check(root: string, asJson: boolean, io: Io): Promise<ExitCode> {
  const { map } = await buildMap({ root, cache: "read-write" });
  // A map missing facts can't say whether the committed one is stale: that's a blocker, not a verdict.
  if (reportFailures(map, io)) {
    io.stderr("plumb map: can't check freshness while extractors fail\n");
    return ExitCode.CouldNotComplete;
  }
  const stale = staleMapFiles(root, map);
  if (asJson) json(io, { upToDate: stale.length === 0, stale });
  else if (stale.length === 0) io.stdout(`map is up to date\n`);
  else io.stdout(`map is stale; run plumb map --update and commit ${MAP_DIR}\n${stale.map((rel) => `  ${MAP_DIR}/${rel}`).join("\n")}\n`);
  return stale.length === 0 ? ExitCode.Ok : ExitCode.CheckFailed;
}

async function rebuild(root: string, id: string | undefined, asJson: boolean, io: Io): Promise<ExitCode> {
  if (id === undefined) throw new UsageError("map rebuild needs a component id, e.g. component:api");
  const { map } = await buildMap({ root, cache: "write-only" });
  if (!map.components.some((c) => c.id === id)) throw new UsageError(`no component "${id}" in the rebuilt map`);
  // Only this component's file plus the two shared files: other components' files are left as they are.
  const rendered = renderMap(map);
  const keep = new Set(["manifest.json", "resources.json", `components/${componentFileName(id)}.json`]);
  const files = new Map([...rendered].filter(([rel]) => keep.has(rel)));
  const changed: string[] = [];
  for (const [rel, content] of files) if (writeOne(root, rel, content)) changed.push(rel);
  if (asJson) json(io, { component: id, changed, extractorFailures: map.manifest.extractorFailures });
  else io.stdout(`rebuilt ${id} (${String(changed.length)} files changed)\n`);
  return reportFailures(map, io) ? ExitCode.CouldNotComplete : ExitCode.Ok;
}

function describeNode(node: MapNode, versions: ReadonlyMap<string, string>): string {
  switch (node.type) {
    case "component": {
      const c = node.component;
      return [
        `${c.id} (${c.kind}) ${c.root}`,
        `  framework: ${c.framework.join(", ") || "none"}; language: ${c.language.join(", ") || "none"}`,
        `  files: ${String(Object.keys(c.files).length)}; exports: ${c.exports.join(", ") || "none"}`,
        `  summary: ${c.summaryStatus}; factsVersion: ${versions.get(c.id) ?? ""}`,
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
  const versions = factsVersions(index.map.components);
  if (asJson) {
    json(io, { node, ...(node.type === "component" ? { factsVersion: versions.get(node.id) } : {}), outgoing, incoming });
    return ExitCode.Ok;
  }
  io.stdout(`${describeNode(node, versions)}\n`);
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
    options: {
      json: { type: "boolean" },
      cwd: { type: "string" },
      update: { type: "boolean" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
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
  if (values.update === true && values.check === true) throw new UsageError("use either --update or --check");
  if ((values.update === true || values.check === true) && sub !== undefined) throw new UsageError(`--update and --check don't combine with "${sub}"`);
  if (sub === undefined) {
    if (arg !== undefined) throw new UsageError(`unexpected argument "${arg}"`);
    if (values.check === true) return check(root, asJson, io);
    return build(root, values.update === true, asJson, io);
  }
  if (sub === "show") return show(root, arg, asJson, io);
  if (sub === "query") return query(root, arg, asJson, io);
  if (sub === "rebuild") return rebuild(root, arg, asJson, io);
  throw new UsageError(`unknown map subcommand "${sub}"`);
}
