import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTree } from "../src/git.ts";
import type { RepoMap } from "../src/map/types.ts";
import { buildMap } from "../src/map/build.ts";
import { listFiles } from "../src/git.ts";
import type { Profile } from "../src/profile/types.ts";
import { cleanup, doctor, expandPlaceholders, launch, loadState, probeOnPort } from "../src/verify/launch.ts";
import { checkStamp, writeDeepStamp } from "../src/verify/report.ts";
import { featureFreshness, syncFeatures } from "../src/verify/sync.ts";
import type { FeatureIndex } from "../src/features.ts";
import { draftFeatures, scaffold } from "../src/verify/scaffold.ts";
import { render } from "../src/template.ts";
import { checkSkill, publishDraft } from "../src/verify/validate.ts";
import { main } from "../src/main.ts";
import { makeProject } from "./helpers/project.ts";

const cmd = (c: string, timeoutSec = 20): { cmd: string; cwd: string; timeoutSec: number } => ({ cmd: c, cwd: ".", timeoutSec });
const noLocal = { env: {}, services: {}, notes: [] };

function profileWith(overrides: Partial<Profile> = {}): Profile {
  return {
    schemaVersion: 1,
    app: { name: "Fixture", slug: "fixture" },
    strategy: "api-backend",
    packageManager: "npm",
    install: null,
    build: null,
    checks: { lint: null, typecheck: null, unit: null, integration: null, e2e: null },
    run: [],
    services: [],
    env: [],
    ui: { present: false, framework: null, baseUrl: null, harness: null, authRequired: false },
    unknowns: [],
    evidence: {},
    ...overrides,
  };
}

async function heldPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => new Promise((resolve) => server.close(() => { resolve(); })) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; } });
  return { code, stdout, stderr };
}

// An HTTP server on $PORT that answers /health, and /upstream with the API_URL it was given; it also spawns a
// grandchild so teardown has to kill the whole group.
const SERVER = `
const http = require("node:http");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(process.env.NAME + ".grandchild", String(child.pid));
http.createServer((req, res) => {
  if (req.url === "/upstream") { res.end(String(process.env.API_URL)); return; }
  res.statusCode = req.url === "/health" ? 200 : 404; res.end("ok");
}).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening on " + process.env.PORT));
`;

describe("launch placeholders and probes", () => {
  it("expands {port:<target>} and {runId}, and refuses unknown targets", () => {
    const ports = new Map<string, number | null>([["api", 5123], ["worker", null]]);
    expect(expandPlaceholders("http://localhost:{port:api}/x?r={runId}", ports, "run-1")).toBe("http://localhost:5123/x?r=run-1");
    expect(() => expandPlaceholders("{port:web}", ports, "r")).toThrow(/names no run target/);
    expect(() => expandPlaceholders("{port:worker}", ports, "r")).toThrow(/has no port/);
  });

  it("moves a readiness probe to the run's port only when it pointed at the profile's port", () => {
    expect(probeOnPort({ kind: "http", url: "http://localhost:3000/health", expectStatus: 200 }, 3000, 51000)).toEqual({ kind: "http", url: "http://localhost:51000/health", expectStatus: 200 });
    expect(probeOnPort({ kind: "http", url: "http://localhost:9999/", expectStatus: 200 }, 3000, 51000)).toEqual({ kind: "http", url: "http://localhost:9999/", expectStatus: 200 });
    expect(probeOnPort({ kind: "port", port: 3000 }, 3000, 51000)).toEqual({ kind: "port", port: 51000 });
    expect(probeOnPort({ kind: "log", pattern: "ready" }, 3000, 51000)).toEqual({ kind: "log", pattern: "ready" });
  });
});

