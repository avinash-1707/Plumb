import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { checkConfig, type Config, loadConfig } from "../config.ts";
import { CouldNotCompleteError } from "../errors.ts";
import { dependencyCruiserVersion } from "../extractors/depcruise-imports.ts";
import { EXTRACTORS } from "../extractors/index.ts";
import { SourceCache } from "../extractors/source.ts";
import type { ComponentSeed, Extractor, ExtractorContext, Facts } from "../extractors/types.ts";
import { blobShas, headCommit, isGitRepo, listFiles } from "../git.ts";
import { matchesAny } from "../glob.ts";
import { assignFiles } from "./assign.ts";
import { componentFileName } from "./ids.ts";
import { type CacheMode, createFactCache } from "./cache.ts";
import { compareLocs, compareStrings, factsVersions, normalizeMap, provenanceKey, serializeJson } from "./serialize.ts";
import { checkSummary } from "./summary.ts";
import type { Component, Edge, EntryPoint, ExtractorFailure, NodeId, RepoMap, Resource, SharedState } from "./types.ts";
import ts from "typescript";
import { readVersion } from "../version.ts";

export const MAP_DIR = ".plumb/map";

// Plumb's own output never maps itself: .plumb/map would otherwise list its own files' hashes, and every refine of
// the generated verify skill would make the committed map stale.
const ALWAYS_IGNORED = [".plumb/**", ".claude/skills/verify-*/**"];

/** Files the map never covers: Plumb's own output and the config's ignore globs. Impact uses the same rule. */
export function isIgnored(file: string, config: Config): boolean {
  return matchesAny(file, [...ALWAYS_IGNORED, ...(config.ignore ?? [])]);
}

export interface BuildOptions {
  /** Project root (absolute or relative to the process cwd). */
  root: string;
  /** Overrides .plumb/config.json; used by tests and callers that already loaded it. */
  config?: Config;
  extractors?: readonly Extractor[];
  /**
   * "read-write" reuses facts for unchanged files (plumb map --update, impact); "write-only" recomputes
   * everything and refreshes the cache (plumb map); "off" touches no cache (tests' reference rebuilds).
   */
  cache?: CacheMode;
}

export interface BuildResult {
  map: RepoMap;
  summaryIssues: Array<{ component: NodeId; issues: string[] }>;
}

interface Collected {
  entryPoints: Array<{ component: NodeId; entry: EntryPoint }>;
  edges: Array<{ component: NodeId; edge: Edge }>;
  state: Array<{ component: NodeId; state: SharedState }>;
  exports: Map<NodeId, string[]>;
  resources: Resource[];
  failures: ExtractorFailure[];
}

