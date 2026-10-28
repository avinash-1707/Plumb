import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { CouldNotCompleteError } from "../errors.ts";
import { loadFeatures } from "../features.ts";
import { MAP_DIR } from "../map/build.ts";
import { componentFileName } from "../map/ids.ts";
import { loadMap } from "../map/store.ts";
import { summarySection } from "../map/summary.ts";
import type { RepoMap } from "../map/types.ts";
import { featureFreshness } from "../verify/sync.ts";

// About 1.5k tokens: the same cost at session start whatever the repo's size; details are one command away.
export const DIGEST_MAX_CHARS = 6000;

const HEADER = `This repo has a Plumb map (${MAP_DIR}/): deterministic, every fact carries file:line evidence. Use it before editing:
- \`plumb impact --staged\` (or \`plumb impact <base>\`): the components and features a change affects
- \`plumb map show <component>\`: a component's entry points, edges, and who depends on it
- \`plumb map query dependents:<component>\` | \`writers:<resource>\` | \`entries:<component>\`
- \`plumb verify --plan --staged\`: the features to drive live before committing`;

const bare = (id: string): string => id.replace(/^component:/, "");

/** One line per component: kind, root, entry points, what it depends on and what depends on it, and its purpose. */
function componentLines(root: string, map: RepoMap): string[] {
  const dependents = new Map<string, string[]>();
  for (const c of map.components) {
    for (const e of c.edges) if (e.to.startsWith("component:") && e.to !== c.id) dependents.set(e.to, [...(dependents.get(e.to) ?? []), bare(c.id)]);
  }
  return map.components.map((c) => {
    const uses = [...new Set(c.edges.filter((e) => e.to.startsWith("component:") && e.to !== c.id).map((e) => bare(e.to)))].sort();
    const usedBy = [...new Set(dependents.get(c.id) ?? [])].sort();
    const parts = [`${c.kind}, ${c.root}`, `${String(c.entryPoints.length)} entry points`];
    if (uses.length > 0) parts.push(`uses ${uses.join(", ")}`);
    if (usedBy.length > 0) parts.push(`used by ${usedBy.join(", ")}`);
    // Only a fresh summary is trusted to describe the component as it is now.
    const summaryFile = path.join(root, MAP_DIR, "components", `${componentFileName(c.id)}.md`);
    const purpose = c.summaryStatus === "fresh" && existsSync(summaryFile) ? (summarySection(readFileSync(summaryFile, "utf8"), "Purpose") ?? "").split("\n")[0]?.trim() : "";
    return `- ${bare(c.id)} (${parts.join("; ")})${purpose === undefined || purpose === "" ? "" : `: ${purpose}`}`;
  });
}

function featureLine(root: string): string | null {
  let index;
  try {
    index = loadFeatures(root);
  } catch (err) {
    if (!(err instanceof CouldNotCompleteError)) throw err;
    return `Features: ${err.message} (plumb doctor)`;
  }
  if (index === null) return null;
  const freshness = featureFreshness(root, index);
  const stale = freshness.filter((f) => f.state === "stale").map((f) => f.id);
  const shown = stale.slice(0, 10).join(", ") + (stale.length > 10 ? `, +${String(stale.length - 10)} more (plumb verify --stale)` : "");
  return `Features: ${String(freshness.length)} mapped in .plumb/features.json${stale.length > 0 ? `; code changed since last confirmed live: ${shown} (/plumb-refine)` : ""}`;
}

/** The SessionStart context for a repo with a Plumb map; null when there is no map or the digest is turned off. */
export function sessionDigest(root: string): string | null {
  if (!existsSync(path.join(root, MAP_DIR, "manifest.json"))) return null;
  if (loadConfig(root).sessionDigest === false) return null;
  const map = loadMap(root);
  const tail = [featureLine(root)].filter((l): l is string => l !== null);
  const lines = [HEADER, "", `Components (${String(map.components.length)}):`];
  const reserve = tail.join("\n").length + 120;
  const components = componentLines(root, map);
  let used = lines.join("\n").length;
  let shown = 0;
  for (const line of components) {
    if (used + line.length + 1 > DIGEST_MAX_CHARS - reserve) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < components.length) lines.push(`- ... ${String(components.length - shown)} more: plumb map show <component>`);
  return [...lines, ...(tail.length > 0 ? ["", ...tail] : [])].join("\n");
}
