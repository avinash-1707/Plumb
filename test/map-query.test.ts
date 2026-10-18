import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MapIndex } from "../src/map/query.ts";
import { factsVersions, publicFactsHash } from "../src/map/serialize.ts";
import type { Component, Manifest, Resources } from "../src/map/types.ts";

const GOLDEN = fileURLToPath(new URL("../examples/node-web/.plumb-golden/map/", import.meta.url));
const read = (rel: string): unknown => JSON.parse(readFileSync(GOLDEN + rel, "utf8"));
const index = new MapIndex({
  manifest: read("manifest.json") as Manifest,
  components: readdirSync(`${GOLDEN}components`).map((f) => read(`components/${f}`) as Component),
  resources: read("resources.json") as Resources,
});

describe("MapIndex", () => {
  it("finds dependents through imports and through calls to a component's entry points", () => {
    expect(index.dependents("component:db")).toEqual(["component:api", "component:web"]);
    expect(index.dependents("component:api")).toEqual(["component:web"]);
    expect(index.dependents("component:web")).toEqual([]);
  });

  it("lists every component writing a table", () => {
    expect(index.writers("resource:db.Order")).toEqual(["component:api", "component:web"]);
    expect(index.writers("resource:db.OrderItem")).toEqual([]);
  });

  it("lists entry points and resolves any node id", () => {
    expect(index.entries("component:web")).toEqual(["entry:ui:/", "entry:ui:/orders/[id]", "entry:ui:/products/new", "entry:ui:/sign-in"]);
    expect(index.node("entry:http:POST /api/orders")).toMatchObject({ type: "entry", owners: ["component:api"] });
    expect(index.node("state:apps/api/src/cache.ts#productSearchCache")).toMatchObject({ type: "state", owner: "component:api" });
    expect(index.incoming("entry:http:POST /api/orders").map((r) => r.from)).toEqual(["component:web"]);
  });
});

describe("publicFactsHash", () => {
  const component = read("components/api.json") as Component;

  it("ignores summaryStatus, file hashes, and evidence lines: internal edits keep a summary fresh", () => {
    const shifted: Component = {
      ...component,
      summaryStatus: "fresh",
      files: { ...component.files, "apps/api/src/app.ts": "f".repeat(40) },
      edges: component.edges.map((e) => ({ ...e, evidence: e.evidence.map((l) => ({ ...l, line: l.line + 3 })) })),
    };
    expect(publicFactsHash(shifted)).toBe(publicFactsHash(component));
  });

  it("changes when the public shape changes", () => {
    expect(publicFactsHash({ ...component, exports: ["x"] })).not.toBe(publicFactsHash(component));
    expect(publicFactsHash({ ...component, edges: component.edges.slice(1) })).not.toBe(publicFactsHash(component));
  });
});

describe("factsVersions", () => {
  const components = index.map.components;
  const withDbExports = (exports: string[]): Component[] => components.map((c) => (c.id === "component:db" ? { ...c, exports } : c));

  it("stales a component's dependents when its public facts change, and nothing else", () => {
    const before = factsVersions(components);
    const after = factsVersions(withDbExports(["prisma"]));
    // api and web import db; web also calls api, but api's own public facts didn't change.
    expect([...before.keys()].filter((id) => before.get(id) !== after.get(id)).sort()).toEqual(["component:api", "component:db", "component:web"]);
  });

  it("does not stale a component's dependencies when the component itself changes", () => {
    const before = factsVersions(components);
    const after = factsVersions(components.map((c) => (c.id === "component:web" ? { ...c, exports: ["x"] } : c)));
    expect([...before.keys()].filter((id) => before.get(id) !== after.get(id))).toEqual(["component:web"]);
  });
});

describe("MapIndex with a route served by two components", () => {
  it("keeps every owner", () => {
    const api = read("components/api.json") as Component;
    const twin: Component = { ...api, id: "component:twin", root: "apps/twin", edges: [], state: [] };
    const both = new MapIndex({ ...index.map, components: [...index.map.components, twin] });
    expect(both.node("entry:http:GET /health")).toMatchObject({ owners: ["component:api", "component:twin"] });
  });
});
