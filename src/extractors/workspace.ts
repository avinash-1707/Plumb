import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { matchGlob } from "../glob.ts";
import { assignFiles } from "../map/assign.ts";
import { componentId } from "../map/ids.ts";
import { compareStrings } from "../map/serialize.ts";
import type { ComponentKind, ExtractorFailure } from "../map/types.ts";
import { type ComponentSeed, type Extractor, type ExtractorContext, failure, type PackageJson } from "./types.ts";

const ID = "workspace";

const CONVENTIONAL_ROOTS = ["apps/*", "packages/*", "services/*", "cmd/*"];
const PACKAGE_ROOTS = new Set(["packages", "libs", "lib"]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
  ".prisma": "prisma",
};

const FRAMEWORK_BY_DEPENDENCY: Record<string, string> = {
  express: "express",
  fastify: "fastify",
  koa: "koa",
  hono: "hono",
  "@nestjs/core": "nest",
  next: "next",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  "@remix-run/react": "remix",
  prisma: "prisma",
  "@prisma/client": "prisma",
  "drizzle-orm": "drizzle",
};
const UI_FRAMEWORKS = new Set(["next", "react", "vue", "svelte", "sveltekit", "remix"]);
const HTTP_FRAMEWORKS = new Set(["express", "fastify", "koa", "hono", "nest"]);

export function readPackageJson(root: string, dir: string): PackageJson | null {
  const file = path.join(root, dir, "package.json");
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof parsed === "object" && parsed !== null ? parsed : null;
}

export function declaredDependencies(pkg: PackageJson | null): string[] {
  if (pkg === null) return [];
  return [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])].sort(compareStrings);
}

/** Directories (other than the root) that contain a package.json. */
function packageDirs(files: readonly string[]): string[] {
  return files
    .filter((f) => f.endsWith("/package.json") && !f.includes("node_modules/"))
    .map((f) => path.posix.dirname(f))
    .sort(compareStrings);
}

function workspacePatterns(ctx: ExtractorContext, failures: ExtractorFailure[]): string[] | null {
  if (ctx.files.includes("pnpm-workspace.yaml")) {
    try {
      const doc: unknown = parseYaml(readFileSync(path.join(ctx.root, "pnpm-workspace.yaml"), "utf8"));
      const packages = typeof doc === "object" && doc !== null && "packages" in doc ? doc.packages : undefined;
      if (Array.isArray(packages) && packages.every((p) => typeof p === "string")) return packages;
      failures.push(failure(ID, null, "pnpm-workspace.yaml has no packages list"));
    } catch (err) {
      failures.push(failure(ID, null, `pnpm-workspace.yaml could not be parsed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  const workspaces = readPackageJson(ctx.root, ".")?.workspaces;
  const list = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === "object" && workspaces !== null && "packages" in workspaces
      ? workspaces.packages
      : undefined;
  if (Array.isArray(list) && list.every((p) => typeof p === "string")) return list;
  return null;
}

function matchDirs(dirs: readonly string[], patterns: readonly string[]): string[] {
  const positive = patterns.filter((p) => !p.startsWith("!")).map((p) => p.replace(/\/$/, ""));
  const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/\/$/, ""));
  return dirs.filter((d) => positive.some((p) => matchGlob(d, p)) && !negative.some((p) => matchGlob(d, p)));
}

/** "src/server/**" -> "src/server": the directory part before the first wildcard. */
export function staticPrefix(glob: string): string {
  const segments: string[] = [];
  for (const segment of glob.split("/")) {
    if (/[*?[{]/.test(segment)) break;
    segments.push(segment);
  }
  return segments.join("/") || ".";
}

/** Deepest directory containing every include; a prefix that names a file contributes its folder. */
export function includeRoot(include: readonly string[], files: ReadonlySet<string>): string {
  const dirs = include.map((glob) => {
    const prefix = staticPrefix(glob);
    return files.has(prefix) ? path.posix.dirname(prefix) : prefix;
  });
  const split = dirs.map((d) => (d === "." ? [] : d.split("/")));
  const common: string[] = [];
  for (let i = 0; split.every((s) => i < s.length && s[i] === split[0]?.[i]); i++) common.push(split[0]?.[i] ?? "");
  return common.join("/") || ".";
}

function kindOf(root: string, frameworks: readonly string[]): ComponentKind {
  if (PACKAGE_ROOTS.has(root.split("/")[0] ?? "")) return "package";
  if (frameworks.some((f) => UI_FRAMEWORKS.has(f))) return "app";
  if (frameworks.some((f) => HTTP_FRAMEWORKS.has(f))) return "service";
  return "app";
}

function frameworksOf(pkg: PackageJson | null): string[] {
  return [...new Set(declaredDependencies(pkg).flatMap((dep) => FRAMEWORK_BY_DEPENDENCY[dep] ?? []))];
}

function languagesOf(files: readonly string[]): string[] {
  return [...new Set(files.flatMap((f) => LANGUAGE_BY_EXTENSION[path.posix.extname(f)] ?? []))];
}

/** Basename ids, falling back to the full root path for any basename two components share. */
function nameComponents(roots: readonly string[]): Map<string, string> {
  const base = (r: string): string => (r === "." ? "root" : path.posix.basename(r));
  const counts = new Map<string, number>();
  for (const r of roots) counts.set(base(r), (counts.get(base(r)) ?? 0) + 1);
  return new Map(roots.map((r) => [r, (counts.get(base(r)) ?? 0) > 1 ? r : base(r)]));
}

export const workspace: Extractor = {
  id: ID,
  version: "1",
  run(ctx) {
    const failures: ExtractorFailure[] = [];
    let drafts: Array<{ name: string; root: string; include: string[] }>;

    const configured = ctx.config.components ?? [];
    if (configured.length > 0) {
      const fileSet = new Set(ctx.files);
      drafts = configured.map((c) => ({ name: c.id, root: includeRoot(c.include, fileSet), include: c.include }));
    } else {
      const dirs = packageDirs(ctx.files);
      const patterns = workspacePatterns(ctx, failures);
      let roots = patterns === null ? [] : matchDirs(dirs, patterns);
      if (roots.length === 0) roots = matchDirs(dirs, CONVENTIONAL_ROOTS);
      if (roots.length === 0) roots = ["."];
      const names = nameComponents(roots);
      drafts = roots.map((root) => ({ name: names.get(root) ?? root, root, include: [root === "." ? "**" : `${root}/**`] }));
    }

    const ids = drafts.map((d) => ({ ...d, id: componentId(d.name) }));
    const { byComponent } = assignFiles(ctx.files, ids);
    const components: ComponentSeed[] = ids.map((d) => {
      const packageJson = readPackageJson(ctx.root, d.root);
      const framework = frameworksOf(packageJson);
      return {
        id: d.id,
        kind: kindOf(d.root, framework),
        root: d.root,
        include: d.include,
        language: languagesOf(byComponent.get(d.id) ?? []),
        framework,
        packageJson,
      };
    });
    return { components, failures };
  },
};
