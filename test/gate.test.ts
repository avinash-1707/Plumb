import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderGate } from "../src/gate/script.ts";
import { claudePreCommit, findCommits } from "../src/hooks/claude.ts";
import { detectHookSetup, installHooks, uninstallHooks } from "../src/hooks/install.ts";
import { editedRegions, refreshManagedFile, replaceRegions } from "../src/managed/regions.ts";
import { matchGlob } from "../src/glob.ts";
import type { Profile } from "../src/profile/types.ts";
import { makeProject } from "./helpers/project.ts";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
const commit = (cwd: string, ...extra: string[]): { status: number | null; output: string } => {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "change", ...extra], { cwd, env: GIT_ENV, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
};

const cmd = (c: string): { cmd: string; cwd: string; timeoutSec: number } => ({ cmd: c, cwd: ".", timeoutSec: 30 });
function profileWith(checks: Partial<Profile["checks"]>): Profile {
  return {
    schemaVersion: 1, app: { name: "Fixture", slug: "fixture" }, strategy: "library-cli", packageManager: "npm", install: null, build: null,
    checks: { lint: null, typecheck: null, unit: null, integration: null, e2e: null, ...checks },
    run: [], services: [], env: [], ui: { present: false, framework: null, baseUrl: null, harness: null, authRequired: false }, unknowns: [], evidence: {},
  };
}

// Each check appends its name to runs.log, so a test can count how often the fast tier ran.
const COUNT = (name: string): string => `echo ${name} >> runs.log`;

function projectWithGate(checks: Partial<Profile["checks"]>, files: Record<string, string> = {}): string {
  const root = makeProject({ "src/app.js": "1", "README.md": "# app", ".gitignore": ".plumb/stamps/\n.plumb/evidence/\n.plumb/cache/\nruns.log\n", ...files });
  mkdirSync(path.join(root, ".plumb"), { recursive: true });
  writeFileSync(path.join(root, ".plumb/gate.sh"), renderGate(profileWith(checks), { schemaVersion: 1, ignore: ["fixtures/**"] }, false));
  chmodSync(path.join(root, ".plumb/gate.sh"), 0o755);
  return root;
}

