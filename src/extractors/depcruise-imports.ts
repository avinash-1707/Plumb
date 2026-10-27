import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise, type ICruiseOptions, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import ts from "typescript";
import { compareStrings } from "../map/serialize.ts";
import type { Edge, ExtractorFailure, Loc, NodeId } from "../map/types.ts";
import { resolveRelative } from "./express-routes.ts";
import { importSiteLocs, isCodeFile } from "./source.ts";
import { type ComponentSeed, type Extractor, type ExtractorContext, extracted, failure, type PackageJson } from "./types.ts";
import { declaredDependencies } from "./workspace.ts";

const ID = "depcruise-imports";
const VERSION = "1";
const CONFIG_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;

const CRUISE_OPTIONS: ICruiseOptions = {
  tsPreCompilationDeps: true,
  // Cross-component targets are recorded but not cruised into: each component is cruised on its own.
  doNotFollow: { path: ["node_modules", "^\\.\\./"] },
  enhancedResolveOptions: {
    // Without exportsFields, workspace packages that only declare "exports" stay unresolved.
    exportsFields: ["exports"],
    conditionNames: ["import", "require", "node", "default", "types"],
    extensions: [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
  },
};

/**
 * enhanced-resolve takes the first `exports` condition that matches, in the package's own key order, and doesn't move
 * on when that file is missing. So `{ types: "./dist/x.d.ts", default: "./src/x.ts" }` fails until a build creates
 * dist/, while `{ types: "./src/x.ts", default: "./dist/x.js" }` needs `types`. A cruise with workspace packages left
 * unresolved is repeated without `types`, and that resolution is used for those imports only.
 */
const WITHOUT_TYPES: ICruiseOptions = {
  ...CRUISE_OPTIONS,
  enhancedResolveOptions: { ...CRUISE_OPTIONS.enhancedResolveOptions, conditionNames: ["import", "require", "node", "default"] },
};

let cruiserVersion: string | undefined;

/** dependency-cruiser's own version, read from its package.json (it exports none). */
export function dependencyCruiserVersion(): string {
  if (cruiserVersion === undefined) {
    let dir = path.dirname(fileURLToPath(import.meta.resolve("dependency-cruiser")));
    while (!existsSync(path.join(dir, "package.json")) && dir !== path.dirname(dir)) dir = path.dirname(dir);
    const pkg: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    cruiserVersion = typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string" ? pkg.version : "unknown";
  }
  return cruiserVersion;
}

function isInstalled(root: string, componentRoot: string, dependency: string): boolean {
  let dir = path.resolve(root, componentRoot);
  const top = path.resolve(root);
  for (;;) {
    if (existsSync(path.join(dir, "node_modules", dependency))) return true;
    if (dir === top || dir === path.dirname(dir)) return false;
    dir = path.dirname(dir);
  }
}

/**
 * dependency-cruiser resolves tsconfig `paths` without a `baseUrl` against process.cwd(), not the tsconfig's
 * directory, so the cruise must run with the tsconfig's directory as cwd.
 * SIMPLIFIED: process-wide chdir, safe because the build is sequential. Move cruises into a child process with
 * its own cwd if extractors ever run in parallel.
 */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

/** Every file the package's "." entry could point at, most preferred first; the caller takes the first that is tracked source. */
function packageEntryCandidates(pkg: PackageJson | null): string[] {
  const collect = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    if ("." in record) return collect(record["."]);
    return ["import", "module", "default", "node", "require", "types"].flatMap((condition) => collect(record[condition]));
  };
  return [...collect(pkg?.exports), ...[pkg?.module, pkg?.main, pkg?.types].filter((v): v is string => typeof v === "string")];
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

/** What one file exports directly, plus the relative modules it re-exports with `export *`. */
export interface FileExports {
  names: string[];
  stars: string[];
}

export function fileExports(sf: ts.SourceFile): FileExports {
  const result: FileExports = { names: [], stars: [] };
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) result.names.push(...clause.elements.map((el) => el.name.text));
      else if (clause !== undefined && ts.isNamespaceExport(clause)) result.names.push(clause.name.text);
      else if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
        result.stars.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      result.names.push("default");
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) result.names.push("default");
    else if (ts.isVariableStatement(statement)) result.names.push(...statement.declarationList.declarations.flatMap((d) => bindingNames(d.name)));
    else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      result.names.push(statement.name.text);
    }
  }
  return result;
}

