import { compareStrings } from "./serialize.ts";
import type { Component, Edge, EntryPoint, NodeId, RepoMap, Resource, SharedState } from "./types.ts";

export type MapNode =
  | { type: "component"; id: NodeId; component: Component }
  /** The same route id can be served by several components (two services each with GET /health). */
  | { type: "entry"; id: NodeId; owners: NodeId[]; entry: EntryPoint }
  | { type: "resource"; id: NodeId; resource: Resource }
  | { type: "state"; id: NodeId; owner: NodeId; state: SharedState };

export interface EdgeRef {
  from: NodeId;
  edge: Edge;
}

/** In-memory index over a loaded map: nodes by id, outgoing and reverse edges. */
export class MapIndex {
  readonly #nodes = new Map<NodeId, MapNode>();
  readonly #incoming = new Map<NodeId, EdgeRef[]>();
  readonly #map: RepoMap;

  constructor(map: RepoMap) {
    this.#map = map;
    for (const component of map.components) {
      this.#nodes.set(component.id, { type: "component", id: component.id, component });
      for (const entry of component.entryPoints) {
        const existing = this.#nodes.get(entry.id);
        if (existing?.type === "entry") existing.owners.push(component.id);
        else this.#nodes.set(entry.id, { type: "entry", id: entry.id, owners: [component.id], entry });
      }
      for (const state of component.state) this.#nodes.set(state.id, { type: "state", id: state.id, owner: component.id, state });
      for (const edge of component.edges) this.#incoming.set(edge.to, [...(this.#incoming.get(edge.to) ?? []), { from: component.id, edge }]);
    }
    for (const resource of map.resources.resources) this.#nodes.set(resource.id, { type: "resource", id: resource.id, resource });
  }

  node(id: NodeId): MapNode | undefined {
    return this.#nodes.get(id);
  }

  outgoing(id: NodeId): EdgeRef[] {
    const node = this.#nodes.get(id);
    return node?.type === "component" ? node.component.edges.map((edge) => ({ from: id, edge })) : [];
  }

  /** Edges pointing at the node; for a component, also edges pointing at its entry points. */
  incoming(id: NodeId): EdgeRef[] {
    const node = this.#nodes.get(id);
    const targets = node?.type === "component" ? [id, ...node.component.entryPoints.map((e) => e.id)] : [id];
    return targets.flatMap((t) => this.#incoming.get(t) ?? []);
  }

  /** Components with any edge into the node (or its entry points), excluding the node itself. */
  dependents(id: NodeId): NodeId[] {
    return [...new Set(this.incoming(id).map((r) => r.from))].filter((from) => from !== id).sort(compareStrings);
  }

  writers(resource: NodeId): NodeId[] {
    return [...new Set((this.#incoming.get(resource) ?? []).filter((r) => r.edge.kind === "writes").map((r) => r.from))].sort(compareStrings);
  }

  entries(component: NodeId): NodeId[] {
    const node = this.#nodes.get(component);
    return node?.type === "component" ? node.component.entryPoints.map((e) => e.id) : [];
  }

  get map(): RepoMap {
    return this.#map;
  }
}
