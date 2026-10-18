import { describe, expect, it } from "vitest";
import { checkSummary, requiredSections } from "../src/map/summary.ts";

const VERSION = "a".repeat(64);

function summary({ id = "component:api", version = VERSION, risks = "Shared cache in cache.ts." } = {}): string {
  return [
    `# ${id}`,
    "",
    "## Purpose",
    "Serves the shop API.",
    "## Public surface",
    "HTTP routes under /api.",
    "## Invariants",
    "Stock never goes negative.",
    "## Risks",
    risks,
    "## Facts version",
    version,
  ].join("\n");
}

describe("component summary contract", () => {
  it("takes its required sections from the template", () => {
    expect(requiredSections()).toEqual(["Purpose", "Public surface", "Invariants", "Risks", "Facts version"]);
  });

  it("is missing without a file, fresh when the facts version matches, stale when it doesn't", () => {
    expect(checkSummary(null, "component:api", VERSION)).toEqual({ status: "missing", issues: [] });
    expect(checkSummary(summary(), "component:api", VERSION)).toEqual({ status: "fresh", issues: [] });
    expect(checkSummary(summary({ version: "b".repeat(64) }), "component:api", VERSION)).toEqual({ status: "stale", issues: [] });
  });

  it("reports structural problems and treats the summary as stale", () => {
    const check = checkSummary(summary({ id: "<component id>", risks: "<!-- todo -->" }), "component:api", VERSION);
    expect(check.status).toBe("stale");
    expect(check.issues).toEqual(['first H1 must be "# component:api"', 'section "Risks" is empty']);
  });
});
