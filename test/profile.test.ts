import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkKnowledge } from "../src/knowledge/validate.ts";
import { buildMap } from "../src/map/build.ts";
import type { RepoMap } from "../src/map/types.ts";
import { checkCommand, tokenize } from "../src/profile/commands.ts";
import { isAnswered, loadLocal, setUnknown } from "../src/profile/local.ts";
import { selectStrategy } from "../src/profile/strategy.ts";
import type { Profile } from "../src/profile/types.ts";
import { checkProfile, lockfileIssue } from "../src/profile/validate.ts";
import { verifyProfile } from "../src/profile/verify.ts";
import { makeProject } from "./helpers/project.ts";

const pkg = (name: string, scripts: Record<string, string> = {}): string => JSON.stringify({ name, scripts });

function baseProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    schemaVersion: 1,
    app: { name: "Fixture", slug: "fixture" },
    strategy: "library-cli",
    packageManager: "pnpm",
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

const cmd = (c: string, timeoutSec = 20): { cmd: string; cwd: string; timeoutSec: number } => ({ cmd: c, cwd: ".", timeoutSec });

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => { resolve(typeof address === "object" && address !== null ? address.port : 0); });
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("command checks", () => {
  const root = makeProject({
    "package.json": pkg("repo", { test: "vitest", dev: "x" }),
    "apps/api/package.json": pkg("@x/api", { start: "node server.js" }),
    "apps/web/package.json": pkg("@x/web", { dev: "next dev" }),
    "apps/api/node_modules/.bin/vitest": "#!/bin/sh\n",
    "compose.override.yml": "services:\n  mailpit:\n    image: axllent/mailpit\n",
    "docker-compose.yml": "services:\n  postgres:\n    image: postgres\n",
    "scripts/seed.js": "",
  });
  execFileSync("chmod", ["+x", path.join(root, "apps/api/node_modules/.bin/vitest")]);
  const files = ["package.json", "apps/api/package.json", "apps/web/package.json", "docker-compose.yml", "compose.override.yml", "scripts/seed.js"];
  const issues = (c: string, cwd = "."): string[] => checkCommand(root, files, c, cwd);

  it("splits segments and respects quotes", () => {
    expect(tokenize(`FOO=1 pnpm test && echo "a && b" | wc -l; true`)).toEqual([["FOO=1", "pnpm", "test"], ["echo", "a && b"], ["wc", "-l"], ["true"]]);
  });

  it.each([
    "pnpm test",
    "pnpm run dev",
    "FOO=1 pnpm test",
    "pnpm --filter @x/api start",
    "pnpm --filter ./apps/api start",
    "pnpm -r start",
    "pnpm install --frozen-lockfile",
    "npm test",
    "docker compose up -d --wait postgres",
    "docker compose -f docker-compose.yml stop postgres",
    "node scripts/seed.js",
    "cd apps && pnpm test",
    "npx playwright test",
    "pnpm --filter @x/api vitest related {files} --run",
    "cd apps/web && pnpm dev",
    "yarn workspace @x/web dev",
    "npm run dev --workspace=apps/web",
    "npm run dev -w @x/web",
    "pnpm --filter web... build",
    "pnpm test 2>&1",
    "(cd apps/web && pnpm dev)",
    "docker compose run -e FOO=1 --rm postgres psql",
    "docker compose up -d mailpit",
  ])("accepts %s", (c) => {
    expect(issues(c)).toEqual([]);
  });

  it.each([
    ["pnpm lint", '"lint" is neither a script in ./package.json nor a local binary'],
    ["pnpm --filter @x/admin dev", "no workspace package matches @x/admin"],
    ["cd apps/api && pnpm dev", '"dev" is neither a script in apps/api/package.json nor a local binary'],
    ["pnpm -w lint", '"lint" is neither a script in ./package.json nor a local binary'],
    ["npm deploy-all", "`npm deploy-all` is not an npm command; did you mean `npm run deploy-all`?"],
    ["docker compose up -d redis", 'compose service "redis" is not defined'],
    ["node scripts/missing.js", "scripts/missing.js does not exist"],
    ["definitely-not-a-plumb-tool --x", "`definitely-not-a-plumb-tool` is not on PATH or in node_modules/.bin"],
  ])("rejects %s", (c, message) => {
    expect(issues(c)).toEqual([message]);
  });

  it("allows untracked build output only when the profile builds", () => {
    expect(checkCommand(root, files, "node dist/server.js", ".")).toEqual(["dist/server.js does not exist"]);
    expect(checkCommand(root, files, "node dist/server.js", ".", { hasBuild: true })).toEqual([]);
  });

  it("rejects a missing or escaping cwd", () => {
    expect(issues("pnpm test", "nope")).toEqual(['cwd "nope" is not a directory']);
    expect(issues("pnpm test", "../..")).toEqual(['cwd "../.." is outside the project']);
  });
});

