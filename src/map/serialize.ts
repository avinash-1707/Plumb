import { createHash } from "node:crypto";
import type { Component, Edge, ExtractorFailure, Loc, Provenance, RepoMap } from "./types.ts";

// Same tree in, byte-identical map out: sorted keys, sorted arrays, no timestamps.

/** Code-unit order, independent of locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareLocs(a: Loc, b: Loc): number {
  return compareStrings(a.file, b.file) || a.line - b.line;
}

export function provenanceKey(p: Provenance): string {
  return p.source === "extracted" ? `extracted:${p.extractor}` : `inferred:${p.confidence}`;
}

function compareEdges(a: Edge, b: Edge): number {
  return compareStrings(a.kind, b.kind) || compareStrings(a.to, b.to) || compareStrings(provenanceKey(a.provenance), provenanceKey(b.provenance));
}

function compareFailures(a: ExtractorFailure, b: ExtractorFailure): number {
  return (
    compareStrings(a.extractor, b.extractor) ||
    compareStrings(a.component ?? "", b.component ?? "") ||
    compareStrings(a.reason, b.reason)
  );
}

export function uniqueSortedLocs(locs: readonly Loc[]): Loc[] {
  const seen = new Set<string>();
  const out: Loc[] = [];
  for (const loc of [...locs].sort(compareLocs)) {
    const key = `${loc.file}:${String(loc.line)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(loc);
    }
  }
  return out;
}

function sortStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function normalizeComponent(c: Component): Component {
  return {
    ...c,
    include: sortStrings(c.include),
    language: sortStrings(c.language),
    framework: sortStrings(c.framework),
    files: Object.fromEntries(Object.entries(c.files).sort(([a], [b]) => compareStrings(a, b))),
    entryPoints: [...c.entryPoints].sort((a, b) => compareStrings(a.id, b.id)),
    exports: sortStrings(c.exports),
    edges: c.edges.map((e) => ({ ...e, evidence: uniqueSortedLocs(e.evidence) })).sort(compareEdges),
    state: c.state
      .map((s) => ({ ...s, mutatedFrom: uniqueSortedLocs(s.mutatedFrom) }))
      .sort((a, b) => compareStrings(a.id, b.id)),
  };
}

export function normalizeMap(map: RepoMap): RepoMap {
  return {
    manifest: {
      ...map.manifest,
      components: sortStrings(map.manifest.components),
      unassignedFiles: sortStrings(map.manifest.unassignedFiles),
      extractorFailures: [...map.manifest.extractorFailures].sort(compareFailures),
    },
    components: map.components.map(normalizeComponent).sort((a, b) => compareStrings(a.id, b.id)),
    resources: { resources: [...map.resources.resources].sort((a, b) => compareStrings(a.id, b.id)) },
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

/** Canonical JSON text for a map file. Arrays must already be normalized. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/**
 * Hash of the facts a summary describes: the component's public shape. File hashes, evidence lines, and
 * locations are left out so internal-only edits don't stale a summary (doc 3, incremental update step 4);
 * summaryStatus is left out because it depends on this hash.
 */
export function factsVersion(component: Component): string {
  const c = normalizeComponent(component);
  const publicFacts = {
    id: c.id,
    kind: c.kind,
    framework: c.framework,
    exports: c.exports,
    entryPoints: c.entryPoints.map((e) => ({ id: e.id, kind: e.kind })),
    edges: [...new Map(c.edges.map((e) => [`${e.kind}|${e.to}`, { kind: e.kind, to: e.to }])).values()],
    state: c.state.map((s) => ({ id: s.id, kind: s.kind })),
  };
  return createHash("sha256").update(serializeJson(publicFacts)).digest("hex");
}