function mergeEntries(entries: ReadonlyArray<{ entry: EntryPoint }>): EntryPoint[] {
  const byId = new Map<string, EntryPoint>();
  for (const { entry } of entries) {
    const existing = byId.get(entry.id);
    if (existing === undefined || compareLocs(entry.location, existing.location) < 0) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function mergeEdges(edges: ReadonlyArray<{ edge: Edge }>): Edge[] {
  const byKey = new Map<string, Edge>();
  for (const { edge } of edges) {
    const key = `${edge.kind}|${edge.to}|${provenanceKey(edge.provenance)}`;
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? { ...edge, evidence: [...edge.evidence] } : { ...existing, evidence: [...existing.evidence, ...edge.evidence] });
  }
  return [...byKey.values()];
}

function mergeResources(resources: readonly Resource[]): Resource[] {
  const byId = new Map<string, Resource>();
  for (const r of resources) {
    const existing = byId.get(r.id);
    // Config beats code: a resource defined in a schema or env file keeps that location.
    if (existing === undefined || (existing.definedAt === null && r.definedAt !== null)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

function readSummary(root: string, id: NodeId): string | null {
  const file = path.join(root, MAP_DIR, "components", `${componentFileName(id)}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export async function buildMap(options: BuildOptions): Promise<BuildResult> {
  const requested = path.resolve(options.root);
  if (!existsSync(requested)) throw new CouldNotCompleteError(`${requested} does not exist`);
  // Tools report real paths (macOS /var is /private/var); a symlinked root would make every resolved import
  // look like it points outside the project.
  const root = realpathSync(requested);
  if (!isGitRepo(root)) throw new CouldNotCompleteError(`${root} is not inside a git repository`);
  const head = headCommit(root);
  if (head === null) throw new CouldNotCompleteError("the repository has no commits yet; commit once, then run plumb map");
  const config = options.config === undefined ? loadConfig(root) : checkConfig(options.config, "config");

  const files = listFiles(root)
    .filter((f) => !isIgnored(f, config))
    .sort(compareStrings);

  const shas = blobShas(root, files);
  const toolchain = `plumb-${readVersion()}_ts-${ts.version}_dc-${dependencyCruiserVersion()}`;
  const cache = createFactCache(root, options.cache ?? "write-only", toolchain, (file) => {
    const sha = shas.get(file);
    if (sha === undefined) throw new Error(`internal: no blob hash for ${file}`);
    return sha;
  });

  let components: ComponentSeed[] = [];
  let byComponent = new Map<NodeId, string[]>();
  let ownerOf = new Map<string, ComponentSeed>();
  let unassigned = files;
  const collected: Collected = { entryPoints: [], edges: [], state: [], exports: new Map(), resources: [], failures: [] };

  const ctx: ExtractorContext = {
    root,
    config,
    files,
    get components() {
      return components;
    },
    filesOf: (id) => byComponent.get(id) ?? [],
    componentOf: (file) => ownerOf.get(file),
    entryPoints: collected.entryPoints,
    resources: collected.resources,
    sources: new SourceCache(root),
    cache,
    sha: (file) => shas.get(file) ?? "",
  };

  const extractors = options.extractors ?? EXTRACTORS;
  for (const extractor of extractors) {
    let facts: Facts;
    try {
      facts = await extractor.run(ctx);
    } catch (err) {
      // Recorded, never silent: the manifest names the extractor and the command exits non-zero.
      // The manifest is committed: keep absolute paths out of it so it is identical on every machine.
      const message = (err instanceof Error ? err.message : String(err)).replaceAll(root, ".");
      collected.failures.push({ extractor: extractor.id, component: null, reason: `crashed: ${message}`, fallback: "none" });
      continue;
    }
    if (facts.components !== undefined) {
      components = facts.components;
      const assignment = assignFiles(files, components);
      byComponent = assignment.byComponent;
      unassigned = assignment.unassigned;
      ownerOf = new Map(components.flatMap((c) => (byComponent.get(c.id) ?? []).map((f) => [f, c] as const)));
    }
    collected.entryPoints.push(...(facts.entryPoints ?? []));
    collected.edges.push(...(facts.edges ?? []));
    collected.state.push(...(facts.state ?? []));
    collected.resources.push(...(facts.resources ?? []));
    collected.failures.push(...(facts.failures ?? []));
    for (const e of facts.exports ?? []) collected.exports.set(e.component, [...(collected.exports.get(e.component) ?? []), ...e.names]);
  }

  cache.save();
  const resources = mergeResources(collected.resources);
  const assembled: Component[] = components.map((seed) => ({
      id: seed.id,
      kind: seed.kind,
      root: seed.root,
      include: seed.include,
      language: seed.language,
      framework: seed.framework,
      files: Object.fromEntries((byComponent.get(seed.id) ?? []).map((f) => [f, shas.get(f) ?? ""])),
      entryPoints: mergeEntries(collected.entryPoints.filter((e) => e.component === seed.id)),
      exports: collected.exports.get(seed.id) ?? [],
      edges: mergeEdges(collected.edges.filter((e) => e.component === seed.id)),
      state: [...new Map(collected.state.filter((s) => s.component === seed.id).map((s) => [s.state.id, s.state])).values()],
      summaryStatus: "missing" as const,
  }));
  const versions = factsVersions(assembled);
  const summaryIssues: BuildResult["summaryIssues"] = [];
  const built: Component[] = assembled.map((component) => {
    const check = checkSummary(readSummary(root, component.id), component.id, versions.get(component.id) ?? "");
    if (check.issues.length > 0) summaryIssues.push({ component: component.id, issues: check.issues });
    return { ...component, summaryStatus: check.status };
  });

  // Every edge must land on a node in this map; anything else is an extractor bug, not a user problem.
  const nodes = new Set<string>([...built.map((c) => c.id), ...built.flatMap((c) => c.entryPoints.map((e) => e.id)), ...resources.map((r) => r.id)]);
  for (const c of built) {
    for (const e of c.edges) {
      if (!nodes.has(e.to)) throw new Error(`internal: ${c.id} has a ${e.kind} edge to unknown node ${e.to}`);
    }
  }

  const map = normalizeMap({
    manifest: {
      schemaVersion: 1,
      builtAtCommit: head,
      extractors: Object.fromEntries(extractors.map((e) => [e.id, e.version])),
      components: built.map((c) => c.id),
      unassignedFiles: unassigned,
      extractorFailures: collected.failures,
    },
    components: built,
    resources: { resources },
  });
  return { map, summaryIssues };
}

/** File contents of a map, keyed by path relative to .plumb/map. */
export function renderMap(map: RepoMap): Map<string, string> {
  const files = new Map<string, string>();
  files.set("manifest.json", serializeJson(map.manifest));
  files.set("resources.json", serializeJson(map.resources));
  for (const c of map.components) files.set(`components/${componentFileName(c.id)}.json`, serializeJson(c));
  return files;
}
