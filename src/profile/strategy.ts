import type { Config } from "../config.ts";
import { readPackageJson } from "../extractors/workspace.ts";
import { parseHttpEntryId } from "../map/ids.ts";
import type { RepoMap } from "../map/types.ts";
import type { Profile, Strategy } from "./types.ts";

function scriptsOf(root: string, dir: string): string[] {
  const pkg = readPackageJson(root, dir) as { scripts?: Record<string, string> } | null;
  return Object.keys(pkg?.scripts ?? {});
}

/** Doc 4's deterministic table; config.strategy overrides it. */
export function selectStrategy(root: string, profile: Pick<Profile, "ui">, map: RepoMap, config: Config): { strategy: Strategy; reason: string } {
  if (config.strategy !== undefined) return { strategy: config.strategy, reason: "set in .plumb/config.json" };
  const independent = map.components.filter((c) => c.root !== "." && scriptsOf(root, c.root).some((s) => s === "build" || s === "test"));
  if (independent.length >= 2) {
    return { strategy: "monorepo", reason: `${String(independent.length)} components build or test on their own (${independent.map((c) => c.id).join(", ")})` };
  }
  if (profile.ui.present) return { strategy: "web-app", reason: "ui.present is true" };
  const http = map.components.flatMap((c) => c.entryPoints).filter((e) => parseHttpEntryId(e.id) !== null);
  if (http.length > 0) return { strategy: "api-backend", reason: `${String(http.length)} HTTP entry points and no UI` };
  return { strategy: "library-cli", reason: "no UI and no HTTP entry points" };
}
