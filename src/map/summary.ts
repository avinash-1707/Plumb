import { readFileSync } from "node:fs";
import type { NodeId, SummaryStatus } from "./types.ts";

// The template is the single source of truth for the required sections.
const TEMPLATE = new URL("../../templates/component-summary.md", import.meta.url);

const COMMENT = /<!--[\s\S]*?-->/g;

function headings(markdown: string, level: 1 | 2): Array<{ title: string; index: number }> {
  const marker = level === 1 ? "# " : "## ";
  const lines = markdown.replace(COMMENT, "").split("\n");
  return lines.flatMap((line, index) => (line.startsWith(marker) ? [{ title: line.slice(marker.length).trim(), index }] : []));
}

let sections: string[] | undefined;

export function requiredSections(): string[] {
  sections ??= headings(readFileSync(TEMPLATE, "utf8"), 2).map((h) => h.title);
  return sections;
}

export interface SummaryCheck {
  status: SummaryStatus;
  /** Structural problems; a summary with any is treated as stale until rewritten. */
  issues: string[];
}

export function checkSummary(markdown: string | null, component: NodeId, factsVersion: string): SummaryCheck {
  if (markdown === null) return { status: "missing", issues: [] };
  const issues: string[] = [];
  const h1 = headings(markdown, 1);
  if (h1[0]?.title !== component) issues.push(`first H1 must be "# ${component}"`);

  const required = requiredSections();
  const found = headings(markdown, 2);
  if (found.map((h) => h.title).join("\n") !== required.join("\n")) {
    issues.push(`H2 sections must be exactly, in order: ${required.join(", ")}`);
  }

  const lines = markdown.replace(COMMENT, "").split("\n");
  const body = (i: number): string =>
    lines
      .slice((found[i]?.index ?? 0) + 1, found[i + 1]?.index ?? lines.length)
      .join("\n")
      .trim();
  found.forEach((h, i) => {
    if (body(i) === "") issues.push(`section "${h.title}" is empty`);
  });

  const versionIndex = found.findIndex((h) => h.title === "Facts version");
  const written = versionIndex === -1 ? undefined : body(versionIndex).split(/\s+/)[0];
  if (written !== undefined && written !== "" && !/^[0-9a-f]{64}$/.test(written)) issues.push(`"Facts version" must be a 64-character hex hash`);

  if (issues.length > 0) return { status: "stale", issues };
  return { status: written === factsVersion ? "fresh" : "stale", issues };
}
