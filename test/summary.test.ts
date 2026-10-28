import { describe, expect, it } from "vitest";
import { checkSummary, requiredSections, unmentionedSurface } from "../src/map/summary.ts";

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

describe("summary surface check", () => {
  const withSurface = (surface: string): string => `# component:api\n## Purpose\nx\n## Public surface\n${surface}\n<!-- placeOrder is mentioned only in a comment -->\n## Invariants\nx\n## Risks\nx\n## Facts version\n${"a".repeat(64)}\n`;

  it("names entry points and exports the Public surface leaves out, matching whole words only", () => {
    const md = withSurface("POST /api/orders creates an order via `createOrder`. Also `placeOrders`.");
    expect(unmentionedSurface(md, { exports: ["createOrder", "placeOrder", "default"], entryPoints: ["entry:http:POST /api/orders", "entry:ui:/orders/[id]"] })).toEqual(["/orders/[id]", "placeOrder"]);
  });

  it("checks nothing for a missing summary and only entry points for a large export list", () => {
    expect(unmentionedSurface(null, { exports: ["a"], entryPoints: ["entry:http:GET /x"] })).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `e${String(i)}`);
    expect(unmentionedSurface(withSurface("GET /x"), { exports: many, entryPoints: ["entry:http:GET /x"] })).toEqual([]);
  });

  it("treats export names as literal text, so string-literal names can't break the check", () => {
    expect(unmentionedSurface(withSurface("exports `a(b`"), { exports: ["a(b", "c[d"], entryPoints: [] })).toEqual(["c[d"]);
  });
});
