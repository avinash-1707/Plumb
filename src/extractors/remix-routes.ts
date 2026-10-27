import path from "node:path";
import ts from "typescript";
import { matchesAny } from "../glob.ts";
import { httpEntryId, uiEntryId } from "../map/ids.ts";
import type { EntryPoint, ExtractorFailure, NodeId } from "../map/types.ts";
import { importBindings, locOf, stringValue } from "./source.ts";
import { type Extractor, extracted, failure } from "./types.ts";

const ID = "remix-routes";
const VERSION = "1";
// The route module extensions and folder modules (route, index) of @remix-run/dev 2's flat-routes.
const ROUTE_EXTENSION = /\.(tsx|ts|jsx|js|mdx|md)$/;
const FOLDER_MODULE = /^(route|index)\.(tsx|ts|jsx|js|mdx|md)$/;
const CONFIG_FILE = /^(remix|vite)\.config\.[cm]?[jt]s$/;
// Route conventions other than v2 flat routes; their files mean different URLs.
const OTHER_CONVENTIONS = ["@remix-run/v1-route-convention", "remix-flat-routes"];

/**
 * URL of a Remix v2 flat-route name ("notes.$noteId", "_auth.login", "[sitemap.xml]"); "layout" for a pathless layout
 * ("_auth"), which wraps its children but has no URL of its own; "optional" for a name with an optional "(segment)",
 * which this doesn't model.
 */
export function remixRoute(name: string): { url: string } | { layout: true } | { optional: true } {
  // Dots split segments except inside [] escapes.
  const segments = name.match(/(?:\[[^\]]*\]|[^.])+/g) ?? [];
  const last = segments.at(-1);
  if (last !== undefined && last.startsWith("_") && last !== "_index") return { layout: true };
  const kept: string[] = [];
  for (const raw of segments) {
    if (raw.startsWith("(")) return { optional: true };
    if (raw === "_index") continue;
    // "_x" is a pathless layout; a trailing "_" only opts out of the parent's layout.
    if (raw.startsWith("_")) continue;
    const segment = raw.endsWith("_") ? raw.slice(0, -1) : raw;
    if (segment === "$") kept.push("[...splat]");
    else if (segment.startsWith("$")) kept.push(`:${segment.slice(1)}`);
    else kept.push(segment.replaceAll(/[[\]]/g, ""));
  }
  return { url: `/${kept.join("/")}` };
}

/** Whether a route module renders (default export), and the lines of its loader and action exports. */
export function routeModuleExports(sf: ts.SourceFile): { component: boolean; loader: number | null; action: number | null } {
  const result: { component: boolean; loader: number | null; action: number | null } = { component: false, loader: null, action: null };
  const found = (name: string, node: ts.Node): void => {
    if (name === "default") result.component = true;
    else if (name === "loader" || name === "action") result[name] ??= locOf(sf, node).line;
  };
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement)) found("default", statement);
    else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) found(el.name.text, statement);
    } else if (ts.canHaveModifiers(statement)) {
      const modifiers = ts.getModifiers(statement) ?? [];
      if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) found("default", statement);
      else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) found(statement.name.text, statement);
      else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) if (ts.isIdentifier(decl.name)) found(decl.name.text, statement);
      }
    }
  }
  return result;
}

/**
 * Route settings in remix.config.* or vite.config.*: literal ignoredRouteFiles, and whether manual routes() or a
 * non-literal ignore list are configured (`unreadable` carries their lines).
 */
