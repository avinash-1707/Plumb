import { existsSync } from "node:fs";
import path from "node:path";
import { cruise, type ICruiseOptions, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import ts from "typescript";
import { compareStrings } from "../map/serialize.ts";
import type { Edge, ExtractorFailure, Loc, NodeId } from "../map/types.ts";
import { resolveRelative } from "./express-routes.ts";
import { importSiteLocs, isCodeFile, type SourceCache } from "./source.ts";
import { type ComponentSeed, type Extractor, type ExtractorContext, extracted, failure, type PackageJson } from "./types.ts";
import { declaredDependencies } from "./workspace.ts";

const ID = "depcruise-imports";

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

/** Names a module exports, following `export * from "./relative"`. */
export function exportedNames(file: string, sources: SourceCache, files: ReadonlySet<string>, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const sf = sources.get(file);
  const names: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) names.push(...clause.elements.map((el) => el.name.text));
      else if (clause !== undefined && ts.isNamespaceExport(clause)) names.push(clause.name.text);
      else if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
        const target = resolveRelative(file, statement.moduleSpecifier.text, files);
        if (target !== null) names.push(...exportedNames(target, sources, files, seen));
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.push("default");
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) names.push("default");
    else if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.flatMap((d) => bindingNames(d.name)));
    else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
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

async function cruiseComponent(
  ctx: ExtractorContext,
  component: ComponentSeed,
  edges: Array<{ component: NodeId; edge: Edge }>,
  failures: ExtractorFailure[],
): Promise<void> {
  const prefix = component.root === "." ? "" : `${component.root}/`;
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
  const paths = parsedTsConfig?.options.paths ?? {};
  const aliasPrefixes = Object.keys(paths).map((p) => p.replace(/\*$/, ""));
  const workspacePackages = ctx.components.flatMap((c) => (c.packageJson?.name === undefined ? [] : [c.packageJson.name]));

  const componentDir = path.resolve(ctx.root, component.root);
  const result = await withCwd(tsconfig === null ? componentDir : path.dirname(tsconfig), () =>
    cruise(
      codeFiles.map((f) => f.slice(prefix.length)),
      { ...CRUISE_OPTIONS, baseDir: componentDir, ...(tsconfig === null ? {} : { tsConfig: { fileName: tsconfig } }) },
      undefined,
      parsedTsConfig === undefined ? undefined : { tsConfig: parsedTsConfig },
    ),
  );
  const output = result.output as ICruiseResult;

  const transpilerIssues = (output.summary.environment.issues ?? []).filter((i) => i.name.startsWith("missing-"));
  if (transpilerIssues.length > 0) {
    failures.push(failure(ID, component.id, `dependency-cruiser reported ${transpilerIssues.map((i) => i.name).join(", ")}`));
    return;
  }
  if (output.summary.totalCruised === 0) {
    failures.push(failure(ID, component.id, `dependency-cruiser cruised 0 modules out of ${String(codeFiles.length)} source files`));
    return;
  }

  const evidenceByTarget = new Map<NodeId, Loc[]>();
  for (const mod of output.modules) {
    if (mod.source.startsWith("../") || mod.source.includes("node_modules")) continue;
    const sourceFile = path.posix.normalize(prefix + mod.source);
    // A nested component's files are cruised too (their paths don't start with ../) but belong to it.
    if (!isCodeFile(sourceFile) || ctx.componentOf(sourceFile)?.id !== component.id) continue;
    for (const dep of mod.dependencies) {
      if (dep.coreModule) continue;
      if (dep.couldNotResolve) {
        if (isLocalSpecifier(dep.module, workspacePackages, aliasPrefixes)) {
          failures.push(failure(ID, component.id, `could not resolve "${dep.module}" imported from ${sourceFile}`));
        }
        continue;
      }
      const target = path.posix.normalize(prefix + dep.resolved);
      if (target.startsWith("node_modules/") || target.includes("/node_modules/")) continue;
      if (target.startsWith("../")) {
        failures.push(failure(ID, component.id, `"${dep.module}" imported from ${sourceFile} resolves outside the project`));
        continue;
      }
      const owner = ctx.componentOf(target);
      if (owner === undefined || owner.id === component.id) continue;
      const locs = importSiteLocs(ctx.sources.get(sourceFile), dep.module);
      if (locs.length === 0) {
        failures.push(failure(ID, component.id, `found an import of "${dep.module}" in ${sourceFile} but not its line`));
        continue;
      }
      evidenceByTarget.set(owner.id, [...(evidenceByTarget.get(owner.id) ?? []), ...locs]);
    }
  }
  for (const [to, evidence] of [...evidenceByTarget].sort(([a], [b]) => compareStrings(a, b))) {
    edges.push({ component: component.id, edge: { kind: "imports", to, evidence, provenance: extracted(ID) } });
  }
}

export const depcruiseImports: Extractor = {
  id: ID,
  version: "1",
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
      if (entryFile !== undefined) exports.push({ component: component.id, names: exportedNames(entryFile, ctx.sources, fileSet) });
    }
    return { edges, failures, exports };
  },
};
