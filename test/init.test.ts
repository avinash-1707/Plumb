import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles } from "../src/git.ts";
import { main } from "../src/main.ts";
import { buildMap } from "../src/map/build.ts";
import type { Profile } from "../src/profile/types.ts";
import { scaffold } from "../src/verify/scaffold.ts";
import { editSkill, publishDraft } from "../src/verify/validate.ts";
import { commit, makeProject } from "./helpers/project.ts";

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; } });
  return { code, stdout, stderr };
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });

const PROFILE: Profile = {
  schemaVersion: 1, app: { name: "Fixture", slug: "fixture" }, strategy: "api-backend", packageManager: "npm", install: null, build: null,
  checks: { lint: { cmd: "node -e 0", cwd: ".", timeoutSec: 30 }, typecheck: null, unit: null, integration: null, e2e: null },
  run: [{ name: "api", start: { cmd: "node src/server.js", cwd: ".", timeoutSec: 20 }, ready: { kind: "http", url: "http://localhost:4000/health", expectStatus: 200 }, stop: "signal", port: 4000, portEnv: "PORT" }],
  services: [], env: [], ui: { present: false, framework: null, baseUrl: null, harness: null, authRequired: false }, unknowns: [], evidence: {},
};
const APP = 'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.send("ok"));\napp.post("/orders", (req, res) => res.send("ok"));\nmodule.exports = app;\n';
const RISK = {
  schemaVersion: 1, agent: "explorer-risk", riskyResources: [], integrations: [], unknowns: [],
  features: [{ id: "orders", title: "Place an order", why: "money", rank: 1, entryPoints: ["entry:http:POST /orders"], paths: ["src/orders/**"], evidence: [{ file: "src/app.js", line: 4 }] }],
};

/** An initialized project: profile, a published and filled verify skill, gate.sh, all committed. */
async function initialized(): Promise<string> {
  const root = makeProject({
    "package.json": JSON.stringify({ name: "fx", dependencies: { express: "5.0.0" } }),
    "src/app.js": APP,
    "src/orders/place.js": "1",
    "node_modules/express/package.json": JSON.stringify({ name: "express", version: "5.0.0", main: "index.js" }),
    "node_modules/express/index.js": "module.exports = () => ({});\n",
    ".gitignore": "node_modules/\n.plumb/knowledge/\n.plumb/cache/\n.plumb/evidence/\n.plumb/stamps/\n.plumb/local.json\n",
    ".plumb/profile.json": JSON.stringify(PROFILE),
    ".plumb/knowledge/risk.json": JSON.stringify(RISK),
  });
  // What /plumb-init does deterministically: the map and the .gitignore block, then the generated files.
  writeFileSync(path.join(root, ".plumb/profile.json.tmp"), "");
  execFileSync("mv", [path.join(root, ".plumb/profile.json"), path.join(root, ".plumb/profile.json.tmp")]);
  expect((await run(["init", "--cwd", root])).code).toBe(0);
  execFileSync("mv", [path.join(root, ".plumb/profile.json.tmp"), path.join(root, ".plumb/profile.json")]);
  const { map } = await buildMap({ root, config: { schemaVersion: 1 }, cache: "off" });
  scaffold(root, PROFILE, map);
  const draft = path.join(root, ".plumb/cache/draft/verify-fixture");
  for (const rel of ["SKILL.md", "features/README.md"]) writeFileSync(path.join(draft, rel), readFileSync(path.join(draft, rel), "utf8").replaceAll(/\{\{fill:[^}]*\}\}/g, "Filled."));
  writeFileSync(path.join(root, ".plumb/bin/doctor"), readFileSync(path.join(root, ".plumb/bin/doctor"), "utf8").replaceAll(/\{\{fill:[^}]*\}\}/g, "# none"));
  writeFileSync(path.join(draft, "features/orders.md"), "# Place an order\n\nA signed-in user buys a product.\n\n## Sub-features\n\n- `place` creates an order\n\n## How to get to it (user POV)\n\n- Endpoint `POST /orders`\n\n## Driving it with curl\n\nPreconditions: launched.\n\n- Place: `curl -X POST $URL_API/orders` returns 200.\n\n## Gotchas\n\nNone known yet.\n");
  expect(publishDraft(root, PROFILE, map, listFiles(root)).issues).toEqual([]);
  expect((await run(["gate", "--regenerate", "--cwd", root])).code).toBe(0);
  commit(root, {}, "plumb init");
  return root;
}

