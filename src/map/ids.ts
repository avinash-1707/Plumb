import type { NodeId } from "./types.ts";

// Ids are derived from names and paths only, never random, so diffs and references survive rebuilds.

export function componentId(name: string): NodeId {
  return `component:${name}`;
}

/** File-safe name for a component's files under .plumb/map/components/. */
export function componentFileName(id: NodeId): string {
  return id.replace(/^component:/, "").replaceAll("/", "__");
}

export function httpEntryId(method: string, path: string): NodeId {
  return `entry:http:${method.toUpperCase()} ${path}`;
}

export function uiEntryId(route: string): NodeId {
  return `entry:ui:${route}`;
}

export function dbTableId(table: string): NodeId {
  return `resource:db.${table}`;
}

export function envVarId(name: string): NodeId {
  return `resource:env.${name}`;
}

export function serviceId(name: string): NodeId {
  return `resource:service.${name}`;
}

export function stateId(file: string, name: string): NodeId {
  return `state:${file}#${name}`;
}

/** Splits "entry:http:POST /api/orders" into its method and path; null for any other id. */
export function parseHttpEntryId(id: NodeId): { method: string; path: string } | null {
  const match = /^entry:http:([A-Z]+) (\/.*)$/.exec(id);
  return match?.[1] !== undefined && match[2] !== undefined ? { method: match[1], path: match[2] } : null;
}