describe("launch, doctor, cleanup", () => {
  it("runs targets on free ports, rewires loopback URLs, checks health, and tears down every group while keeping evidence", async () => {
    const root = makeProject({ "package.json": "{}", "server.js": SERVER });
    const profile = profileWith({
      env: [{ name: "API_URL", required: false, secret: false, defaultForVerification: "http://localhost:4000", source: "env-example" }],
      run: [
        { name: "api", start: cmd("NAME=api node server.js"), ready: { kind: "http", url: "http://127.0.0.1:4000/health", expectStatus: 200 }, stop: "signal", port: 4000, portEnv: "PORT" },
        { name: "web", start: cmd("NAME=web node server.js"), ready: { kind: "log", pattern: "listening on" }, stop: "signal", port: 3000, portEnv: "PORT" },
      ],
    });
    const launched = await launch(root, profile, noLocal, {});
    try {
      expect(launched.ok).toBe(true);
      const [api, web] = launched.targets;
      expect(api?.port).not.toBe(4000);
      expect(web?.port).not.toBe(3000);
      expect(launched.tree).toBe(writeTree(root));
      // web got API_URL moved from the profile's api port to this run's.
      const upstream = await (await fetch(`http://127.0.0.1:${String(web?.port)}/upstream`)).text();
      expect(upstream).toBe(`http://localhost:${String(api?.port)}`);
      expect(readFileSync(path.join(root, launched.evidenceDir, "urls.env"), "utf8")).toBe(`URL_API='http://127.0.0.1:${String(api?.port)}'\n`);

      const healthy = await doctor(root, profile, launched.runId);
      expect(healthy.checks.filter((c) => !c.ok)).toEqual([]);

      // The agent's evidence and report, written before cleanup.
      mkdirSync(path.join(root, launched.evidenceDir, "health"), { recursive: true });
      writeFileSync(path.join(root, launched.evidenceDir, "health", "response.txt"), "HTTP/1.1 200 OK\n\nok");
      writeFileSync(path.join(root, launched.evidenceDir, "report.json"), JSON.stringify({
        schemaVersion: 1, runId: launched.runId, tree: launched.tree,
        features: [{ id: "health", subFeatures: [{ id: "ping", status: "verified", entryPoint: "GET /health", artifacts: ["health/response.txt"], observed: "200 ok" }] }],
      }));
    } finally {
      const result = await cleanup(root, profile, noLocal, launched.runId);
      expect(result.survivors).toEqual([]);
      expect(result.evidence).toEqual({ report: true, checked: 1, missing: [] });
      expect(result.ok).toBe(true);
    }
    const state = loadState(root, launched.runId);
    expect(state.cleanedUpAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    for (const name of ["api", "web"]) expect(alive(Number(readFileSync(path.join(root, `${name}.grandchild`), "utf8")))).toBe(false);
    // Doctor on a cleaned-up run says so; a second cleanup only re-checks.
    expect((await doctor(root, profile, launched.runId)).ok).toBe(false);
    expect((await cleanup(root, profile, noLocal, launched.runId)).teardown[0]).toMatch(/^already cleaned up/);
  }, 40_000);

  it("tears down what it started when a later target fails, and reports the failing step", async () => {
    const root = makeProject({ "package.json": "{}", "server.js": SERVER, "bad.js": 'console.error("Error: Cannot find module ./serverX.ts"); process.exit(3);' });
    const profile = profileWith({
      run: [
        { name: "api", start: cmd("NAME=api node server.js"), ready: { kind: "log", pattern: "listening on" }, stop: "signal", port: 4000, portEnv: "PORT" },
        { name: "web", start: cmd("node bad.js"), ready: { kind: "log", pattern: "never" }, stop: "signal", port: null, portEnv: null },
      ],
    });
    const launched = await launch(root, profile, noLocal, {});
    expect(launched.ok).toBe(false);
    expect(launched.steps.at(-1)).toMatchObject({ step: "run-web", status: "failed", detail: "exited before it was ready" });
    expect(launched.steps.at(-1)?.tail?.join("\n")).toContain("Cannot find module ./serverX.ts");
    expect(launched.teardown.some((l) => l.startsWith("stopped api"))).toBe(true);
    const state = loadState(root, launched.runId);
    await new Promise((r) => setTimeout(r, 200));
    for (const t of state.targets) expect(alive(t.pgid)).toBe(false);
    expect(alive(Number(readFileSync(path.join(root, "api.grandchild"), "utf8")))).toBe(false);
  }, 40_000);

  it("refuses a fixed port someone else holds instead of driving it", async () => {
    const held = await heldPort();
    try {
      const root = makeProject({ "package.json": "{}", "server.js": SERVER });
      const profile = profileWith({ run: [{ name: "api", start: cmd("NAME=api node server.js"), ready: { kind: "port", port: held.port }, stop: "signal", port: held.port, portEnv: null }] });
      const launched = await launch(root, profile, noLocal, {});
      expect(launched.ok).toBe(false);
      expect(launched.steps[0]?.detail).toMatch(/already in use/);
      expect(existsSync(path.join(root, "api.grandchild"))).toBe(false);
    } finally {
      await held.close();
    }
  });

  it("fails cleanup when evidence the report names is gone", async () => {
    const root = makeProject({ "package.json": "{}" });
    const launched = await launch(root, profileWith(), noLocal, {});
    expect(launched.ok).toBe(true);
    writeFileSync(path.join(root, launched.evidenceDir, "report.json"), JSON.stringify({
      schemaVersion: 1, runId: launched.runId, tree: launched.tree,
      features: [{ id: "f", subFeatures: [{ id: "s", status: "verified", entryPoint: "/", artifacts: ["f/shot.png", "../outside.txt"], observed: "x" }] }],
    }));
    const result = await cleanup(root, profileWith(), noLocal, launched.runId);
    expect(result.ok).toBe(false);
    expect(result.evidence.missing).toEqual(["f/shot.png", "../outside.txt (must be under f/ in the run directory)"]);
  });
});

const EMPTY_MAP: RepoMap = { manifest: { schemaVersion: 1, builtAtCommit: "0".repeat(40), extractors: {}, components: [], unassignedFiles: [], extractorFailures: [] }, components: [], resources: { resources: [] } };

describe("features.json draft", () => {
  it("keeps the top five by rank, drops entry points the map lacks, and adds owners and their files", () => {
    const map: RepoMap = {
      ...EMPTY_MAP,
      components: [
        { id: "component:api", kind: "service", root: "apps/api", include: ["apps/api/**"], language: [], framework: [], files: { "apps/api/src/orders.ts": "x", "apps/api/src/app.ts": "y" }, exports: [], edges: [], state: [], summaryStatus: "missing",
          entryPoints: [{ id: "entry:http:POST /api/orders", kind: "http", location: { file: "apps/api/src/orders.ts", line: 3 }, provenance: { source: "extracted", extractor: "express-routes" } }] },
        { id: "component:web", kind: "app", root: "apps/web", include: ["apps/web/**"], language: [], framework: [], files: { "apps/web/app/page.tsx": "z" }, exports: [], edges: [], state: [], summaryStatus: "missing", entryPoints: [] },
      ],
    };
    const risk = [
      ...["a", "b", "c", "d", "e"].map((id, i) => ({ id: `f-${id}`, title: id, why: "w", rank: i + 2, entryPoints: [], paths: ["apps/web/**"] })),
      { id: "orders", title: "Orders", why: "money", rank: 1, entryPoints: ["entry:http:POST /api/orders", "entry:http:GET /gone"], paths: ["apps/web/app/page.tsx"] },
    ];
    const { index, dropped } = draftFeatures(map, risk);
    expect(index.features.map((f) => f.id)).toEqual(["orders", "f-a", "f-b", "f-c", "f-d"]);
    expect(index.features[0]).toEqual({
      id: "orders", file: "features/orders.md", tier: "deep",
      paths: ["apps/api/src/orders.ts", "apps/web/app/page.tsx"],
      components: ["component:api", "component:web"],
      entryPoints: ["entry:http:POST /api/orders"],
    });
    expect(dropped).toEqual(["orders: entry:http:GET /gone is not in the map"]);
  });
});

describe("scaffold and --validate", () => {
  const RISK = {
    schemaVersion: 1, agent: "explorer-risk", riskyResources: [], integrations: [], unknowns: [],
    features: [{ id: "health-check", title: "Health check", why: "monitoring depends on it", rank: 1, entryPoints: ["entry:http:GET /health"], paths: ["src/**"], evidence: [{ file: "src/app.js", line: 3 }] }],
  };
  const APP = 'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.send("ok"));\nmodule.exports = app;\n';

  async function setup(): Promise<{ root: string; map: RepoMap }> {
    const root = makeProject({ "package.json": JSON.stringify({ name: "fx", dependencies: { express: "5.0.0" } }), "src/app.js": APP, ".plumb/knowledge/risk.json": JSON.stringify(RISK) });
    const { map } = await buildMap({ root, config: { schemaVersion: 1 }, cache: "off" });
    return { root, map };
  }

  it("writes a skeleton the validator rejects only for fill tokens, and accepts once they are replaced", async () => {
    const profile = profileWith({ run: [{ name: "api", start: cmd("node src/server.js"), ready: { kind: "http", url: "http://localhost:4000/health", expectStatus: 200 }, stop: "signal", port: 4000, portEnv: "PORT" }] });
    const { root, map } = await setup();
    const result = scaffold(root, profile, map);
    const draft = ".plumb/cache/draft/verify-fixture";
    expect(result).toMatchObject({ skillDir: draft, draft: true });
    expect(result.written).toEqual([".plumb/features.json", `${draft}/SKILL.md`, `${draft}/features/README.md`, `${draft}/features/health-check.md`, ".plumb/bin/doctor"]);
    const skill = readFileSync(path.join(root, draft, "SKILL.md"), "utf8");
    expect(skill).toContain("name: verify-fixture");
    expect(skill).toContain("| api | `node src/server.js` in `.` | HTTP 200 from `http://localhost:4000/health` | free port per run via `PORT` | 20s |");
    expect(readFileSync(path.join(root, draft, "features/health-check.md"), "utf8")).toContain("- Endpoint `GET /health`");

    const files = (): string[] => listFiles(root);
    const before = checkSkill(root, profile, map, files(), draft);
    expect(before.length).toBeGreaterThan(0);
    // Only what the agent still has to write: fill tokens, and the sub-feature bullets a token stands in for.
    expect(before.filter((i) => !i.message.startsWith("template token left in")).map((i) => i.message)).toEqual(["Sub-features needs at least one bullet starting with a `kebab-id`"]);

    // The agent's part: replace every fill token.
    // An invalid draft is never published.
    expect(publishDraft(root, profile, map, files()).published).toBeNull();
    for (const rel of [`${draft}/SKILL.md`, `${draft}/features/README.md`, ".plumb/bin/doctor"]) {
      const file = path.join(root, rel);
      writeFileSync(file, readFileSync(file, "utf8").replaceAll(/\{\{fill:[^}]*\}\}/g, "Filled."));
    }
    writeFileSync(path.join(root, draft, "features/health-check.md"), [
      "# Health check", "", "Monitoring sees the API is up.", "", "## Sub-features", "", "- `ping` returns ok", "",
      "## How to get to it (user POV)", "", "- Endpoint `GET /health`", "", "## Driving it with curl", "", "Preconditions: launched.", "", "- Ping: `curl -i $URL_API/health` shows 200.", "", "## Gotchas", "", "None known yet.", "",
    ].join("\n"));
    expect(checkSkill(root, profile, map, files(), draft)).toEqual([]);
    expect(publishDraft(root, profile, map, files())).toEqual({ published: ".claude/skills/verify-fixture", issues: [] });
    expect(existsSync(path.join(root, draft))).toBe(false);
    expect(checkSkill(root, profile, map, files())).toEqual([]);

    // A second scaffold keeps everything as it is, and publishing again is refused.
    expect(scaffold(root, profile, map).written).toEqual([]);
    expect(() => publishDraft(root, profile, map, files())).toThrow(/no draft/);
  });

  it("reports structural problems at their files", async () => {
    const profile = profileWith();
    const { root, map } = await setup();
    scaffold(root, profile, map);
    const dir = path.join(root, ".plumb/cache/draft/verify-fixture");
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: verify-other\n---\n\n## Doctor\n\n## Launch\n");
    writeFileSync(path.join(dir, "features/health-check.md"), "# Health\n\n## Sub-features\n\n## Gotchas\n");
    writeFileSync(path.join(dir, "features/orphan.md"), "# Orphan\n");
    chmodSync(path.join(root, ".plumb/bin/doctor"), 0o644);
    const messages = checkSkill(root, profile, map, listFiles(root), ".plumb/cache/draft/verify-fixture").map((i) => `${i.file}: ${i.message}`.replace(".plumb/cache/draft/", ".claude/skills/"));
    expect(messages).toEqual(expect.arrayContaining([
      ".claude/skills/verify-fixture/SKILL.md: frontmatter name must be \"verify-fixture\"",
      ".claude/skills/verify-fixture/SKILL.md: frontmatter needs a description",
      ".claude/skills/verify-fixture/SKILL.md: \"## Doctor\" is out of order (Launch, Doctor, Drive, Evidence, Cleanup)",
      ".claude/skills/verify-fixture/SKILL.md: missing required section \"## Drive\"",
      ".claude/skills/verify-fixture/SKILL.md: missing required section \"## Proof standards\"",
      ".claude/skills/verify-fixture/SKILL.md: doesn't show how to invoke .plumb/bin/doctor",
      ".plumb/bin/doctor: is not executable (chmod +x)",
      ".claude/skills/verify-fixture/features/health-check.md: needs a paragraph describing the user-visible behavior before the first H2",
      ".claude/skills/verify-fixture/features/health-check.md: needs exactly these H2s in order: Sub-features, How to get to it (user POV), Driving it with <harness>, Gotchas (found: Sub-features, Gotchas)",
      ".claude/skills/verify-fixture/features/orphan.md: has no entry in .plumb/features.json",
    ]));
  });

  it("adds a Playwright MCP entry only for a UI without a usable harness, and never touches other entries", async () => {
    const ui = (harness: Profile["ui"]["harness"]): Profile => profileWith({ ui: { present: true, framework: "next", baseUrl: null, harness, authRequired: false } });
    const { root, map } = await setup();
    expect(scaffold(root, ui("existing-playwright"), map).written).not.toContain(".mcp.json");
    expect(existsSync(path.join(root, ".mcp.json"))).toBe(false);

    writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
    expect(scaffold(root, ui("playwright-mcp"), map).written).toEqual([".mcp.json"]);
    const servers = (JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(Object.keys(servers)).toEqual(["db", "playwright"]);
    expect(servers["db"]).toEqual({ command: "db-mcp" });
    expect(scaffold(root, ui("playwright-mcp"), map).written).toEqual([]);
  });

  it("render refuses a token it has no value for", () => {
    expect(render("a {{plumb:x}} {{fill: keep}}", { x: "1" })).toBe("a 1 {{fill: keep}}");
    expect(() => render("{{plumb:y}}", {})).toThrow(/has no value/);
  });
});

describe("--stamp", () => {
  const FEATURES = { features: [{ id: "orders", file: "features/orders.md", paths: ["src/orders.js"], components: [], entryPoints: [], tier: "deep" as const }] };

  function runWithReport(root: string, report: object, files: Record<string, string> = { "orders/response.json": "{}" }, launchedTree?: string): string {
    const runId = "run-1";
    const dir = path.join(root, ".plumb/evidence", runId);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
    writeFileSync(path.join(dir, "report.json"), JSON.stringify({ schemaVersion: 1, runId, ...report }));
    writeFileSync(path.join(dir, "report.md"), "# Report\n");
    writeFileSync(path.join(dir, "run.json"), JSON.stringify({ schemaVersion: 1, runId, tree: launchedTree ?? (report as { tree: string }).tree, cleanedUpAt: "2026-10-18T00:00:00Z" }));
    return runId;
  }
  const verified = { id: "orders", subFeatures: [{ id: "place", status: "verified", entryPoint: "POST /api/orders", artifacts: ["orders/response.json"], observed: "201" }] };

  it("stamps the staged tree when the report proves every touched deep feature", () => {
    const root = makeProject({ "src/orders.js": "x" });
    const tree = writeTree(root);
    const runId = runWithReport(root, { tree, features: [verified] });
    const check = checkStamp(root, runId, tree, FEATURES, ["orders"]);
    expect(check).toMatchObject({ ok: true, issues: [], verified: ["orders"] });
    const stamp = writeDeepStamp(root, runId, check);
    expect(stamp).toBe(`.plumb/stamps/deep-${tree}`);
    expect(JSON.parse(readFileSync(path.join(root, stamp), "utf8"))).toMatchObject({ tree, runId, report: ".plumb/evidence/run-1/report.md", features: ["orders"] });
  });

  it("trusts the tree recorded at launch, not the one the report claims", () => {
    const root = makeProject({ "src/orders.js": "x" });
    const tree = writeTree(root);
    const runId = runWithReport(root, { tree, features: [verified] }, undefined, "1".repeat(40));
    expect(checkStamp(root, runId, tree, FEATURES, ["orders"]).issues).toEqual([
      `report.json names tree ${tree}, but the run was launched on ${"1".repeat(40)}`,
      `the run drove tree ${"1".repeat(40)}, but the staged tree is ${tree}; the content changed after the drive, so verify again`,
    ]);
  });

  it("refuses a report for another tree, a failed or unreachable-only feature, an unknown feature, or a run still up", () => {
    const root = makeProject({ "src/orders.js": "x" });
    const tree = writeTree(root);
    const unreachable = { id: "orders", subFeatures: [{ id: "place", status: "verified-unreachable", entryPoint: "/checkout", artifacts: [], observed: "no key", prerequisite: "STRIPE_KEY" }] };
    const failed = { id: "ghost", subFeatures: [{ id: "x", status: "failed", entryPoint: "/", artifacts: [], observed: "500" }] };
    const runId = runWithReport(root, { tree: "0".repeat(40), features: [unreachable, failed] });
    writeFileSync(path.join(root, ".plumb/evidence/run-1/run.json"), JSON.stringify({ schemaVersion: 1, runId, tree: "0".repeat(40), cleanedUpAt: null }));
    const issues = checkStamp(root, runId, tree, FEATURES, ["orders"]).issues;
    expect(issues).toEqual([
      "run run-1 is still running; run plumb verify --cleanup run-1 first",
      `the run drove tree ${"0".repeat(40)}, but the staged tree is ${tree}; the content changed after the drive, so verify again`,
      "feature \"ghost\" is not in .plumb/features.json",
      "ghost/x failed: 500",
      "the changes touch deep feature \"orders\", which this run didn't verify",
    ]);
  });
});

describe("--sync and feature freshness", () => {
  const feature = (id: string, paths: string[]) => ({ id, file: `features/${id}.md`, paths, components: [], entryPoints: [], tier: "deep" as const });
  const verifiedReport = (id: string) => ({ id, subFeatures: [{ id: "main", status: "verified", entryPoint: "/", artifacts: [`${id}/proof.txt`], observed: "ok" }] });
  const git = (root: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();

  function setup(): string {
    const root = makeProject({ "src/orders.js": "1", "src/cart.js": "1", "src/other.js": "1" });
    mkdirSync(path.join(root, ".plumb"), { recursive: true });
    writeFileSync(path.join(root, ".plumb/features.json"), JSON.stringify({ features: [feature("orders", ["src/orders.js"]), feature("cart", ["src/cart.js"]), feature("refunds", ["src/refunds/**"])] }));
    return root;
  }

  function finishedRun(root: string, tree: string, features: object[]): string {
    const dir = path.join(root, ".plumb/evidence/run-1");
    for (const id of ["orders", "cart"]) {
      mkdirSync(path.join(dir, id), { recursive: true });
      writeFileSync(path.join(dir, id, "proof.txt"), "ok");
    }
    writeFileSync(path.join(dir, "report.json"), JSON.stringify({ schemaVersion: 1, runId: "run-1", tree, features }));
    writeFileSync(path.join(dir, "report.md"), "# Report\n");
    writeFileSync(path.join(dir, "run.json"), JSON.stringify({ schemaVersion: 1, runId: "run-1", tree, cleanedUpAt: "2026-10-18T00:00:00Z" }));
    return "run-1";
  }

  const load = (root: string): FeatureIndex => JSON.parse(readFileSync(path.join(root, ".plumb/features.json"), "utf8")) as FeatureIndex;

  it("syncs only verified features whose code is unchanged since the drive, then tracks staleness from that commit", () => {
    const root = setup();
    const tree = writeTree(root);
    const unreachable = { id: "refunds", subFeatures: [{ id: "main", status: "verified-unreachable", entryPoint: "/refunds", artifacts: [], observed: "no key", prerequisite: "STRIPE_KEY" }] };
    finishedRun(root, tree, [verifiedReport("orders"), verifiedReport("cart"), unreachable]);
    // cart's code moves on after the drive and is committed; the run no longer proves it.
    writeFileSync(path.join(root, "src/cart.js"), "2");
    git(root, "commit", "-qam", "change cart");
    const head = git(root, "rev-parse", "HEAD");

    const result = syncFeatures(root, "run-1", load(root));
    expect(result).toEqual({
      commit: head,
      synced: ["orders"],
      skipped: [
        { id: "cart", reason: "its code changed after the drive; commit what was driven, or verify again" },
        { id: "refunds", reason: "nothing was verified (only unreachable)" },
      ],
    });
    expect(load(root).features.map((f) => f.syncedAt ?? null)).toEqual([head, null, null]);

    const states = () => featureFreshness(root, load(root)).map((f) => [f.id, f.state, f.changed]);
    expect(states()).toEqual([["orders", "fresh", []], ["cart", "unaudited", []], ["refunds", "unaudited", []]]);
    // An unrelated change keeps orders fresh; a change under its paths makes it stale.
    writeFileSync(path.join(root, "src/other.js"), "2");
    git(root, "commit", "-qam", "other");
    expect(states()[0]).toEqual(["orders", "fresh", []]);
    writeFileSync(path.join(root, "src/orders.js"), "2");
    git(root, "commit", "-qam", "orders");
    expect(states()[0]).toEqual(["orders", "stale", ["src/orders.js"]]);
  });

  it("refuses a run whose evidence a stamp would refuse: missing artifact, another run's report, another tree", () => {
    const report = (root: string): string => path.join(root, ".plumb/evidence/run-1/report.json");
    const missing = setup();
    finishedRun(missing, writeTree(missing), [verifiedReport("orders")]);
    rmSync(path.join(missing, ".plumb/evidence/run-1/orders/proof.txt"));
    expect(() => syncFeatures(missing, "run-1", load(missing))).toThrow(/artifact missing: orders\/proof.txt/);

    const copied = setup();
    const tree = writeTree(copied);
    finishedRun(copied, tree, [verifiedReport("orders")]);
    writeFileSync(report(copied), JSON.stringify({ schemaVersion: 1, runId: "run-0", tree, features: [verifiedReport("orders")] }));
    expect(() => syncFeatures(copied, "run-1", load(copied))).toThrow(/runId is "run-0"/);
    writeFileSync(report(copied), JSON.stringify({ schemaVersion: 1, runId: "run-1", tree: "0".repeat(40), features: [verifiedReport("orders")] }));
    expect(() => syncFeatures(copied, "run-1", load(copied))).toThrow(/but the run was launched on/);
    expect(load(copied).features[0]?.syncedAt).toBeUndefined();
  });

  it("skips a feature with a failed sub-feature", () => {
    const root = setup();
    const failed = { id: "orders", subFeatures: [...verifiedReport("orders").subFeatures, { id: "refund", status: "failed", entryPoint: "/", artifacts: [], observed: "500" }] };
    finishedRun(root, writeTree(root), [failed]);
    expect(syncFeatures(root, "run-1", load(root)).skipped).toEqual([{ id: "orders", reason: "a sub-feature failed" }]);
  });

  it("reads paths relative to a Plumb root in a repo subdirectory", () => {
    const repo = makeProject({ "pkg/src/orders.js": "1", "other/src/orders.js": "1" });
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(path.join(repo, "pkg/src/orders.js"), "2");
    writeFileSync(path.join(repo, "other/src/orders.js"), "2");
    git(repo, "commit", "-qam", "both");
    const index: FeatureIndex = { features: [{ ...feature("orders", ["src/orders.js"]), syncedAt: head }] };
    expect(featureFreshness(path.join(repo, "pkg"), index)[0]).toMatchObject({ state: "stale", changed: ["src/orders.js"] });
  });

  it("calls a sync commit that isn't in the clone unknown, and refuses a run still up", () => {
    const root = setup();
    const index = load(root);
    index.features[0] = { ...feature("orders", ["src/orders.js"]), syncedAt: "f".repeat(40) };
    expect(featureFreshness(root, index)[0]?.state).toBe("unknown");

    const tree = writeTree(root);
    finishedRun(root, tree, [verifiedReport("orders")]);
    writeFileSync(path.join(root, ".plumb/evidence/run-1/run.json"), JSON.stringify({ schemaVersion: 1, runId: "run-1", tree, cleanedUpAt: null }));
    expect(() => syncFeatures(root, "run-1", load(root))).toThrow(/still running/);
  });
});

describe("plumb verify CLI", () => {
  it("needs exactly one mode and rejects flags for other modes", async () => {
    expect((await run(["verify"])).code).toBe(3);
    expect((await run(["verify", "--plan", "--validate"])).code).toBe(3);
    expect((await run(["verify", "--validate", "--env", "A=1"])).code).toBe(3);
    expect((await run(["verify", "--doctor", "../../etc"])).code).toBe(3);
  });

  it("plans the deep features a staged change touches, with their recipe files", async () => {
    const root = makeProject({
      "package.json": "{}",
      "src/orders.js": "x",
      ".plumb/profile.json": JSON.stringify(profileWith()),
      ".plumb/features.json": JSON.stringify({ features: [
        { id: "orders", file: "features/orders.md", paths: ["src/orders.js"], components: [], entryPoints: [], tier: "deep" },
        { id: "docs", file: "features/docs.md", paths: ["README.md"], components: [], entryPoints: [], tier: "deep" },
      ] }),
    });
    writeFileSync(path.join(root, "src/orders.js"), "y");
    execFileSync("git", ["add", "src/orders.js"], { cwd: root });
    const result = await run(["verify", "--plan", "--staged", "--json", "--cwd", root]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ drive: ["orders"], features: [{ id: "orders", tier: "deep", recipe: ".claude/skills/verify-fixture/features/orders.md" }] });
    expect(readdirSync(root)).not.toContain(".claude");
  });

  it("leaves deepIgnore files out of a staged plan, but not out of a branch plan", async () => {
    const root = makeProject({
      "package.json": "{}",
      "src/orders.css": "x",
      ".plumb/config.json": JSON.stringify({ schemaVersion: 1, deepIgnore: ["**/*.css"] }),
      ".plumb/profile.json": JSON.stringify(profileWith()),
      ".plumb/features.json": JSON.stringify({ features: [
        { id: "orders", file: "features/orders.md", paths: ["src/orders.*"], components: [], entryPoints: [], tier: "deep" },
      ] }),
    });
    writeFileSync(path.join(root, "src/orders.css"), "y");
    execFileSync("git", ["add", "src/orders.css"], { cwd: root });
    expect(JSON.parse((await run(["verify", "--plan", "--staged", "--json", "--cwd", root])).stdout)).toMatchObject({ drive: [] });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "css"], { cwd: root });
    expect(JSON.parse((await run(["verify", "--plan", "HEAD~1", "--json", "--cwd", root])).stdout)).toMatchObject({ drive: ["orders"] });
  });
});