export function remixConfig(sf: ts.SourceFile): { ignored: string[]; unreadable: Array<{ line: number; what: string }> } {
  const result: { ignored: string[]; unreadable: Array<{ line: number; what: string }> } = { ignored: [], unreadable: [] };
  // A vite.config only configures Remix through its plugin; other "routes" keys there belong to something else.
  if (/^vite\./.test(path.posix.basename(sf.fileName)) && ![...importBindings(sf).values()].some((b) => b.module === "@remix-run/dev")) return result;
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isShorthandPropertyAssignment(node)) && ts.isIdentifier(node.name)) {
      const line = locOf(sf, node).line;
      if (node.name.text === "routes") result.unreadable.push({ line, what: "manual routes()" });
      if (node.name.text === "ignoredRouteFiles") {
        const value = ts.isPropertyAssignment(node) ? node.initializer : undefined;
        const patterns = value !== undefined && ts.isArrayLiteralExpression(value) ? value.elements.map((el) => stringValue(el)) : [undefined];
        if (patterns.every((p) => p !== undefined)) result.ignored.push(...patterns);
        else result.unreadable.push({ line, what: "an ignoredRouteFiles that isn't a list of literals" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

export const remixRoutes: Extractor = {
  id: ID,
  version: VERSION,
  run(ctx) {
    const entryPoints: Array<{ component: NodeId; entry: EntryPoint }> = [];
    const failures: ExtractorFailure[] = [];
    for (const component of ctx.components.filter((c) => c.framework.includes("remix"))) {
      const prefix = component.root === "." ? "" : `${component.root}/`;
      const deps = { ...component.packageJson?.devDependencies, ...component.packageJson?.dependencies };
      const other = OTHER_CONVENTIONS.filter((d) => d in deps);
      if (/^[\^~]?1\./.test(deps["@remix-run/dev"] ?? "")) other.push("Remix 1 (@remix-run/dev 1.x)");
      if (other.length > 0) {
        failures.push(failure(ID, component.id, `route convention not modelled (${other.join(", ")}); no Remix routes are in the map`));
        continue;
      }

      const ignored: string[] = [];
      for (const file of ctx.filesOf(component.id).filter((f) => CONFIG_FILE.test(f.slice(prefix.length)))) {
        const config = ctx.cache.file(ID, VERSION, file, () => remixConfig(ctx.sources.get(file)), "config");
        ignored.push(...config.ignored);
        for (const u of config.unreadable) failures.push(failure(ID, component.id, `${file}:${String(u.line)} has ${u.what}; routes may be missing or extra`));
      }

      const appDir = `${prefix}app/`;
      for (const file of ctx.filesOf(component.id)) {
        if (!file.startsWith(`${appDir}routes/`)) continue;
        const parts = file.slice(`${appDir}routes/`.length).split("/");
        // Only direct entries of routes/ count: a file, or a folder through its route.<ext> or index.<ext>.
        const name = parts.length === 1 && ROUTE_EXTENSION.test(file) ? parts[0]?.replace(ROUTE_EXTENSION, "") : parts.length === 2 && FOLDER_MODULE.test(parts[1] ?? "") ? parts[0] : undefined;
        if (name === undefined || name === "" || matchesAny(file.slice(appDir.length), ignored)) continue;
        const route = remixRoute(name);
        if ("layout" in route) continue;
        if ("optional" in route) {
          failures.push(failure(ID, component.id, `${file}: optional segments aren't modelled; its route is not in the map`));
          continue;
        }
        const exports = /\.mdx?$/.test(file) ? { component: true, loader: null, action: null } : ctx.cache.file(ID, VERSION, file, () => routeModuleExports(ctx.sources.get(file)));
        const add = (id: NodeId, kind: EntryPoint["kind"], line: number): void => {
          entryPoints.push({ component: component.id, entry: { id, kind, location: { file, line }, provenance: extracted(ID) } });
        };
        // File-layout facts point at line 1 of the defining file.
        if (exports.component) add(uiEntryId(route.url), "ui-route", 1);
        // A rendering route's loader only feeds its own page; a resource route's loader is an endpoint.
        else if (exports.loader !== null) add(httpEntryId("GET", route.url), "http", exports.loader);
        if (exports.action !== null) add(httpEntryId("POST", route.url), "http", exports.action);
      }
    }
    return { entryPoints, failures };
  },
};
