import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const created: string[] = [];

// After the file, not each test: a clone made in beforeAll must survive across its tests.
afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

/** Commits everything in dir as the first commit of a fresh repository. */
export function gitInit(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

/** A throwaway git repository holding `files`; removed after the test file. */
export function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plumb-test-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  gitInit(dir);
  return dir;
}

export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plumb-test-"));
  created.push(dir);
  return dir;
}

const EXAMPLE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../examples/node-web");

/**
 * A committed copy of examples/node-web that depcruise can resolve in. The root node_modules (pnpm's store) is
 * symlinked rather than copied; per-package node_modules hold relative symlinks and are copied as links, so
 * workspace links resolve inside the copy. The gitignored Prisma client is copied because db imports it.
 */
export function cloneExample(): string {
  const dir = tempDir();
  const skip = /(^|\/)(node_modules|\.plumb-golden|\.plumb|\.next|\.env|test-results|playwright-report)$/;
  cpSync(EXAMPLE, dir, { recursive: true, verbatimSymlinks: true, filter: (src) => !skip.test(path.relative(EXAMPLE, src)) });
  symlinkSync(path.join(EXAMPLE, "node_modules"), path.join(dir, "node_modules"));
  for (const pkg of ["apps/api", "apps/web", "packages/db"]) {
    cpSync(path.join(EXAMPLE, pkg, "node_modules"), path.join(dir, pkg, "node_modules"), { recursive: true, verbatimSymlinks: true });
  }
  gitInit(dir);
  return dir;
}

/** Writes files and commits them, like a developer's next commit. */
export function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  execFileSync("git", ["-c", "commit.gpgsign=false", "add", "-A"], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
}
