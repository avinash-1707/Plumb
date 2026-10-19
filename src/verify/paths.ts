import path from "node:path";
import { UsageError } from "../errors.ts";

export const EVIDENCE_DIR = ".plumb/evidence";
export const STAMPS_DIR = ".plumb/stamps";
export const DOCTOR_HELPER = ".plumb/bin/doctor";

/** The generated verify skill's directory, named by the profile's slug (doc 5). */
export function skillDir(slug: string): string {
  return `.claude/skills/verify-${slug}`;
}

/**
 * Where scaffold puts a new skill for the agent to fill. `.claude/` is a protected path in Claude Code (every agent
 * write there prompts, and is refused in dontAsk mode), so the agent works in this gitignored draft and
 * `plumb verify --publish` moves it into place in one step.
 */
export function draftDir(slug: string): string {
  return `.plumb/cache/draft/verify-${slug}`;
}

/** A run's evidence directory; the id must be a single path segment so it can't point outside .plumb/evidence. */
export function runDir(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new UsageError(`"${runId}" is not a run id`);
  return `${EVIDENCE_DIR}/${runId}`;
}

/** Whether a path relative to a directory stays inside it. */
export function staysInside(rel: string): boolean {
  const normalized = path.posix.normalize(rel);
  return !path.posix.isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith("../");
}