describe("install commands and lockfiles", () => {
  it("flags installs that can rewrite a tracked lockfile, and accepts the frozen forms", () => {
    expect(lockfileIssue("npm install", ".", ["package-lock.json"])).toBe("can rewrite the tracked package-lock.json; use npm ci");
    expect(lockfileIssue("npm ci --include=dev", ".", ["package-lock.json"])).toBeNull();
    expect(lockfileIssue("pnpm install", ".", ["pnpm-lock.yaml"])).toMatch(/frozen-lockfile/);
    expect(lockfileIssue("pnpm install --frozen-lockfile", ".", ["pnpm-lock.yaml"])).toBeNull();
    expect(lockfileIssue("yarn", "app", ["app/yarn.lock"])).toMatch(/immutable/);
    expect(lockfileIssue("yarn install --immutable", "app", ["app/yarn.lock"])).toBeNull();
    expect(lockfileIssue("npm install", ".", [])).toBeNull();
  });
});

describe("strategy selection", () => {
  const map = (roots: string[], http = false): RepoMap => ({
    manifest: { schemaVersion: 1, builtAtCommit: "0".repeat(40), extractors: {}, components: [], unassignedFiles: [], extractorFailures: [] },
    components: roots.map((root) => ({
      id: `component:${path.basename(root)}`,
      kind: "app",
      root,
      include: [`${root}/**`],
      language: [],
      framework: [],
      files: {},
      entryPoints: http ? [{ id: "entry:http:GET /x", kind: "http", location: { file: `${root}/a.ts`, line: 1 }, provenance: { source: "extracted", extractor: "express-routes" } }] : [],
      exports: [],
      edges: [],
      state: [],
      summaryStatus: "missing",
    })),
    resources: { resources: [] },
  });
  const root = makeProject({ "a/package.json": pkg("a", { test: "x" }), "b/package.json": pkg("b", { build: "x" }), "c/package.json": pkg("c") });
  const noUi = { ui: baseProfile().ui };
  const ui = { ui: { ...baseProfile().ui, present: true } };

  it("follows doc 4's table in order", () => {
    expect(selectStrategy(root, ui, map(["a", "b"]), { schemaVersion: 1 }).strategy).toBe("monorepo");
    expect(selectStrategy(root, ui, map(["a", "c"]), { schemaVersion: 1 }).strategy).toBe("web-app");
    expect(selectStrategy(root, noUi, map(["c"], true), { schemaVersion: 1 }).strategy).toBe("api-backend");
    expect(selectStrategy(root, noUi, map(["c"]), { schemaVersion: 1 }).strategy).toBe("library-cli");
    expect(selectStrategy(root, ui, map(["a", "b"]), { schemaVersion: 1, strategy: "web-app" })).toEqual({ strategy: "web-app", reason: "set in .plumb/config.json" });
  });
});

describe("profile validation", () => {
  it("reports unrunnable commands at their JSON paths and the derived strategy", async () => {
    const root = makeProject({ "package.json": pkg("tool", { test: "vitest" }), "src/index.ts": "export const x = 1;" });
    const { map } = await buildMap({ root, cache: "off" });
    const profile = baseProfile({ strategy: "web-app", checks: { ...baseProfile().checks, lint: cmd("pnpm lint"), unit: { ...cmd("pnpm test"), scoped: "pnpm vitest-related {files}" } } });
    const check = checkProfile(root, ["package.json", "src/index.ts"], profile, map, { schemaVersion: 1 });
    expect(check.issues).toEqual([
      { path: "/checks/lint/cmd", message: '"lint" is neither a script in ./package.json nor a local binary' },
      { path: "/checks/unit/scoped", message: '"vitest-related" is neither a script in ./package.json nor a local binary' },
      { path: "/strategy", message: 'must be "library-cli" (no UI and no HTTP entry points)' },
    ]);
  });
});

