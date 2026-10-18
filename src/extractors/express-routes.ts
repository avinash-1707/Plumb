import path from "node:path";
import ts from "typescript";
import { httpEntryId } from "../map/ids.ts";
import type { EntryPoint, ExtractorFailure, Loc, NodeId } from "../map/types.ts";
import { importBindings, isCodeFile, locOf, stringValue, type SourceCache } from "./source.ts";
import { type Extractor, extracted, failure } from "./types.ts";
import { declaredDependencies } from "./workspace.ts";

const ID = "express-routes";
const METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
  all: "ALL",
};
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];

type ChildRef = { kind: "local"; name: string } | { kind: "import"; module: string; imported: string };

interface FileRoutes {
  routers: Map<string, { isApp: boolean }>;
  routes: Array<{ router: string; method: string; path: string; loc: Loc }>;
  mounts: Array<{ parent: string; prefix: string; child: ChildRef; loc: Loc }>;
  /** use(prefix, x) where x might be a router Plumb can't follow; routes under it would lose the prefix. */
  unresolvedMounts: Array<{ prefix: string; loc: Loc; what: string }>;
  /** exported name -> local name */
  exported: Map<string, string>;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function rootIdentifier(node: ts.Expression): ts.Identifier | undefined {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) current = current.expression;
    else return undefined;
  }
}

/** Package name of a bare specifier: "@scope/pkg/x" -> "@scope/pkg", "pkg/x" -> "pkg". */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * Routers, routes, and mounts declared in one file. Only literal paths count.
 * `packages` are the component's declared dependencies: middleware imported from them (cors, express.static,
 * graphqlHTTP) is not a router, while a mounted value Plumb cannot trace is reported instead of guessed.
 */
export function fileRoutes(sf: ts.SourceFile, packages: ReadonlySet<string> = new Set()): FileRoutes {
  const bindings = importBindings(sf);
  const isExpressDefault = (n: ts.Node): boolean => ts.isIdentifier(n) && bindings.get(n.text)?.module === "express" && bindings.get(n.text)?.imported === "default";
  const isRouterFactory = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) && bindings.get(n.text)?.module === "express" && bindings.get(n.text)?.imported === "Router") ||
    (ts.isPropertyAccessExpression(n) && n.name.text === "Router" && isExpressDefault(n.expression));
  const fromPackage = (name: string): boolean => {
    const module = bindings.get(name)?.module;
    return module !== undefined && !module.startsWith(".") && packages.has(packageName(module));
  };

  // Names declared in this file that are not routers (handlers, middleware).
  const localValues = new Set<string>();
  const result: FileRoutes = { routers: new Map(), routes: [], mounts: [], unresolvedMounts: [], exported: new Map() };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init !== undefined && ts.isCallExpression(init) && isExpressDefault(init.expression)) result.routers.set(node.name.text, { isApp: true });
      else if (init !== undefined && ts.isCallExpression(init) && isRouterFactory(init.expression)) result.routers.set(node.name.text, { isApp: false });
      else localValues.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) localValues.add(node.name.text);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const target = node.expression.expression.text;
      const method = node.expression.name.text;
      if (result.routers.has(target)) {
        const routePath = stringValue(node.arguments[0]);
        const upper = METHODS[method];
        // app.get("setting") with one argument reads an app setting; a route always has a handler.
        if (upper !== undefined && routePath !== undefined && node.arguments.length >= 2) {
          result.routes.push({ router: target, method: upper, path: routePath, loc: locOf(sf, node) });
        }
        if (method === "use") {
          const prefix = stringValue(node.arguments[0]);
          const loc = locOf(sf, node);
          for (const arg of node.arguments.slice(prefix === undefined ? 0 : 1)) {
            if (ts.isIdentifier(arg) && result.routers.has(arg.text)) {
              result.mounts.push({ parent: target, prefix: prefix ?? "", child: { kind: "local", name: arg.text }, loc });
              continue;
            }
            const binding = ts.isIdentifier(arg) ? bindings.get(arg.text) : undefined;
            if (binding?.module.startsWith(".") === true) {
              result.mounts.push({ parent: target, prefix: prefix ?? "", child: { kind: "import", module: binding.module, imported: binding.imported }, loc });
              continue;
            }
            // Without a prefix an untraced router keeps its own paths, which is still correct.
            if (prefix === undefined) continue;
            const root = rootIdentifier(arg);
            const traceable = root !== undefined && (localValues.has(root.text) && ts.isIdentifier(arg) ? true : fromPackage(root.text) || isExpressDefault(root));
            if (!traceable) result.unresolvedMounts.push({ prefix, loc, what: arg.getText(sf) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const decl of statement.declarationList.declarations) if (ts.isIdentifier(decl.name)) result.exported.set(decl.name.text, decl.name.text);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) result.exported.set(el.name.text, (el.propertyName ?? el.name).text);
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) result.exported.set("default", statement.expression.text);
  }
  return result;
}

