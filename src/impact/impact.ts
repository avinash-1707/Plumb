import type { FeatureIndex } from "../features.ts";
import { matchesAny } from "../glob.ts";
import { assignFiles } from "../map/assign.ts";
import { compareStrings } from "../map/serialize.ts";
import type { NodeId, RepoMap } from "../map/types.ts";

export interface ImpactedComponent {
  id: NodeId;
  /** Why it is in the set, e.g. "changed", "imports component:db", "writes resource:db.Order". */
  reasons: string[];
}

export interface Impact {
  changedFiles: string[];
  unassignedChangedFiles: string[];
  changedComponents: NodeId[];
  components: ImpactedComponent[];
  /** Resources the diff reads, writes, or redefines. */
  touchedResources: NodeId[];
  /** Features whose paths match a changed file; null when .plumb/features.json doesn't exist yet. */
  features: Array<{ id: string; tier: "fast-only" | "deep" }> | null;
}

/**
 * The impact set (doc 3):
 *   changed components
 *   + reverse dependencies at depth 1 over imports
 *   + transitive reverse dependencies over contract edges (calls-http, publishes/consumes)
 *   + every component writing a resource the diff reads, writes, or redefines
 * Computed on the current map, so a fact the diff deleted no longer pulls anything in.
 */
export function computeImpact(map: RepoMap, changedFiles: readonly string[], features: FeatureIndex | null): Impact {
  const changed = new Set(changedFiles);
  const { byComponent, unassigned } = assignFiles(changedFiles, map.components);
  const changedComponents = [...byComponent].filter(([, files]) => files.length > 0).map(([id]) => id);

  const reasons = new Map<NodeId, Set<string>>();
  const add = (id: NodeId, reason: string): void => {
    reasons.set(id, (reasons.get(id) ?? new Set()).add(reason));
  };
  for (const id of changedComponents) add(id, "changed");

  // Depth 1 over imports.
  for (const c of map.components) {
    for (const e of c.edges) if (e.kind === "imports" && changedComponents.includes(e.to) && e.to !== c.id) add(c.id, `imports ${e.to}`);
  }

  // Transitive over contracts: a caller depends on the owner of the route it calls; a consumer on a queue's publishers.
  const ownersOf = new Map<NodeId, NodeId[]>();
  for (const c of map.components) for (const e of c.entryPoints) ownersOf.set(e.id, [...(ownersOf.get(e.id) ?? []), c.id]);
  const publishersOf = new Map<NodeId, NodeId[]>();
  for (const c of map.components) for (const e of c.edges) if (e.kind === "publishes") publishersOf.set(e.to, [...(publishersOf.get(e.to) ?? []), c.id]);
  const reached = new Set(changedComponents);
  const queue = [...changedComponents];
  for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
    for (const c of map.components) {
      if (c.id === target) continue;
      for (const e of c.edges) {
        const viaRoute = e.kind === "calls-http" && (ownersOf.get(e.to) ?? []).includes(target);
        const viaQueue = e.kind === "consumes" && (publishersOf.get(e.to) ?? []).includes(target);
        if (!viaRoute && !viaQueue) continue;
        add(c.id, viaRoute ? `calls ${target} (${e.to})` : `consumes ${e.to} published by ${target}`);
        if (!reached.has(c.id)) {
          reached.add(c.id);
          queue.push(c.id);
        }
      }
    }
  }

  // Resources the diff touches, at file granularity.
  const touched = new Set<NodeId>();
  for (const c of map.components) {
    for (const e of c.edges) {
      if ((e.kind === "reads" || e.kind === "writes") && e.evidence.some((l) => changed.has(l.file))) touched.add(e.to);
    }
  }
  for (const r of map.resources.resources) if (r.definedAt !== null && changed.has(r.definedAt.file)) touched.add(r.id);
  for (const c of map.components) {
    for (const e of c.edges) if (e.kind === "writes" && touched.has(e.to)) add(c.id, `writes ${e.to}`);
  }

  return {
    changedFiles: [...changedFiles].sort(compareStrings),
    unassignedChangedFiles: unassigned.sort(compareStrings),
    changedComponents: changedComponents.sort(compareStrings),
    components: [...reasons]
      .map(([id, rs]) => ({ id, reasons: [...rs].sort(compareStrings) }))
      .sort((a, b) => compareStrings(a.id, b.id)),
    touchedResources: [...touched].sort(compareStrings),
    features:
      features === null
        ? null
        : features.features
            .filter((f) => changedFiles.some((file) => matchesAny(file, f.paths)))
            .map((f) => ({ id: f.id, tier: f.tier }))
            .sort((a, b) => compareStrings(a.id, b.id)),
  };
}