describe("profile validation rules the schema can't express", () => {
  it("requires a readiness probe on a stoppable service and a valid log regex", async () => {
    const root = makeProject({ "package.json": pkg("tool"), "src/index.ts": "export const x = 1;" });
    const { map } = await buildMap({ root, cache: "off" });
    const profile = baseProfile({
      services: [{ name: "db", source: "local", start: cmd("true"), stop: cmd("true"), ready: null }],
      run: [{ name: "web", start: cmd("true"), ready: { kind: "log", pattern: "Ready (in" }, stop: "signal", port: null, portEnv: null }],
    });
    const paths = checkProfile(root, ["package.json", "src/index.ts"], profile, map, { schemaVersion: 1 }).issues.map((i) => i.path);
    expect(paths).toEqual(["/run/0/ready/pattern", "/services/0/ready"]);
  });
});

describe("local.json", () => {
  it("stores answers where their ids say, never in a tracked file, and adds Plumb's gitignore block once", () => {
    const root = makeProject({ "package.json": pkg("tool"), ".gitignore": "node_modules/\n" });
    setUnknown(root, "env.STRIPE_KEY", "sk_test_1");
    setUnknown(root, "service.redis.skip", "true");
    setUnknown(root, "note.staging", "use the sandbox");
    expect(loadLocal(root)).toEqual({ env: { STRIPE_KEY: "sk_test_1" }, services: { redis: { skip: true } }, notes: ["note.staging: use the sandbox"] });
    const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(gitignore.match(/plumb:managed:start gitignore/g)).toHaveLength(1);
    expect(gitignore.startsWith("node_modules/\n")).toBe(true);
    expect(execFileSync("git", ["check-ignore", ".plumb/local.json"], { cwd: root, encoding: "utf8" }).trim()).toBe(".plumb/local.json");

    expect(isAnswered(loadLocal(root), { id: "env.STRIPE_KEY", question: "q", why: "w", storesIn: "local.json" })).toBe(true);
    expect(isAnswered(loadLocal(root), { id: "env.OTHER", question: "q", why: "w", storesIn: "local.json" })).toBe(false);
    expect(() => setUnknown(root, "stripe", "x")).toThrow("is not an unknown id");
    expect(() => setUnknown(root, "service.redis.skip", "maybe")).toThrow("takes true or false");
  });

  it("refuses to write secrets into a tracked local.json", () => {
    const root = makeProject({ "package.json": pkg("tool"), ".plumb/local.json": JSON.stringify({ env: {}, services: {}, notes: [] }) });
    expect(() => setUnknown(root, "env.KEY", "secret")).toThrow("is tracked by git");
  });
});

describe("knowledge validation", () => {
  it("rejects evidence that cites files or lines that don't exist", () => {
    const root = makeProject({ "package.json": pkg("tool"), "src/a.ts": "one\ntwo\n" });
    mkdirSync(path.join(root, ".plumb/knowledge"), { recursive: true });
    const risk = {
      schemaVersion: 1,
      agent: "explorer-risk",
      features: [{ id: "a", title: "A", why: "w", rank: 1, entryPoints: [], paths: ["src/**"], evidence: [{ file: "src/a.ts", line: 2 }, { file: "src/a.ts", line: 99 }] }],
      riskyResources: [{ id: "x", why: "w", evidence: [{ file: "src/gone.ts", line: 1 }] }],
      integrations: [],
      unknowns: [],
    };
    writeFileSync(path.join(root, ".plumb/knowledge/risk.json"), JSON.stringify(risk));
    expect(checkKnowledge(root, "risk").issues).toEqual([
      { path: "/features/0/evidence/1", message: "cites src/a.ts:99, but the file has 3 lines" },
      { path: "/riskyResources/0/evidence/0", message: "cites src/gone.ts, which doesn't exist" },
    ]);
    expect(checkKnowledge(root, "tests")).toEqual({ exists: false, issues: [{ path: "/", message: ".plumb/knowledge/tests.json is missing" }] });
  });
});