export function joinRoutePath(prefix: string, route: string): string {
  return `/${[prefix, route].join("/").split("/").filter((s) => s !== "").join("/")}`;
}

/** Resolves a relative import the way TS ESM projects write it ("./x.js" may mean "./x.ts"). */
export function resolveRelative(fromFile: string, specifier: string, files: ReadonlySet<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const stems = [base, base.replace(/\.(m|c)?js$/, "")];
  for (const stem of stems) {
    for (const suffix of RESOLVE_SUFFIXES) {
      if (files.has(stem + suffix)) return stem + suffix;
    }
  }
  return null;
}

export interface ExpressScan {
  entries: Array<{ id: NodeId; loc: Loc }>;
  /** Mount sites whose target could not be traced; their routes may be missing a path prefix. */
  unresolved: Array<{ loc: Loc; prefix: string; what: string }>;
}

/** All Express routes in a set of files, with mount prefixes composed across relative imports. */
export function expressEntries(files: readonly string[], sources: SourceCache, packages: ReadonlySet<string> = new Set()): ExpressScan {
  const fileSet = new Set(files);
  const perFile = new Map(files.filter(isCodeFile).map((f) => [f, fileRoutes(sources.get(f), packages)]));
  const key = (file: string, local: string): string => `${file}#${local}`;
  const unresolved: ExpressScan["unresolved"] = [];

  const parentsOf = new Map<string, Array<{ parent: string; prefix: string }>>();
  for (const [file, facts] of perFile) {
    unresolved.push(...facts.unresolvedMounts);
    for (const mount of facts.mounts) {
      let childKey: string | null = null;
      if (mount.child.kind === "local") childKey = key(file, mount.child.name);
      else {
        const target = resolveRelative(file, mount.child.module, fileSet);
        const targetFacts = target === null ? undefined : perFile.get(target);
        const local = targetFacts?.exported.get(mount.child.imported);
        if (target !== null && local !== undefined && targetFacts?.routers.has(local) === true) childKey = key(target, local);
        else if (local === undefined && mount.prefix !== "") {
          // The import exists but Plumb can't see what it exports (module.exports, re-export): not silent.
          unresolved.push({ loc: mount.loc, prefix: mount.prefix, what: `${mount.child.imported} from "${mount.child.module}"` });
        }
      }
      if (childKey !== null) parentsOf.set(childKey, [...(parentsOf.get(childKey) ?? []), { parent: key(file, mount.parent), prefix: mount.prefix }]);
    }
  }

  const memo = new Map<string, string[]>();
  // Returns the prefixes and whether a mount cycle cut the walk short; cut-short results are not cached,
  // so the outcome doesn't depend on which router of a cycle is visited first.
  const prefixes = (routerKey: string, visiting: ReadonlySet<string>): { values: string[]; partial: boolean } => {
    const cached = memo.get(routerKey);
    if (cached !== undefined) return { values: cached, partial: false };
    if (visiting.has(routerKey)) return { values: [], partial: true };
    const parents = parentsOf.get(routerKey);
    if (parents === undefined) return { values: [""], partial: false };
    let partial = false;
    const values: string[] = [];
    for (const p of parents) {
      const up = prefixes(p.parent, new Set([...visiting, routerKey]));
      if (up.partial) partial = true;
      values.push(...up.values.map((pp) => joinRoutePath(pp, p.prefix)));
    }
    if (!partial) memo.set(routerKey, values);
    return { values, partial };
  };

  const entries: ExpressScan["entries"] = [];
  for (const [file, facts] of perFile) {
    for (const route of facts.routes) {
      for (const prefix of prefixes(key(file, route.router), new Set()).values) {
        entries.push({ id: httpEntryId(route.method, joinRoutePath(prefix, route.path)), loc: route.loc });
      }
    }
  }
  return { entries, unresolved };
}

export const expressRoutes: Extractor = {
  id: ID,
  version: "1",
  run(ctx) {
    const entryPoints: Array<{ component: NodeId; entry: EntryPoint }> = [];
    const failures: ExtractorFailure[] = [];
    for (const component of ctx.components.filter((c) => c.framework.includes("express"))) {
      const scan = expressEntries(ctx.filesOf(component.id), ctx.sources, new Set(declaredDependencies(component.packageJson)));
      for (const { id, loc } of scan.entries) {
        entryPoints.push({ component: component.id, entry: { id, kind: "http", location: loc, provenance: extracted(ID) } });
      }
      for (const u of scan.unresolved) {
        failures.push(failure(ID, component.id, `can't trace what ${u.loc.file}:${String(u.loc.line)} mounts at "${u.prefix}" (${u.what}); routes under it may be missing the prefix`));
      }
    }
    return { entryPoints, failures };
  },
};
