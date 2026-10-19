import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/main.ts";
import { buildMap, renderMap } from "../src/map/build.ts";
import { factsVersions } from "../src/map/serialize.ts";
import { loadMap } from "../src/map/store.ts";
import type { RepoMap } from "../src/map/types.ts";
import { cloneExample, commit, makeProject } from "./helpers/project.ts";

const FEATURES = {
  features: [
    { id: "place-order", file: "features/place-order.md", paths: ["apps/api/src/routes/orders.ts", "apps/web/app/orders/**"], components: ["component:api", "component:web"], entryPoints: ["entry:http:POST /api/orders"], tier: "deep" },
    { id: "sign-in", file: "features/sign-in.md", paths: ["apps/api/src/routes/sessions.ts", "apps/web/components/sign-in-form.tsx"], components: ["component:api", "component:web"], entryPoints: ["entry:http:POST /api/sessions"], tier: "deep" },
  ],
};

let root = "";

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main([...argv, "--cwd", root], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

/** Writes a valid summary for every component against its current facts version, so each step starts all-fresh. */
function stampSummaries(map: RepoMap): void {
  const versions = factsVersions(map.components);
  for (const c of map.components) {
    const name = c.id.replace("component:", "");
    const body = [`# ${c.id}`, "## Purpose", "x", "## Public surface", "x", "## Invariants", "x", "## Risks", "x", "## Facts version", versions.get(c.id) ?? ""];
    writeFileSync(path.join(root, ".plumb/map/components", `${name}.md`), `${body.join("\n")}\n`);
  }
}

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

interface Step {
  before: RepoMap;
  after: RepoMap;
  changedMapFiles: string[];
  impact: { changedComponents: string[]; components: Array<{ id: string; reasons: string[] }>; unassignedChangedFiles: string[]; features: Array<{ id: string }> | null };
}

/**
 * One scripted commit: map --update must equal a from-scratch rebuild; returns what changed and the impact set
 * of the commit (HEAD~1...HEAD).
 */
async function step(files: Record<string, string>, message: string): Promise<Step> {
  stampSummaries(loadMap(root));
  // Absorb the stamped summaries (missing/stale -> fresh) so the step measures only the commit below.
  expect((await cli("map", "--update")).code).toBe(0);
  const before = loadMap(root);
  commit(root, files, message);

  const update = await cli("map", "--update", "--json");
  expect(update.code, update.stderr).toBe(0);
  const changedMapFiles = (JSON.parse(update.stdout) as { changed: string[] }).changed.sort();

  const { map: rebuilt } = await buildMap({ root, cache: "off" });
  const after = loadMap(root);
  // The incremental result, as written to disk, equals a full rebuild with no cache.
  expect(Object.fromEntries(renderMap(after))).toEqual(Object.fromEntries(renderMap(rebuilt)));

  const impact = await cli("impact", "HEAD~1", "--json");
  expect(impact.code, impact.stderr).toBe(0);
  return { before, after, changedMapFiles, impact: JSON.parse(impact.stdout) as Step["impact"] };
}

const statuses = (map: RepoMap): Record<string, string> => Object.fromEntries(map.components.map((c) => [c.id, c.summaryStatus]));
const component = (map: RepoMap, id: string) => map.components.find((c) => c.id === id);

describe("incremental map update and impact on a scripted series of commits", () => {
  beforeAll(async () => {
    root = cloneExample();
    commit(root, { ".plumb/features.json": JSON.stringify(FEATURES) }, "add features index");
    const first = await cli("map");
    expect(first.code, first.stderr).toBe(0);
  }, 60_000);

  it("internal change: only the file hash moves; summaries stay fresh; callers are impacted", async () => {
    const pricing = read("apps/api/src/pricing.ts").replace("// Order.totalCents is a 32-bit Postgres INTEGER.", "// Order.totalCents is a 32-bit INTEGER column.");
    const s = await step({ "apps/api/src/pricing.ts": pricing }, "reword a comment");

    expect(s.changedMapFiles).toEqual(["components/api.json", "manifest.json"]);
    const before = component(s.before, "component:api");
    const after = component(s.after, "component:api");
    expect({ ...after, files: {}, summaryStatus: "x" }).toEqual({ ...before, files: {}, summaryStatus: "x" });
    expect(statuses(s.after)).toEqual({ "component:api": "fresh", "component:db": "fresh", "component:web": "fresh" });
    expect(s.impact.changedComponents).toEqual(["component:api"]);
    expect(s.impact.components).toEqual([
      { id: "component:api", reasons: ["changed"] },
      { id: "component:web", reasons: ["calls component:api (entry:http:DELETE /api/sessions)", "calls component:api (entry:http:GET /api/orders/:id)", "calls component:api (entry:http:GET /api/products)", "calls component:api (entry:http:POST /api/orders)", "calls component:api (entry:http:POST /api/products)", "calls component:api (entry:http:POST /api/sessions)"] },
    ]);
    expect(s.impact.features).toEqual([]);
  });

  it("export change: the package's summary and its importers' summaries go stale; importers are impacted", async () => {
    const index = `${read("packages/db/src/index.ts")}export const SCHEMA_VERSION = 1;\n`;
    const s = await step({ "packages/db/src/index.ts": index }, "export schema version");

    expect(component(s.after, "component:db")?.exports).toContain("SCHEMA_VERSION");
    expect(s.changedMapFiles).toEqual(["components/api.json", "components/db.json", "components/web.json", "manifest.json"]);
    expect(statuses(s.after)).toEqual({ "component:api": "stale", "component:db": "stale", "component:web": "stale" });
    expect(s.impact.components).toEqual([
      { id: "component:api", reasons: ["imports component:db"] },
      { id: "component:db", reasons: ["changed"] },
      { id: "component:web", reasons: ["imports component:db"] },
    ]);
  });

  it("new route: a new entry point; the service and its callers' summaries go stale; the touched feature is found", async () => {
    const orders = `${read("apps/api/src/routes/orders.ts")}
ordersRouter.get("/api/orders", requireUser, async (_req, res) => {
  res.json({ orders: await prisma.order.findMany({ where: { userId: currentUser(res).id } }) });
});
`;
    const s = await step({ "apps/api/src/routes/orders.ts": orders }, "list orders");

    const added = component(s.after, "component:api")?.entryPoints.map((e) => e.id).filter((id) => !component(s.before, "component:api")?.entryPoints.some((e) => e.id === id));
    expect(added).toEqual(["entry:http:GET /api/orders"]);
    expect(statuses(s.after)).toEqual({ "component:api": "stale", "component:db": "fresh", "component:web": "stale" });
    // File granularity: orders.ts also writes Product, so Product's other writer (db's seed) is pulled in too.
    expect(s.impact.components.map((c) => [c.id, c.reasons.filter((r) => !r.startsWith("calls "))])).toEqual([
      ["component:api", ["changed", "writes resource:db.Order", "writes resource:db.Product"]],
      ["component:db", ["writes resource:db.Product"]],
      ["component:web", ["writes resource:db.Order", "writes resource:db.Product"]],
    ]);
    expect(s.impact.features).toEqual([{ id: "place-order", tier: "deep" }]);
  });

  it("new table writer: the writer's summary goes stale; every other writer of that table is impacted", async () => {
    const audit = 'import { prisma } from "@node-web/db";\n\nexport async function touchSession(token: string): Promise<void> {\n  await prisma.session.updateMany({ where: { token }, data: {} });\n}\n';
    const s = await step({ "apps/web/lib/audit.ts": audit }, "touch sessions from web");

    const writes = component(s.after, "component:web")?.edges.find((e) => e.kind === "writes" && e.to === "resource:db.Session");
    expect(writes?.evidence).toEqual([{ file: "apps/web/lib/audit.ts", line: 4 }]);
    expect(statuses(s.after)).toEqual({ "component:api": "fresh", "component:db": "fresh", "component:web": "stale" });
    expect(s.impact.components).toEqual([
      { id: "component:api", reasons: ["writes resource:db.Session"] },
      { id: "component:web", reasons: ["changed", "writes resource:db.Session"] },
    ]);
  });

  it("new unassigned file: only the manifest changes and nothing is impacted", async () => {
    const s = await step({ "scripts/report.ts": "console.log('report');\n" }, "add report script");

    expect(s.changedMapFiles).toEqual(["manifest.json"]);
    expect(s.after.manifest.unassignedFiles).toContain("scripts/report.ts");
    expect(statuses(s.after)).toEqual({ "component:api": "fresh", "component:db": "fresh", "component:web": "fresh" });
    expect(s.impact).toMatchObject({ changedComponents: [], components: [], unassignedChangedFiles: ["scripts/report.ts"], features: [] });
  });

  it("map --check fails on an uncommitted change until map --update runs", async () => {
    const clean = await cli("map", "--check");
    expect(clean.code, clean.stdout + clean.stderr).toBe(0);
    writeFileSync(path.join(root, "apps/api/src/cookies.ts"), `${read("apps/api/src/cookies.ts")}export const COOKIE_VERSION = 2;\n`);
    const stale = await cli("map", "--check");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain(".plumb/map/components/api.json");
    expect((await cli("map", "--update")).code).toBe(0);
    expect((await cli("map", "--check")).code).toBe(0);
    // A fresh map isn't rewritten just because HEAD moved: builtAtCommit alone is no change.
    commit(root, {}, "commit the change");
    const manifest = read(".plumb/map/manifest.json");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "empty"], { cwd: root });
    expect((await cli("map", "--update")).code).toBe(0);
    expect(read(".plumb/map/manifest.json")).toBe(manifest);
    expect((await cli("map")).code).toBe(0);
    expect(read(".plumb/map/manifest.json")).toBe(manifest);
  });

  it("map rebuild restores one conflicted component file and leaves the others alone", async () => {
    const apiFile = path.join(root, ".plumb/map/components/api.json");
    const webFile = path.join(root, ".plumb/map/components/web.json");
    const good = readFileSync(apiFile, "utf8");
    const web = readFileSync(webFile, "utf8");
    writeFileSync(apiFile, `<<<<<<< HEAD\n${good}=======\n{}\n>>>>>>> branch\n`);
    writeFileSync(webFile, `${web} `);
    const r = await cli("map", "rebuild", "component:api");
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(apiFile, "utf8")).toBe(good);
    expect(readFileSync(webFile, "utf8")).toBe(`${web} `);
  });

  it("impact --staged and its formats", async () => {
    writeFileSync(path.join(root, "apps/web/components/sign-in-form.tsx"), `${read("apps/web/components/sign-in-form.tsx")}\n`);
    commit(root, {}, "noop");
    writeFileSync(path.join(root, "apps/web/components/sign-in-form.tsx"), `${read("apps/web/components/sign-in-form.tsx")}// edited\n`);
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "apps/web/components/sign-in-form.tsx"], { cwd: root });
    expect((await cli("impact", "--staged", "--format=components")).stdout).toBe("component:web\n");
    expect((await cli("impact", "--staged", "--format=files")).stdout).toBe("apps/web/components/sign-in-form.tsx\n");
    expect((await cli("impact", "--staged", "--format=features")).stdout).toBe("sign-in\n");
    expect((await cli("impact", "nope-ref")).code).toBe(3);
    expect((await cli("impact")).code).toBe(3);
  });
});

