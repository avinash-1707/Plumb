import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

export class GitError extends Error {}

function git(root: string, args: string[], input?: string): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    const stderr = typeof err === "object" && err !== null && "stderr" in err ? String(err.stderr).trim() : "";
    throw new GitError(`git ${args[0] ?? ""} failed in ${root}${stderr === "" ? "" : `: ${stderr}`}`);
  }
}

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

/** HEAD's commit, or null for a repository with no commits yet. */
export function headCommit(root: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

function isRegularFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch (err) {
    // Tracked but deleted in the working tree.
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Tracked plus untracked-but-not-ignored regular files under root, relative to root. Submodules (gitlinks) and
 * symlinks are skipped: hash-object can't hash a directory, and it would hash a symlink's target, not its blob.
 */
export function listFiles(root: string): string[] {
  return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."])
    .split("\0")
    .filter((file) => file !== "" && isRegularFile(path.join(root, file)));
}

/** Git blob SHAs of the working-tree content of each file. */
export function blobShas(root: string, files: readonly string[]): Map<string, string> {
  if (files.length === 0) return new Map();
  // --stdin-paths resolves relative paths from the repository top level, not the cwd, so pass absolute paths.
  const shas = git(root, ["hash-object", "--stdin-paths"], `${files.map((f) => path.join(root, f)).join("\n")}\n`)
    .trim()
    .split("\n");
  if (shas.length !== files.length) throw new GitError(`git hash-object returned ${String(shas.length)} hashes for ${String(files.length)} files`);
  return new Map(files.map((file, i) => [file, shas[i] ?? ""]));
}
