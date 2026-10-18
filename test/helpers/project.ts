import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(() => {
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

/** A throwaway git repository holding `files`; removed after the test. */
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
