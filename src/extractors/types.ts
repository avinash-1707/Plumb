import type { Config } from "../config.ts";
import type { ComponentKind, Edge, EntryPoint, ExtractorFailure, NodeId, Resource, SharedState } from "../map/types.ts";
import type { SourceCache } from "./source.ts";

export interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  bin?: unknown;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** A component as detected by the workspace extractor, before other extractors add facts. */
export interface ComponentSeed {
  id: NodeId;
  kind: ComponentKind;
  root: string;
  include: string[];
  language: string[];
  framework: string[];
  packageJson: PackageJson | null;
}

export interface ExtractorContext {
  /** Absolute project root. */
  root: string;
  config: Config;
  /** Every project file after ignore globs, relative to root. */
  files: readonly string[];
  /** Empty while the workspace extractor runs. */
  components: readonly ComponentSeed[];
  filesOf(component: NodeId): readonly string[];
  componentOf(file: string): ComponentSeed | undefined;
  /** Facts from extractors that ran earlier in the pipeline. */
  entryPoints: ReadonlyArray<{ component: NodeId; entry: EntryPoint }>;
  resources: readonly Resource[];
  sources: SourceCache;
}

export interface Facts {
  components?: ComponentSeed[];
  entryPoints?: Array<{ component: NodeId; entry: EntryPoint }>;
  edges?: Array<{ component: NodeId; edge: Edge }>;
  state?: Array<{ component: NodeId; state: SharedState }>;
  exports?: Array<{ component: NodeId; names: string[] }>;
  resources?: Resource[];
  failures?: ExtractorFailure[];
}

export interface Extractor {
  id: string;
  /** Bumping it forces re-extraction of the facts this extractor owns. */
  version: string;
  run(ctx: ExtractorContext): Facts | Promise<Facts>;
}

export function extracted(extractor: string): { source: "extracted"; extractor: string } {
  return { source: "extracted", extractor };
}

export function failure(extractor: string, component: NodeId | null, reason: string): ExtractorFailure {
  return { extractor, component, reason, fallback: "none" };
}
