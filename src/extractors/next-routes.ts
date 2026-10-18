import ts from "typescript";
import { httpEntryId, uiEntryId } from "../map/ids.ts";
import type { EntryPoint, NodeId } from "../map/types.ts";
import { locOf } from "./source.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "next-routes";
const VERSION = "1";
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const PAGE_EXTENSIONS = /\.(tsx|ts|jsx|js|mdx)$/;

/** App Router: route groups "(x)" and parallel slots "@x" don't appear in the URL; "_x" folders opt out of routing. */
export function appRoute(segments: readonly string[]): string | null {
  if (segments.some((s) => s.startsWith("_"))) return null;
  const kept = segments.filter((s) => !s.startsWith("(") && !s.startsWith("@"));
  return `/${kept.join("/")}`;
}

/** Pages Router: "index" maps to its folder; "_app", "_document" and other "_x" files are not routes. */
export function pagesRoute(segments: readonly string[]): string | null {
  if (segments.some((s) => s.startsWith("_"))) return null;
  const kept = segments.at(-1) === "index" ? segments.slice(0, -1) : segments;
  return `/${kept.join("/")}`;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

/**
 * Route handler methods a route file exports, in every form Next accepts: `export function GET`,
 * `export const GET =`, `export const { GET, POST } = handlers`, `export { handler as GET }`, and
 * `export { GET } from "./x"`.
 */
export function exportedHttpMethods(sf: ts.SourceFile): Array<{ method: string; line: number }> {
  const found: Array<{ method: string; line: number }> = [];
  const push = (method: string, node: ts.Node): void => {
    found.push({ method, line: locOf(sf, node).line });
  };
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) if (HTTP_METHODS.has(el.name.text)) push(el.name.text, statement);
      continue;
    }
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && HTTP_METHODS.has(statement.name.text)) {
      push(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        for (const name of bindingNames(decl.name)) if (HTTP_METHODS.has(name)) push(name, statement);
      }
    }
  }
  return found;
}

export const nextRoutes: Extractor = {
  id: ID,
  version: VERSION,
  run(ctx) {
    const entryPoints: Array<{ component: NodeId; entry: EntryPoint }> = [];
    for (const component of ctx.components.filter((c) => c.framework.includes("next"))) {
      const prefix = component.root === "." ? "" : `${component.root}/`;
      for (const file of ctx.filesOf(component.id)) {
        const rel = file.slice(prefix.length);
        const appDir = ["app/", "src/app/"].find((d) => rel.startsWith(d));
        const pagesDir = ["pages/", "src/pages/"].find((d) => rel.startsWith(d));
        if (appDir !== undefined) {
          const parts = rel.slice(appDir.length).split("/");
          const name = parts.pop() ?? "";
          const route = appRoute(parts);
          if (route === null) continue;
          if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(name)) {
            // File-layout facts point at line 1 of the defining file.
            entryPoints.push({ component: component.id, entry: { id: uiEntryId(route), kind: "ui-route", location: { file, line: 1 }, provenance: extracted(ID) } });
          } else if (/^route\.(ts|js)$/.test(name)) {
            const methods = ctx.cache.file(ID, VERSION, file, () => exportedHttpMethods(ctx.sources.get(file)));
            for (const { method, line } of methods) {
              entryPoints.push({ component: component.id, entry: { id: httpEntryId(method, route), kind: "http", location: { file, line }, provenance: extracted(ID) } });
            }
          }
        } else if (pagesDir !== undefined && PAGE_EXTENSIONS.test(rel)) {
          const segments = rel.slice(pagesDir.length).replace(PAGE_EXTENSIONS, "").split("/");
          const route = pagesRoute(segments);
          if (route === null) continue;
          const isApi = segments[0] === "api";
          entryPoints.push({
            component: component.id,
            // A Pages Router API route handles every method in one function.
            entry: { id: isApi ? httpEntryId("ALL", route) : uiEntryId(route), kind: isApi ? "http" : "ui-route", location: { file, line: 1 }, provenance: extracted(ID) },
          });
        }
      }
    }
    return { entryPoints };
  },
};

