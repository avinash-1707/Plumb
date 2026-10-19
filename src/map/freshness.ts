import { renderMap } from "./build.ts";
import { readMapFiles } from "./store.ts";
import type { RepoMap } from "./types.ts";

// A committed map can never contain its own commit, so freshness ignores builtAtCommit (D42).
function withoutHead(manifest: string): string {
  return manifest.replace(/"builtAtCommit": "[0-9a-f]+"/, '"builtAtCommit": ""');
}

/** Map files (relative to the map dir) whose committed content differs from a fresh build. */
export function staleMapFiles(root: string, map: RepoMap): string[] {
  const expected = renderMap(map);
  const actual = readMapFiles(root);
  const normalize = (rel: string, content: string | undefined): string | undefined => (rel === "manifest.json" && content !== undefined ? withoutHead(content) : content);
  return [...new Set([...expected.keys(), ...actual.keys()])].filter((rel) => normalize(rel, expected.get(rel)) !== normalize(rel, actual.get(rel))).sort();
}