/** Names a module exports, following `export * from "./relative"`. */
export function exportedNames(file: string, exportsOf: (file: string) => FileExports, files: ReadonlySet<string>, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const own = exportsOf(file);
  return [
    ...own.names,
    ...own.stars.flatMap((specifier) => {
      const target = resolveRelative(file, specifier, files);
      return target === null ? [] : exportedNames(target, exportsOf, files, seen);
    }),
  ];
}

function tsconfigFor(ctx: ExtractorContext, component: ComponentSeed): string | null {
  for (const dir of [component.root, "."]) {
    const file = path.posix.join(dir, "tsconfig.json");
    if (ctx.files.includes(file)) return path.resolve(ctx.root, file);
  }
  return null;
}

/** Specifiers whose resolution failure would hide a cross-component edge. */
function isLocalSpecifier(specifier: string, workspacePackages: readonly string[], aliasPrefixes: readonly string[]): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    workspacePackages.some((p) => specifier === p || specifier.startsWith(`${p}/`)) ||
    aliasPrefixes.some((p) => p !== "" && specifier.startsWith(p))
  );
}

interface CruiseFacts {
  edges: Array<{ to: NodeId; evidence: Loc[] }>;
  failures: string[];
}

type ParsedTsConfig = ReturnType<typeof extractTSConfig>;

/**
 * Everything a successful cruise depends on: node_modules is covered by the lockfile, and the tsconfig by its
 * resolved options (which include whatever its `extends` chain contributed, wherever those files live).
 */
function cruiseInputs(ctx: ExtractorContext, component: ComponentSeed, codeFiles: readonly string[], tsconfig: ParsedTsConfig | undefined): string {
  return JSON.stringify({
    component: [component.id, component.root],
    compilerOptions: tsconfig?.options ?? null,
    code: codeFiles.map((f) => [f, ctx.sha(f)]),
    // Added, removed, or renamed files anywhere can change what an import resolves to.
    paths: ctx.files,
    configs: ctx.files.filter((f) => CONFIG_FILE.test(f)).map((f) => [f, ctx.sha(f)]),
    layout: ctx.components.map((c) => [c.id, c.root, c.include, c.packageJson?.name ?? null]),
  });
}

async function cruiseComponent(
  ctx: ExtractorContext,
  component: ComponentSeed,
  edges: Array<{ component: NodeId; edge: Edge }>,
  failures: ExtractorFailure[],
): Promise<void> {
  const codeFiles = ctx.filesOf(component.id).filter(isCodeFile);
  if (codeFiles.length === 0) return;

  const missing = declaredDependencies(component.packageJson).filter((dep) => !isInstalled(ctx.root, component.root, dep));
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(", ") + (missing.length > 3 ? `, +${String(missing.length - 3)} more` : "");
    failures.push(failure(ID, component.id, `dependencies not installed (missing ${shown}); run the package manager's install`));
    return;
  }

  const tsconfig = tsconfigFor(ctx, component);
  const parsedTsConfig = tsconfig === null ? undefined : extractTSConfig(tsconfig);
  const facts = await ctx.cache.keyed(
    ID,
    VERSION,
    cruiseInputs(ctx, component, codeFiles, parsedTsConfig),
    () => cruiseUncached(ctx, component, codeFiles, tsconfig, parsedTsConfig),
    // A failure can come from a gitignored file the key can't see (an ungenerated Prisma client, an unbuilt
    // dist/); never cache one, so it clears as soon as the file appears.
    (result) => result.failures.length === 0,
  );
  failures.push(...facts.failures.map((reason) => failure(ID, component.id, reason)));
  for (const e of facts.edges) edges.push({ component: component.id, edge: { kind: "imports", to: e.to, evidence: e.evidence, provenance: extracted(ID) } });
}