describe("plumb init", () => {
  it("on a fresh repo maps it and points at /plumb-init", async () => {
    const root = makeProject({ "package.json": JSON.stringify({ name: "fx" }), "src/a.js": "1" });
    const result = await run(["init", "--cwd", root]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Next, in Claude Code: /plumb-init");
    expect(existsSync(path.join(root, ".plumb/map/manifest.json"))).toBe(true);
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("# plumb:managed:start gitignore");
  });

  it("--refresh changes nothing when nothing changed, and never overwrites a managed region edited by hand", async () => {
    const root = await initialized();
    const first = await run(["init", "--refresh", "--no-hooks", "--cwd", root]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(git(root, "status", "--porcelain")).toBe("");

    // A profile change regenerates untouched regions in place.
    const profile = { ...PROFILE, checks: { ...PROFILE.checks, lint: { cmd: "node -e 1", cwd: ".", timeoutSec: 30 } } };
    writeFileSync(path.join(root, ".plumb/profile.json"), JSON.stringify(profile));
    expect((await run(["init", "--refresh", "--no-hooks", "--cwd", root])).code).toBe(0);
    expect(readFileSync(path.join(root, ".plumb/gate.sh"), "utf8")).toContain("'node -e 1'");

    // Someone edits inside the managed launch region of the published skill.
    const skill = path.join(root, ".claude/skills/verify-fixture/SKILL.md");
    const edited = readFileSync(skill, "utf8").replace("Run targets, started in this order", "Run targets (hand-edited), started in this order");
    writeFileSync(skill, edited);
    writeFileSync(path.join(root, ".plumb/profile.json"), JSON.stringify({ ...profile, run: [{ ...PROFILE.run[0], start: { cmd: "node src/main.js", cwd: ".", timeoutSec: 20 } }] }));
    const conflicted = await run(["init", "--refresh", "--no-hooks", "--cwd", root]);
    expect(conflicted.code).toBe(1);
    expect(conflicted.stdout).toContain(".claude/skills/verify-fixture/SKILL.md has a managed region edited by hand");
    expect(readFileSync(skill, "utf8")).toBe(edited);
    expect(readFileSync(`${skill}.plumb-new`, "utf8")).toContain("`node src/main.js`");

    const status = await run(["status", "--json", "--cwd", root]);
    expect(JSON.parse(status.stdout)).toMatchObject({ initialized: true, skill: ".claude/skills/verify-fixture", conflicts: [".claude/skills/verify-fixture/SKILL.md.plumb-new"] });
  }, 30_000);
});

describe("plumb status and doctor", () => {
  it("reports the setup and checks Plumb's own files", async () => {
    const root = await initialized();
    const status = await run(["status", "--cwd", root]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("plumb: initialized");
    expect(status.stdout).toContain("skill      .claude/skills/verify-fixture");
    expect(status.stdout).toContain("hooks      not installed");

    expect((await run(["doctor", "--cwd", root])).code).toBe(0);
    writeFileSync(path.join(root, ".plumb/features.json"), JSON.stringify({ features: [{ id: "Bad Id" }] }));
    const doctor = await run(["doctor", "--json", "--cwd", root]);
    expect(doctor.code).toBe(1);
    expect((JSON.parse(doctor.stdout) as { checks: Array<{ name: string; ok: boolean }> }).checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([".plumb/features.json"]);
  }, 30_000);
});

describe("plumb pr", () => {
  it("plans exactly the deep features the branch touches, and checks a run against them", async () => {
    const root = await initialized();
    git(root, "branch", "-M", "main");
    git(root, "checkout", "-q", "-b", "feature");
    commit(root, { "src/orders/place.js": "2" }, "change orders");
    const plan = await run(["pr", "main", "--json", "--cwd", root]);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ changedFiles: 1, drive: [{ id: "orders", recipe: ".claude/skills/verify-fixture/features/orders.md" }] });

    const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
    const dir = path.join(root, ".plumb/evidence/run-pr");
    mkdirSync(path.join(dir, "orders"), { recursive: true });
    writeFileSync(path.join(dir, "orders/response.txt"), "HTTP/1.1 200");
    writeFileSync(path.join(dir, "report.md"), "# run\n");
    writeFileSync(path.join(dir, "run.json"), JSON.stringify({ schemaVersion: 1, runId: "run-pr", tree, cleanedUpAt: "2026-10-19T00:00:00Z" }));
    writeFileSync(path.join(dir, "report.json"), JSON.stringify({ schemaVersion: 1, runId: "run-pr", tree, features: [{ id: "orders", subFeatures: [{ id: "place", status: "verified", entryPoint: "POST /orders", artifacts: ["orders/response.txt"], observed: "200" }] }] }));
    const verified = await run(["pr", "main", "--run", "run-pr", "--cwd", root]);
    expect(verified.stdout).toContain("✓ PR verified: orders");
    expect(verified.code).toBe(0);
    expect(readFileSync(path.join(dir, "pr-report.md"), "utf8")).toContain("- `place` **verified** via POST /orders: 200 [`orders/response.txt`]");

    writeFileSync(path.join(dir, "report.json"), JSON.stringify({ schemaVersion: 1, runId: "run-pr", tree, features: [{ id: "orders", subFeatures: [{ id: "place", status: "failed", entryPoint: "POST /orders", artifacts: ["orders/response.txt"], observed: "500" }] }] }));
    const failed = await run(["pr", "main", "--run", "run-pr", "--cwd", root]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("orders/place failed: 500");
  }, 30_000);
});

describe("verify --edit and --publish", () => {
  it("edits the published skill through a draft, and refuses to publish over a skill changed meanwhile", async () => {
    const root = await initialized();
    const { map } = await buildMap({ root, config: { schemaVersion: 1 }, cache: "off" });
    const draft = editSkill(root, "fixture");
    const feature = path.join(root, draft, "features/orders.md");
    writeFileSync(feature, readFileSync(feature, "utf8").replace("None known yet.", "Orders are rate limited to 5 a minute."));
    expect(publishDraft(root, PROFILE, map, listFiles(root))).toEqual({ published: ".claude/skills/verify-fixture", issues: [] });
    expect(readFileSync(path.join(root, ".claude/skills/verify-fixture/features/orders.md"), "utf8")).toContain("rate limited");
    expect(existsSync(path.join(root, ".claude/skills/verify-fixture/.plumb-edit-base"))).toBe(false);

    editSkill(root, "fixture");
    writeFileSync(path.join(root, ".claude/skills/verify-fixture/features/README.md"), "changed by someone else\n");
    expect(() => publishDraft(root, PROFILE, map, listFiles(root))).toThrow(/changed since plumb verify --edit/);
  }, 30_000);
});
