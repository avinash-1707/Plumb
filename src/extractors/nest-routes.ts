import ts from "typescript";
import { httpEntryId } from "../map/ids.ts";
import type { EntryPoint, ExtractorFailure, Loc, NodeId } from "../map/types.ts";
import { joinRoutePath } from "./express-routes.ts";
import { importBindings, isCodeFile, locOf, stringValue } from "./source.ts";
import { type Extractor, extracted, failure } from "./types.ts";

const ID = "nest-routes";
const VERSION = "1";
const METHOD_DECORATORS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Head: "HEAD",
  Options: "OPTIONS",
  All: "ALL",
};

/** One file's controllers and app-level path settings, in cacheable (JSON) form. */
export interface FileNest {
  routes: Array<{ method: string; path: string; loc: Loc }>;
  /** setGlobalPrefix calls; `value` is null when the prefix isn't a literal. */
  prefixes: Array<{ value: string | null; loc: Loc; options: boolean }>;
  /** NestFactory.create* calls: more than one app in a component means a prefix can't be pinned to its routes. */
  bootstraps: Loc[];
  /** Paths Plumb can't read, or settings (versioning, RouterModule) that change paths in ways it doesn't model. */
  unresolved: Array<{ loc: Loc; what: string }>;
}

/** Literal paths of a decorator argument: none means "", a string or string array its values, anything else null. */
function decoratorPaths(arg: ts.Expression | undefined, objectKey: string | null): string[] | null {
  if (arg === undefined) return [""];
  const literal = stringValue(arg);
  if (literal !== undefined) return [literal];
  if (ts.isArrayLiteralExpression(arg)) {
    const values = arg.elements.map((el) => stringValue(el));
    return values.every((v) => v !== undefined) ? values : null;
  }
  if (objectKey !== null && ts.isObjectLiteralExpression(arg)) {
    const prop = arg.properties.find((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === objectKey);
    return prop === undefined ? [""] : ts.isPropertyAssignment(prop) ? decoratorPaths(prop.initializer, null) : null;
  }
  return null;
}

export function fileNest(sf: ts.SourceFile): FileNest {
  const bindings = importBindings(sf);
  const nestDecorator = (d: ts.Decorator): { name: string; arg: ts.Expression | undefined } | null => {
    const call = d.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
    const binding = bindings.get(call.expression.text);
    return binding?.module === "@nestjs/common" ? { name: binding.imported, arg: call.arguments[0] } : null;
  };
  const result: FileNest = { routes: [], prefixes: [], bootstraps: [], unresolved: [] };
  const isMethodDecoratorCall = (n: ts.Node): boolean =>
    ts.isCallExpression(n) && ts.isIdentifier(n.expression) && bindings.get(n.expression.text)?.module === "@nestjs/common" && METHOD_DECORATORS[bindings.get(n.expression.text)?.imported ?? ""] !== undefined;

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const controller = (ts.getDecorators(node) ?? []).map(nestDecorator).find((d) => d?.name === "Controller");
      if (controller !== undefined && controller !== null) {
        const bases = decoratorPaths(controller.arg, "path");
        if (bases === null) result.unresolved.push({ loc: locOf(sf, node), what: "a @Controller path that isn't a literal" });
        // Nest registers a base class's decorated methods too; they live in another class, maybe another file.
        if (node.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) === true) {
          result.unresolved.push({ loc: locOf(sf, node), what: "a controller that extends another class, whose inherited routes aren't read" });
        }
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          for (const decorator of ts.getDecorators(member) ?? []) {
            const d = nestDecorator(decorator);
            const method = d === null ? undefined : METHOD_DECORATORS[d.name];
            if (d === null || method === undefined) continue;
            const loc = locOf(sf, decorator);
            const paths = decoratorPaths(d.arg, null);
            if (paths === null) {
              result.unresolved.push({ loc, what: `a @${d.name} path that isn't a literal` });
              continue;
            }
            for (const base of bases ?? [""]) for (const p of paths) result.routes.push({ method, path: joinRoutePath(base, p), loc });
          }
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const receiver = node.expression.expression;
      if (name.startsWith("create") && ts.isIdentifier(receiver) && bindings.get(receiver.text)?.module === "@nestjs/core" && bindings.get(receiver.text)?.imported === "NestFactory") {
        result.bootstraps.push(locOf(sf, node));
      } else if (name === "setGlobalPrefix") {
        result.prefixes.push({ value: stringValue(node.arguments[0]) ?? null, loc: locOf(sf, node), options: node.arguments.length > 1 });
      } else if (name === "enableVersioning") {
        result.unresolved.push({ loc: locOf(sf, node), what: "enableVersioning, which adds version segments to paths" });
      }
    }
    // applyDecorators(Get(...), ...) makes a custom decorator whose routes this can't attribute to a controller.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.get(node.expression.text)?.module === "@nestjs/common" && bindings.get(node.expression.text)?.imported === "applyDecorators" && node.arguments.some(isMethodDecoratorCall)) {
      result.unresolved.push({ loc: locOf(sf, node), what: "a composed route decorator (applyDecorators), whose routes aren't read" });
    }
    if (ts.isIdentifier(node) && node.text === "RouterModule" && bindings.get("RouterModule")?.module === "@nestjs/core" && !ts.isImportSpecifier(node.parent)) {
      result.unresolved.push({ loc: locOf(sf, node), what: "RouterModule, which adds module path prefixes" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

export const nestRoutes: Extractor = {
  id: ID,
  version: VERSION,
  run(ctx) {
    const entryPoints: Array<{ component: NodeId; entry: EntryPoint }> = [];
    const failures: ExtractorFailure[] = [];
    for (const component of ctx.components.filter((c) => c.framework.includes("nest"))) {
      const facts = ctx.filesOf(component.id)
        .filter(isCodeFile)
        .map((file) => ctx.cache.file(ID, VERSION, file, () => fileNest(ctx.sources.get(file))));
      const prefixes = facts.flatMap((f) => f.prefixes);
      const values = [...new Set(prefixes.map((p) => p.value))];
      const at = (loc: Loc): string => `${loc.file}:${String(loc.line)}`;
      for (const p of prefixes) {
        if (p.value === null) failures.push(failure(ID, component.id, `can't read the global prefix at ${at(p.loc)}; routes may be missing it`));
        else if (p.options) failures.push(failure(ID, component.id, `the global prefix at ${at(p.loc)} has options (exclude); excluded routes still get it here`));
      }
      const bootstraps = facts.flatMap((f) => f.bootstraps);
      const ambiguous = values.length > 1 || (prefixes.length > 0 && bootstraps.length > 1);
      if (values.length > 1) failures.push(failure(ID, component.id, `more than one global prefix (${prefixes.map((p) => at(p.loc)).join(", ")}); routes use none`));
      else if (ambiguous) failures.push(failure(ID, component.id, `a global prefix with more than one app (${bootstraps.map(at).join(", ")}); routes use none`));
      const prefix = !ambiguous && values.length === 1 ? (values[0] ?? "") : "";
      for (const f of facts) {
        for (const u of f.unresolved) failures.push(failure(ID, component.id, `${at(u.loc)}: ${u.what}; routes there may be missing or have wrong paths`));
        for (const r of f.routes) {
          entryPoints.push({ component: component.id, entry: { id: httpEntryId(r.method, joinRoutePath(prefix, r.path)), kind: "http", location: r.loc, provenance: extracted(ID) } });
        }
      }
    }
    return { entryPoints, failures };
  },
};
