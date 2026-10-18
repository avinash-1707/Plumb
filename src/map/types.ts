// Mirrors schemas/map/*.json; the schemas are the contract, these types are how the code holds it.

/** Stable, path-derived id: component:api, entry:http:POST /api/orders, resource:db.Order, state:<file>#<name>. */
export type NodeId = string;

export interface Loc {
  file: string;
  line: number;
}

export type Provenance =
  | { source: "extracted"; extractor: string }
  | { source: "inferred"; confidence: "high" | "low" };

export type ComponentKind = "app" | "service" | "package" | "library" | "worker";

export type EntryKind = "http" | "cli" | "job" | "event" | "ui-route" | "main";

export interface EntryPoint {
  id: NodeId;
  kind: EntryKind;
  location: Loc;
  provenance: Provenance;
}

export type EdgeKind =
  | "imports"
  | "calls-http"
  | "publishes"
  | "consumes"
  | "reads"
  | "writes"
  | "uses-env"
  | "calls-external"
  | "spawns";

export interface Edge {
  kind: EdgeKind;
  to: NodeId;
  evidence: Loc[];
  provenance: Provenance;
}

export type SharedStateKind = "module-singleton" | "global-mutable" | "cache" | "connection-pool" | "timer" | "listener";

export interface SharedState {
  id: NodeId;
  kind: SharedStateKind;
  location: Loc;
  mutatedFrom: Loc[];
  provenance: Provenance;
}

export type SummaryStatus = "fresh" | "stale" | "missing";

export interface Component {
  id: NodeId;
  kind: ComponentKind;
  root: string;
  include: string[];
  language: string[];
  framework: string[];
  files: Record<string, string>;
  entryPoints: EntryPoint[];
  exports: string[];
  edges: Edge[];
  state: SharedState[];
  summaryStatus: SummaryStatus;
}

export type ResourceKind = "db-table" | "queue" | "cache" | "file-store" | "external-api" | "env-var" | "service";

export interface Resource {
  id: NodeId;
  kind: ResourceKind;
  definedAt: Loc | null;
  provenance: Provenance;
}

export interface Resources {
  resources: Resource[];
}

export interface ExtractorFailure {
  extractor: string;
  component: NodeId | null;
  reason: string;
  fallback: "tree-sitter" | "none";
}

export interface Manifest {
  schemaVersion: 1;
  builtAtCommit: string;
  extractors: Record<string, string>;
  components: NodeId[];
  unassignedFiles: string[];
  extractorFailures: ExtractorFailure[];
}

/** A whole map as held in memory. */
export interface RepoMap {
  manifest: Manifest;
  components: Component[];
  resources: Resources;
}