const runs = (root: string): string[] => (existsSync(path.join(root, "runs.log")) ? readFileSync(path.join(root, "runs.log"), "utf8").trim().split("\n") : []);
const gate = (root: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync("sh", [".plumb/gate.sh"], { cwd: root, env: { ...process.env, ...env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("gate.sh", () => {
  it("runs the fast checks once per staged tree and stamps it", () => {
    const root = projectWithGate({ lint: cmd(COUNT("lint")), typecheck: cmd(COUNT("typecheck")), unit: { ...cmd("true"), scoped: `${COUNT("unit")} && echo {files} > scoped.txt` } });
    writeFileSync(path.join(root, "src/app.js"), "2");
    git(root, "add", "src/app.js");
    const first = gate(root);
    expect(first.status).toBe(0);
    expect(runs(root)).toEqual(["lint", "typecheck", "unit"]);
    expect(readFileSync(path.join(root, "scoped.txt"), "utf8").trim()).toBe(path.join(realpathSync(root), "src/app.js"));
    const second = gate(root);
    expect(second.stdout).toContain("already passed");
    expect(runs(root)).toEqual(["lint", "typecheck", "unit"]);
  });

  it("passes staged paths to the scoped command as single words, and checks deletion-only commits", () => {
    const root = projectWithGate({ lint: cmd(COUNT("lint")), unit: { ...cmd("true"), scoped: "node -e 'console.log(JSON.stringify(process.argv.slice(1)))' {files} > scoped.json" } }, {
      "app/(shop)/$(touch pwned).tsx": "1",
      "src/old.js": "1",
    });
    writeFileSync(path.join(root, "app/(shop)/$(touch pwned).tsx"), "2");
    git(root, "add", "-A");
    expect(gate(root).status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, "scoped.json"), "utf8"))).toEqual([path.join(realpathSync(root), "app/(shop)/$(touch pwned).tsx")]);
    expect(existsSync(path.join(root, "pwned"))).toBe(false);

    git(root, "commit", "-q", "-m", "x");
    git(root, "rm", "-q", "src/old.js");
    gate(root);
    expect(runs(root)).toEqual(["lint", "lint"]);
  });

  it("blocks with the standard failure report and keeps the log", () => {
    const root = projectWithGate({ typecheck: cmd("echo \"src/app.js:1:1 - error TS2322: Type 'string' is not assignable to type 'number'.\"; exit 2") });
    writeFileSync(path.join(root, "src/app.js"), "2");
    git(root, "add", "src/app.js");
    const result = gate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ plumb gate failed: typecheck");
    expect(result.stderr).toMatch(/step {5}typecheck \(echo/);
    expect(result.stderr).toContain("scope    whole project");
    expect(result.stderr).toMatch(/log {6}\.plumb\/evidence\/gate-[0-9a-f]{40}\/typecheck\.log/);
    expect(result.stderr).toContain("error TS2322");
    expect(result.stderr).toContain("bypass (not recommended): git commit --no-verify");
    expect(readdir(path.join(root, ".plumb/stamps"))).toEqual([]);
  });

  it("skips checks for docs-only and ignored files, and dry-runs without running or stamping", () => {
    const root = projectWithGate({ lint: cmd(COUNT("lint")) });
    writeFileSync(path.join(root, "README.md"), "# changed");
    mkdirSync(path.join(root, "fixtures"));
    writeFileSync(path.join(root, "fixtures/data.json"), "{}");
    git(root, "add", "-A");
    expect(gate(root).stdout).toContain("only docs or ignored files");
    expect(runs(root)).toEqual([]);

    writeFileSync(path.join(root, "src/app.js"), "3");
    git(root, "add", "src/app.js");
    const dry = gate(root, { PLUMB_DRY_RUN: "1" });
    expect(dry.stdout).toContain("would run  lint: echo lint >> runs.log");
    expect(runs(root)).toEqual([]);
  });

  it("regenerates managed regions and keeps the user's own checks", () => {
    const first = renderGate(profileWith({ lint: cmd("eslint .") }), { schemaVersion: 1 }, false);
    const edited = first.replace("# User checks below this line are preserved across regeneration.", "# User checks below this line are preserved across regeneration.\n./scripts/license-check.sh");
    const next = replaceRegions(edited, renderGate(profileWith({ lint: cmd("biome check") }), { schemaVersion: 1 }, false));
    expect(next).toContain("./scripts/license-check.sh");
    expect(next).toContain("'biome check'");
    expect(next).not.toContain("eslint");
  });
});

function readdir(dir: string): string[] {
  return existsSync(dir) ? execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter((f) => f !== "") : [];
}

function snapshot(paths: string[]): Record<string, { content: string; mode: number } | null> {
  return Object.fromEntries(paths.map((p) => [p, existsSync(p) ? { content: readFileSync(p).toString("base64"), mode: statSync(p).mode } : null]));
}

describe("hook installation matrix", () => {
  // A gate that records it ran and fails while a FAIL file exists.
  const GATE = 'echo gate >> "$(git rev-parse --show-toplevel)/ran.log"; [ ! -f FAIL ]\n';
  const ORIGINAL = '#!/bin/sh\necho original >> "$(git rev-parse --show-toplevel)/ran.log"\n';

  function repo(files: Record<string, string> = {}): string {
    const root = makeProject({ "a.txt": "1", ".gitignore": "ran.log\nFAIL\n.plumb/cache/\n", ...files });
    mkdirSync(path.join(root, ".plumb"), { recursive: true });
    writeFileSync(path.join(root, ".plumb/gate.sh"), GATE);
    return root;
  }
  const ran = (root: string): string[] => (existsSync(path.join(root, "ran.log")) ? readFileSync(path.join(root, "ran.log"), "utf8").trim().split("\n") : []);
  function commitWorks(root: string, expected: string[]): void {
    writeFileSync(path.join(root, "a.txt"), String(Math.random()));
    git(root, "add", "a.txt");
    writeFileSync(path.join(root, "FAIL"), "");
    expect(commit(root).status).not.toBe(0);
    execFileSync("rm", [path.join(root, "FAIL")]);
    writeFileSync(path.join(root, "ran.log"), "");
    expect(commit(root).status).toBe(0);
    expect(ran(root)).toEqual(expected);
  }

  it("no hooks: installs .git/hooks/pre-commit, which gates commits; uninstall removes it", () => {
    const root = repo();
    const hook = path.join(root, ".git/hooks/pre-commit");
    const before = snapshot([hook]);
    expect(detectHookSetup(root).method).toBe("git-hooks");
    installHooks(root);
    commitWorks(root, ["gate"]);
    uninstallHooks(root);
    expect(snapshot([hook])).toEqual(before);
  });

  it("existing .git/hooks/pre-commit: chains it, runs it first, and restores it byte for byte", () => {
    const root = repo();
    const hook = path.join(root, ".git/hooks/pre-commit");
    writeFileSync(hook, ORIGINAL);
    chmodSync(hook, 0o755);
    const before = snapshot([hook, `${hook}.plumb-chained`]);
    expect(detectHookSetup(root).method).toBe("git-hooks-chained");
    installHooks(root);
    commitWorks(root, ["original", "gate"]);
    expect(installHooks(root).installed).toBe(false);
    uninstallHooks(root);
    expect(snapshot([hook, `${hook}.plumb-chained`])).toEqual(before);
  });

  it("core.hooksPath: installs into that directory, chaining what is there", () => {
    const root = repo({ "githooks/pre-commit": ORIGINAL });
    chmodSync(path.join(root, "githooks/pre-commit"), 0o755);
    git(root, "config", "core.hooksPath", "githooks");
    const hook = path.join(root, "githooks/pre-commit");
    const before = snapshot([hook, `${hook}.plumb-chained`]);
    expect(detectHookSetup(root).method).toBe("core.hooksPath");
    installHooks(root);
    commitWorks(root, ["original", "gate"]);
    uninstallHooks(root);
    expect(snapshot([hook, `${hook}.plumb-chained`])).toEqual(before);
  });

  it("husky: appends the gate to .husky/pre-commit inside managed markers", () => {
    const root = repo({ ".husky/pre-commit": 'echo original >> "$(git rev-parse --show-toplevel)/ran.log"\n' });
    chmodSync(path.join(root, ".husky/pre-commit"), 0o755);
    // husky wires itself through core.hooksPath; that must still count as husky, not a plain hooks dir.
    git(root, "config", "core.hooksPath", ".husky");
    const hook = path.join(root, ".husky/pre-commit");
    const before = snapshot([hook]);
    expect(detectHookSetup(root).method).toBe("husky");
    installHooks(root);
    expect(readFileSync(hook, "utf8")).toBe('echo original >> "$(git rev-parse --show-toplevel)/ran.log"\n# plumb:managed:start plumb-gate\nsh .plumb/gate.sh\n# plumb:managed:end plumb-gate\n');
    commitWorks(root, ["original", "gate"]);
    uninstallHooks(root);
    expect(snapshot([hook])).toEqual(before);
  });

  it("husky: a gate already committed by a teammate isn't added twice; uninstall keeps edits made since install", () => {
    const root = repo({ ".husky/pre-commit": "npm test\n" });
    git(root, "config", "core.hooksPath", ".husky");
    const hook = path.join(root, ".husky/pre-commit");
    installHooks(root);
    const installed = readFileSync(hook, "utf8");
    // Another clone: the block is committed, there is no install record.
    execFileSync("rm", [path.join(root, ".plumb/cache/hooks-install.json")]);
    expect(installHooks(root).installed).toBe(false);
    expect(readFileSync(hook, "utf8")).toBe(installed);

    writeFileSync(hook, "npm test\n");
    expect(installHooks(root).installed).toBe(true);
    writeFileSync(hook, `${readFileSync(hook, "utf8")}npm run lint\n`);
    expect(uninstallHooks(root).kept).toEqual([realpathSync(hook)]);
    expect(readFileSync(hook, "utf8")).toBe("npm test\nnpm run lint\n");
  });

  it("lefthook: adds a plumb-gate pre-commit command, keeps the others and comments", () => {
    const original = "# team hooks\npre-commit:\n  parallel: true\n  commands:\n    lint:\n      run: npm run lint # fast\n";
    const root = repo({ "lefthook.yml": original });
    const file = path.join(root, "lefthook.yml");
    expect(detectHookSetup(root).method).toBe("lefthook");
    installHooks(root);
    const edited = readFileSync(file, "utf8");
    expect(edited).toContain("run: npm run lint # fast");
    expect(edited).toContain("# team hooks");
    expect(edited).toContain("plumb-gate:\n      run: sh .plumb/gate.sh");
    uninstallHooks(root);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("pre-commit framework: adds a local plumb-gate hook, keeps existing repos", () => {
    const original = "repos:\n  - repo: https://github.com/pre-commit/pre-commit-hooks\n    rev: v5.0.0\n    hooks:\n      - id: trailing-whitespace\n";
    const root = repo({ ".pre-commit-config.yaml": original });
    const file = path.join(root, ".pre-commit-config.yaml");
    expect(detectHookSetup(root).method).toBe("pre-commit");
    installHooks(root);
    const edited = readFileSync(file, "utf8");
    expect(edited).toContain("id: trailing-whitespace");
    expect(edited).toMatch(/- repo: local\n {4}hooks:\n {6}- id: plumb-gate\n {8}name: plumb gate\n {8}entry: sh \.plumb\/gate\.sh/);
    uninstallHooks(root);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("a project in a subdirectory gates from the repository root", () => {
    const top = makeProject({ "app/a.txt": "1", ".gitignore": "ran.log\nFAIL\napp/.plumb/cache/\n" });
    const root = path.join(top, "app");
    mkdirSync(path.join(root, ".plumb"), { recursive: true });
    writeFileSync(path.join(root, ".plumb/gate.sh"), GATE);
    installHooks(root);
    expect(readFileSync(path.join(top, ".git/hooks/pre-commit"), "utf8")).toContain("exec sh app/.plumb/gate.sh");
  });
});

describe("finding git commits in a Bash command", () => {
  it("sees chained, -C, cd, env-prefixed, and multi-line commits, and their staging flags", () => {
    expect(findCommits("ls", "/r")).toEqual([]);
    expect(findCommits('git add . && git commit -m "feat: x"', "/r")).toEqual([{ cwd: "/r", skip: false, all: false, include: false, pathspecs: [] }]);
    expect(findCommits("git -C sub -c core.x=1 commit -am 'msg'", "/r")).toEqual([{ cwd: "/r/sub", skip: false, all: true, include: false, pathspecs: [] }]);
    expect(findCommits("cd app && PLUMB_SKIP=1 git commit -m x -- src/a.ts", "/r")).toEqual([{ cwd: "/r/app", skip: true, all: false, include: false, pathspecs: ["src/a.ts"] }]);
    expect(findCommits("git status\ngit commit --amend --no-edit -i b.ts", "/r")).toEqual([{ cwd: "/r", skip: false, all: false, include: true, pathspecs: ["b.ts"] }]);
    expect(findCommits('echo "git commit" ; git log', "/r")).toEqual([]);
    expect(findCommits("git commit -F msg.txt 2>&1", "/r")).toEqual([{ cwd: "/r", skip: false, all: false, include: false, pathspecs: [] }]);
    expect(findCommits("git commit -m x 2> /dev/null > log.txt", "/r")).toEqual([{ cwd: "/r", skip: false, all: false, include: false, pathspecs: [] }]);
  });
});

describe("Claude Code pre-commit hook", () => {
  function project(): string {
    const root = projectWithGate({ typecheck: cmd(`${COUNT("typecheck")} && [ ! -f FAIL ]`) }, {
      "src/orders.js": "1",
      ".plumb/features.json": JSON.stringify({ features: [{ id: "orders", file: "features/orders.md", paths: ["src/orders.js"], components: [], entryPoints: [], tier: "deep" }] }),
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "plumb");
    return root;
  }
  const payload = (root: string, command: string): unknown => ({ tool_name: "Bash", tool_input: { command }, cwd: root, hook_event_name: "PreToolUse" });

  it("allows non-commits and commits that touch no deep feature, running the fast tier once per tree", () => {
    const root = project();
    expect(claudePreCommit(payload(root, "pnpm test"))).toEqual({ block: false, reason: "" });
    writeFileSync(path.join(root, "src/app.js"), "2");
    git(root, "add", "src/app.js");
    expect(claudePreCommit(payload(root, "git commit -m x")).block).toBe(false);
    expect(claudePreCommit(payload(root, "git commit -m x")).block).toBe(false);
    // The git hook would run gate.sh too; the stamp makes it a no-op.
    expect(gate(root).stdout).toContain("already passed");
    expect(runs(root)).toEqual(["typecheck"]);
  });

  it("leaves repositories without Plumb alone", () => {
    const root = makeProject({ "a.txt": "1" });
    writeFileSync(path.join(root, "a.txt"), "2");
    git(root, "add", "a.txt");
    expect(claudePreCommit(payload(root, "git commit -am x 2> /dev/null"))).toEqual({ block: false, reason: "" });
  });

  it("blocks a failing fast tier with the gate's report", () => {
    const root = project();
    writeFileSync(path.join(root, "FAIL"), "");
    writeFileSync(path.join(root, "src/app.js"), "2");
    git(root, "add", "src/app.js");
    const decision = claudePreCommit(payload(root, "git commit -m x"));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("✗ plumb gate failed: typecheck");
  });

  it("blocks a deep feature until a deep stamp exists for this exact tree; PLUMB_SKIP is allowed and logged", () => {
    const root = project();
    writeFileSync(path.join(root, "src/orders.js"), "2");
    // -a: the hook must see the change git would stage at commit time.
    const blocked = claudePreCommit(payload(root, "git commit -am x"));
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("Run /plumb-verify orders (the plumb-verify skill), then commit again.");

    git(root, "add", "src/orders.js");
    const tree = git(root, "write-tree").trim();
    mkdirSync(path.join(root, ".plumb/stamps"), { recursive: true });
    writeFileSync(path.join(root, `.plumb/stamps/deep-${tree}`), "{}");
    expect(claudePreCommit(payload(root, "git commit -m x")).block).toBe(false);

    writeFileSync(path.join(root, "src/orders.js"), "3");
    git(root, "add", "src/orders.js");
    expect(claudePreCommit(payload(root, "git commit -m x")).block).toBe(true);
    expect(claudePreCommit(payload(root, "PLUMB_SKIP=1 git commit -m x")).block).toBe(false);
    expect(readFileSync(path.join(root, ".plumb/cache/bypass.log"), "utf8")).toMatch(/\t[0-9a-f]{40}\tPLUMB_SKIP=1 git commit -m x\n$/);
  });
});

describe("managed regions", () => {
  it("replaces untouched regions, and writes .plumb-new instead of overwriting a region edited by hand", () => {
    const dir = makeProject({ "README.md": "x" });
    const file = path.join(dir, "gate.sh");
    const v1 = renderGate(profileWith({ lint: cmd("eslint .") }), { schemaVersion: 1 }, false);
    const v2 = renderGate(profileWith({ lint: cmd("biome check") }), { schemaVersion: 1 }, false);
    expect(refreshManagedFile(file, v1)).toBe("created");
    expect(refreshManagedFile(file, v1)).toBe("unchanged");
    writeFileSync(file, readFileSync(file, "utf8").replace("# User checks below this line are preserved across regeneration.", "# User checks below this line are preserved across regeneration.\n./mine.sh"));
    expect(refreshManagedFile(file, v2)).toBe("updated");
    expect(readFileSync(file, "utf8")).toContain("./mine.sh");
    expect(editedRegions(readFileSync(file, "utf8"))).toEqual([]);

    const handEdited = readFileSync(file, "utf8").replace("'biome check'", "'biome check --write'");
    writeFileSync(file, handEdited);
    expect(editedRegions(handEdited)).toEqual(["checks"]);
    expect(refreshManagedFile(file, v1)).toBe("conflict");
    expect(readFileSync(file, "utf8")).toBe(handEdited);
    expect(readFileSync(`${file}.plumb-new`, "utf8")).toContain("'eslint .'");
  });

  it("treats brackets in Plumb globs as literal route folders", () => {
    expect(matchGlob("apps/web/app/orders/[id]/page.tsx", "apps/web/app/orders/[id]/**")).toBe(true);
    expect(matchGlob("apps/web/app/orders/i/page.tsx", "apps/web/app/orders/[id]/**")).toBe(false);
    expect(matchGlob("apps/web/.env.example", "apps/web/**")).toBe(true);
  });
});