describe("fact cache soundness", () => {
  const TSCONFIG = JSON.stringify({ extends: "./config/base.json", compilerOptions: { module: "nodenext", moduleResolution: "nodenext", allowImportingTsExtensions: true, noEmit: true } });
  const CONFIG = JSON.stringify({ schemaVersion: 1, components: [{ id: "app", include: ["src/**"] }, { id: "one", include: ["one/**"] }, { id: "two", include: ["two/**"] }] });
  const aliasTo = (dir: string): string => JSON.stringify({ compilerOptions: { paths: { "@lib/*": [`./${dir}/*`] } } });
  const imports = (map: RepoMap): string[] => map.components.find((c) => c.id === "component:app")?.edges.filter((e) => e.kind === "imports").map((e) => e.to) ?? [];

  it("re-cruises when only a tsconfig `extends` target changes", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ name: "fixture" }),
      ".plumb/config.json": CONFIG,
      "tsconfig.json": TSCONFIG,
      "config/base.json": aliasTo("one"),
      "src/a.ts": 'import { x } from "@lib/x.ts";\nexport const y = x;',
      "one/x.ts": "export const x = 1;",
      "two/x.ts": "export const x = 2;",
    });
    const first = await buildMap({ root: dir, cache: "write-only" });
    expect(imports(first.map)).toEqual(["component:one"]);

    writeFileSync(path.join(dir, "config/base.json"), aliasTo("two"));
    const updated = await buildMap({ root: dir, cache: "read-write" });
    const rebuilt = await buildMap({ root: dir, cache: "off" });
    expect(imports(updated.map)).toEqual(["component:two"]);
    expect(Object.fromEntries(renderMap(updated.map))).toEqual(Object.fromEntries(renderMap(rebuilt.map)));
  });

  it("doesn't cache a failure caused by a missing gitignored file, and check/rebuild report it", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ name: "fixture" }),
      ".gitignore": "src/generated/\n",
      ".plumb/config.json": JSON.stringify({ schemaVersion: 1, components: [{ id: "app", include: ["src/**"] }] }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", allowImportingTsExtensions: true, noEmit: true } }),
      "src/a.ts": 'import { client } from "./generated/client.ts";\nexport const c = client;',
    });
    const run = async (...argv: string[]): Promise<number> => main([...argv, "--cwd", dir], { stdout: () => undefined, stderr: () => undefined });

    expect(await run("map")).toBe(2);
    expect(await run("map", "--check")).toBe(2);
    expect(await run("map", "rebuild", "component:app")).toBe(2);

    // Like running a code generator: the file appears but nothing tracked changes.
    mkdirSync(path.join(dir, "src/generated"));
    writeFileSync(path.join(dir, "src/generated/client.ts"), "export const client = 1;");
    expect(await run("map", "--update")).toBe(0);
    expect(loadMap(dir).manifest.extractorFailures).toEqual([]);
    expect(await run("map", "--check")).toBe(0);
  });
});