async function cruiseUncached(
  ctx: ExtractorContext,
  component: ComponentSeed,
  codeFiles: readonly string[],
  tsconfig: string | null,
  parsedTsConfig: ParsedTsConfig | undefined,
): Promise<CruiseFacts> {
  const prefix = component.root === "." ? "" : `${component.root}/`;
  const failures: string[] = [];
  const paths = parsedTsConfig?.options.paths ?? {};
  const aliasPrefixes = Object.keys(paths).map((p) => p.replace(/\*$/, ""));
  const workspacePackages = ctx.components.flatMap((c) => (c.packageJson?.name === undefined ? [] : [c.packageJson.name]));

  const componentDir = path.resolve(ctx.root, component.root);
  const cruiseWith = async (options: ICruiseOptions): Promise<ICruiseResult> => {
    const result = await withCwd(tsconfig === null ? componentDir : path.dirname(tsconfig), () =>
      cruise(
        codeFiles.map((f) => f.slice(prefix.length)),
        { ...options, baseDir: componentDir, ...(tsconfig === null ? {} : { tsConfig: { fileName: tsconfig } }) },
        undefined,
        parsedTsConfig === undefined ? undefined : { tsConfig: parsedTsConfig },
      ),
    );
    return result.output as ICruiseResult;
  };
  const output = await cruiseWith(CRUISE_OPTIONS);

  const transpilerIssues = (output.summary.environment.issues ?? []).filter((i) => i.name.startsWith("missing-"));
  if (transpilerIssues.length > 0) return { edges: [], failures: [`dependency-cruiser reported ${transpilerIssues.map((i) => i.name).join(", ")}`] };
  if (output.summary.totalCruised === 0) return { edges: [], failures: [`dependency-cruiser cruised 0 modules out of ${String(codeFiles.length)} source files`] };

  // Only a package's exports depend on conditions: a relative or alias miss (an ungenerated file) would fail again.
  const unresolvedPackage = output.modules.some((mod) => mod.dependencies.some((dep) => dep.couldNotResolve && workspacePackages.some((p) => dep.module === p || dep.module.startsWith(`${p}/`))));
  const retried = new Map<string, string>();
  if (unresolvedPackage) {
    for (const mod of (await cruiseWith(WITHOUT_TYPES)).modules) {
      for (const dep of mod.dependencies) if (!dep.couldNotResolve) retried.set(`${mod.source}\0${dep.module}`, dep.resolved);
    }
  }

  const evidenceByTarget = new Map<NodeId, Loc[]>();
  for (const mod of output.modules) {
    if (mod.source.startsWith("../") || mod.source.includes("node_modules")) continue;
    const sourceFile = path.posix.normalize(prefix + mod.source);
    // A nested component's files are cruised too (their paths don't start with ../) but belong to it.
    if (!isCodeFile(sourceFile) || ctx.componentOf(sourceFile)?.id !== component.id) continue;
    for (const dep of mod.dependencies) {
      if (dep.coreModule) continue;
      const resolved = dep.couldNotResolve ? retried.get(`${mod.source}\0${dep.module}`) : dep.resolved;
      if (resolved === undefined) {
        if (isLocalSpecifier(dep.module, workspacePackages, aliasPrefixes)) {
          failures.push(`could not resolve "${dep.module}" imported from ${sourceFile}`);
        }
        continue;
      }
      const target = path.posix.normalize(prefix + resolved);
      if (target.startsWith("node_modules/") || target.includes("/node_modules/")) continue;
      if (target.startsWith("../")) {
        failures.push(`"${dep.module}" imported from ${sourceFile} resolves outside the project`);
        continue;
      }
      const owner = ctx.componentOf(target);
      if (owner === undefined || owner.id === component.id) continue;
      const locs = importSiteLocs(ctx.sources.get(sourceFile), dep.module);
      if (locs.length === 0) {
        failures.push(`found an import of "${dep.module}" in ${sourceFile} but not its line`);
        continue;
      }
      evidenceByTarget.set(owner.id, [...(evidenceByTarget.get(owner.id) ?? []), ...locs]);
    }
  }
  return { edges: [...evidenceByTarget].sort(([a], [b]) => compareStrings(a, b)).map(([to, evidence]) => ({ to, evidence })), failures };
}

export const depcruiseImports: Extractor = {
  id: ID,
  version: VERSION,
  async run(ctx) {
    const edges: Array<{ component: NodeId; edge: Edge }> = [];
    const failures: ExtractorFailure[] = [];
    const exports: Array<{ component: NodeId; names: string[] }> = [];
    const fileSet = new Set(ctx.files);
    for (const component of ctx.components) {
      await cruiseComponent(ctx, component, edges, failures);
      const entryFile = packageEntryCandidates(component.packageJson)
        .map((entry) => path.posix.normalize(path.posix.join(component.root, entry)))
        .find((file) => fileSet.has(file) && isCodeFile(file));
      if (entryFile !== undefined) {
        const exportsOf = (file: string): FileExports => ctx.cache.file(ID, VERSION, file, () => fileExports(ctx.sources.get(file)), "exports");
        exports.push({ component: component.id, names: exportedNames(entryFile, exportsOf, fileSet) });
      }
    }
    return { edges, failures, exports };
  },
};