describe("profile verify", () => {
  // A server that spawns a grandchild, records its pid, and logs once it listens: teardown must kill both.
  const SERVER = `
const http = require("node:http");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync("grandchild.pid", String(child.pid));
require("node:fs").writeFileSync("server.pid", String(process.pid));
http.createServer((req, res) => { res.statusCode = req.url === "/health" ? 200 : 404; res.end("ok"); })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening on " + process.env.PORT));
`;

  it("boots a run target, then tears down its whole process group and keeps the logs", async () => {
    const port = await freePort();
    const root = makeProject({ "package.json": pkg("svc"), "server.js": SERVER });
    const profile = baseProfile({
      install: cmd("node -e \"console.log('installed')\""),
      checks: { ...baseProfile().checks, typecheck: cmd("node -e \"process.exit(0)\"") },
      env: [{ name: "PORT", required: true, secret: false, defaultForVerification: String(port), source: "env-example" }],
      run: [{ name: "web", start: cmd("node server.js"), ready: { kind: "http", url: `http://127.0.0.1:${String(port)}/health`, expectStatus: 200 }, stop: "signal", port, portEnv: "PORT" }],
    });
    const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.step, s.status])).toEqual([["install", "passed"], ["typecheck", "passed"], ["run-web", "passed"]]);
    expect(result.teardown).toEqual(["stopped web"]);
    const grandchild = Number(readFileSync(path.join(root, "grandchild.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(grandchild)).toBe(false);
    expect(readFileSync(path.join(root, result.evidenceDir, "run-web.log"), "utf8")).toContain(`listening on ${String(port)}`);
  }, 30_000);

  it("reports a target that dies before it is ready, with its last output, and still tears down", async () => {
    const root = makeProject({ "package.json": pkg("svc"), "bad.js": 'console.error("Error: Cannot find module ./serverX.ts"); process.exit(3);' });
    const port = await freePort();
    const profile = baseProfile({
      run: [{ name: "api", start: cmd("node bad.js"), ready: { kind: "port", port }, stop: "signal", port, portEnv: null }],
    });
    const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] }, { bootOnly: true });
    expect(result.ok).toBe(false);
    const failed = result.steps.at(-1);
    expect(failed).toMatchObject({ step: "run-api", status: "failed", detail: "exited with code 3 before it was ready" });
    expect(failed?.tail).toContain("Error: Cannot find module ./serverX.ts");
  }, 30_000);

  it("stops at the first failing step and doesn't run the rest", async () => {
    const root = makeProject({ "package.json": pkg("svc") });
    const profile = baseProfile({
      checks: { ...baseProfile().checks, lint: cmd('node -e "process.exit(2)"'), typecheck: cmd("node -e \"require('fs').writeFileSync('ran','')\"") },
    });
    const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] });
    expect(result.steps.map((s) => [s.step, s.status, s.detail])).toEqual([["lint", "failed", "exited with code 2"]]);
    expect(existsSync(path.join(root, "ran"))).toBe(false);
  });

  it("times out a hung command", async () => {
    const root = makeProject({ "package.json": pkg("svc") });
    const profile = baseProfile({ install: cmd('node -e "setInterval(() => {}, 1000)"', 1) });
    const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] });
    expect(result.steps[0]).toMatchObject({ step: "install", status: "failed", detail: "timed out after 1s" });
  }, 15_000);

  it("refuses a port someone else holds, and never stops a service it didn't start", async () => {
    const root = makeProject({ "package.json": pkg("svc"), "server.js": SERVER });
    const held = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => held.once("listening", r));
    const port = (held.address() as net.AddressInfo).port;
    try {
      const profile = baseProfile({
        services: [{ name: "db", source: "local", start: cmd("node -e \"require('fs').writeFileSync('started','')\""), stop: cmd("node -e \"require('fs').writeFileSync('stopped','')\""), ready: { kind: "port", port } }],
        run: [{ name: "web", start: cmd("node server.js"), ready: { kind: "port", port }, stop: "signal", port, portEnv: null }],
      });
      const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] }, { bootOnly: true });
      expect(result.steps.map((s) => [s.step, s.status, s.detail])).toEqual([
        ["service-db", "passed", "already running; not started or stopped by Plumb"],
        ["run-web", "failed", `port ${String(port)} is already in use by another process; stop it and retry`],
      ]);
      expect(existsSync(path.join(root, "started")) || existsSync(path.join(root, "stopped"))).toBe(false);
    } finally {
      held.close();
    }
  }, 15_000);

  it("tears down a service whose start failed halfway", async () => {
    const root = makeProject({ "package.json": pkg("svc") });
    const port = await freePort();
    const profile = baseProfile({
      services: [{ name: "db", source: "local", start: cmd('node -e "process.exit(1)"'), stop: cmd("node -e \"require('fs').writeFileSync('stopped','')\""), ready: { kind: "port", port } }],
    });
    const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] }, { bootOnly: true });
    expect(result.ok).toBe(false);
    expect(result.teardown).toEqual(["stopped db"]);
    expect(existsSync(path.join(root, "stopped"))).toBe(true);
  }, 15_000);

  it("uses a local.json start command when the profile has none, without printing it", async () => {
    const root = makeProject({ "package.json": pkg("svc"), "server.js": SERVER });
    const port = await freePort();
    const profile = baseProfile({ services: [{ name: "db", source: "external", start: null, stop: null, ready: { kind: "port", port } }] });
    const local = { env: { PORT: String(port) }, services: { db: { start: "node server.js > /dev/null 2>&1 &" } }, notes: [] };
    try {
      const result = await verifyProfile(root, profile, local, { bootOnly: true });
      expect(result.steps[0]).toMatchObject({ step: "service-db", status: "passed", command: "<command from .plumb/local.json>" });
      // With no stop command, Plumb leaves the service running by design; the test cleans up after it.
      expect(result.teardown).toEqual(["left db running: the profile has no stop command for it"]);
    } finally {
      for (const file of ["server.pid", "grandchild.pid"]) {
        if (existsSync(path.join(root, file))) process.kill(Number(readFileSync(path.join(root, file), "utf8")));
      }
    }
  }, 15_000);

  it("refuses a run target whose readiness probe already answers before it starts", async () => {
    const root = makeProject({ "package.json": pkg("svc"), "server.js": SERVER });
    const held = net.createServer().listen(0, "::1");
    await new Promise((r) => held.once("listening", r));
    const port = (held.address() as net.AddressInfo).port;
    try {
      const profile = baseProfile({ run: [{ name: "web", start: cmd("node server.js"), ready: { kind: "port", port }, stop: "signal", port: null, portEnv: null }] });
      const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] }, { bootOnly: true });
      expect(result.steps[0]).toMatchObject({ status: "failed", detail: "something already answers its readiness probe before Plumb started it; stop it and retry" });
    } finally {
      held.close();
    }
  }, 15_000);

  it("kills what a check step leaves running in its process group", async () => {
    const root = makeProject({ "package.json": pkg("svc") });
    const stray = "node -e \"require('fs').writeFileSync('stray.pid', String(process.pid)); setInterval(() => {}, 1000)\" > /dev/null 2>&1 & sleep 0.5";
    const profile = baseProfile({ checks: { ...baseProfile().checks, lint: cmd(stray) } });
    const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] });
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(Number(readFileSync(path.join(root, "stray.pid"), "utf8")))).toBe(false);
  }, 15_000);

  it("redacts local.json values from failure output", async () => {
    const root = makeProject({ "package.json": pkg("svc") });
    const profile = baseProfile({ checks: { ...baseProfile().checks, lint: cmd('node -e "console.error(\'auth failed for \' + process.env.API_TOKEN); process.exit(1)"') } });
    const result = await verifyProfile(root, profile, { env: { API_TOKEN: "sk_live_supersecret" }, services: {}, notes: [] });
    expect(JSON.stringify(result.steps)).not.toContain("sk_live_supersecret");
    expect(result.steps[0]?.tail).toContain("auth failed for <redacted>");
  });

  it("waits for a log line when that is the readiness signal", async () => {
    const root = makeProject({ "package.json": pkg("svc"), "slow.js": 'setTimeout(() => console.log("Ready in 12ms"), 300); setInterval(() => {}, 1000);' });
    const profile = baseProfile({ run: [{ name: "web", start: cmd("node slow.js"), ready: { kind: "log", pattern: "Ready in" }, stop: "signal", port: null, portEnv: null }] });
    const result = await verifyProfile(root, profile, { env: {}, services: {}, notes: [] }, { bootOnly: true });
    expect(result.ok).toBe(true);
  }, 15_000);
});
