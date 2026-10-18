import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listFiles } from "../git.ts";
import { ensureGitignore } from "../managed/block.ts";
import { compareStrings } from "../map/serialize.ts";
import { KNOWLEDGE_DIR } from "./explorers.ts";

const CHURN_COMMITS = 200;
const CHURN_TOP = 40;

export interface ExploreContext {
  /** Every package.json's scripts: the repo's own documented commands. */
  packageScripts: Array<{ file: string; name: string | null; scripts: Record<string, string> }>;
  /** Files changed most often in the last commits: where risk and active features live. */
  churn: Array<{ file: string; commits: number }>;
  ciFiles: string[];
  composeFiles: string[];
  envFiles: string[];
  docs: string[];
  harnessConfigs: string[];
  mapDir: string;
}

const pick = (files: readonly string[], test: (f: string) => boolean): string[] => files.filter(test).sort(compareStrings);

/** Facts read-only explorers can't compute themselves (they have no shell): written to .plumb/knowledge/context.json. */
export function prepareContext(root: string): { file: string; context: ExploreContext } {
  const files = listFiles(root).filter((f) => !f.startsWith(".plumb/"));
  const counts = new Map<string, number>();
  const log = execFileSync("git", ["log", `-n${String(CHURN_COMMITS)}`, "--name-only", "--format=", "--relative", "--no-renames"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const f of log.split("\n").filter((l) => l !== "" && !l.startsWith(".plumb/"))) counts.set(f, (counts.get(f) ?? 0) + 1);

  const context: ExploreContext = {
    packageScripts: pick(files, (f) => path.posix.basename(f) === "package.json" && !f.includes("node_modules/")).map((file) => {
      const pkg = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { name?: string; scripts?: Record<string, string> };
      return { file, name: pkg.name ?? null, scripts: pkg.scripts ?? {} };
    }),
    churn: [...counts]
      .map(([file, commits]) => ({ file, commits }))
      .sort((a, b) => b.commits - a.commits || compareStrings(a.file, b.file))
      .slice(0, CHURN_TOP),
    ciFiles: pick(files, (f) => f.startsWith(".github/workflows/") || f === ".gitlab-ci.yml" || f.startsWith(".circleci/") || f === "azure-pipelines.yml"),
    composeFiles: pick(files, (f) => /(^|\/)(docker-)?compose\.ya?ml$/.test(f)),
    envFiles: pick(files, (f) => /(^|\/)\.env\.(example|sample|template|dist)$/.test(f)),
    docs: pick(files, (f) => /(^|\/)(README|CONTRIBUTING|DEVELOPMENT|Makefile|justfile)(\.[a-z]+)?$/i.test(f)),
    harnessConfigs: pick(files, (f) => /(^|\/)(playwright|cypress|vitest|jest)\.config\.[cm]?[jt]s$/.test(f)),
    mapDir: ".plumb/map",
  };
  ensureGitignore(root);
  mkdirSync(path.join(root, KNOWLEDGE_DIR), { recursive: true });
  const file = `${KNOWLEDGE_DIR}/context.json`;
  writeFileSync(path.join(root, file), `${JSON.stringify(context, null, 2)}\n`);
  return { file, context };
}
