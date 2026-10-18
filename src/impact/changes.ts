import { execFileSync } from "node:child_process";
import { UsageError } from "../errors.ts";
import { GitError } from "../git.ts";

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = typeof err === "object" && err !== null && "stderr" in err ? String(err.stderr).trim() : "";
    throw new GitError(`git ${args[0] ?? ""} failed in ${root}${stderr === "" ? "" : `: ${stderr}`}`);
  }
}

// --relative keeps paths relative to the project root (not the git top level) and limits them to it;
// --no-renames lists a rename as delete + add so both paths count as changed.
const DIFF = ["diff", "--name-only", "--no-renames", "--relative", "-z"];

function split(output: string): string[] {
  return output.split("\0").filter((f) => f !== "");
}

export function stagedChanges(root: string): string[] {
  return split(git(root, [...DIFF, "--cached"]));
}

/** Files changed on this branch since it left `base` (merge-base to HEAD, like a pull request's diff). */
export function branchChanges(root: string, base: string): { mergeBase: string; files: string[] } {
  let mergeBase: string;
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  } catch (err) {
    if (err instanceof GitError) throw new UsageError(`"${base}" is not a commit, or shares no history with HEAD`);
    throw err;
  }
  return { mergeBase, files: split(git(root, [...DIFF, mergeBase, "HEAD"])) };
}
