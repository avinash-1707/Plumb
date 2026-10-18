import ts from "typescript";
import { parseHttpEntryId } from "../map/ids.ts";
import type { Edge, NodeId, Provenance } from "../map/types.ts";
import { forEachDescendant, importBindings, isCodeFile, locOf, stringValue } from "./source.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "fetch-calls";
const VERSION = "1";
const AXIOS_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const HOLE = "\u0000";

/** A request path: literal segments, or null where a template substitution makes the segment unknown. */
export interface UrlPattern {
  segments: Array<string | null>;
  literal: boolean;
}

function toSegments(text: string): Array<string | null> {
  const pathOnly = text.split(/[?#]/)[0] ?? "";
  return pathOnly
    .split("/")
    .filter((s) => s !== "")
    .map((s) => (s.includes(HOLE) ? null : s));
}

/**
 * Same-origin paths only: "/api/x" or `${base}/api/x` where the leading substitution is an origin.
 * Absolute URLs with a host are external calls, not edges to this repo's routes.
 */
export function urlPattern(node: ts.Expression | undefined): UrlPattern | null {
  if (node === undefined) return null;
  const literal = stringValue(node);
  if (literal !== undefined) return literal.startsWith("/") && !literal.startsWith("//") ? { segments: toSegments(literal), literal: true } : null;
  if (!ts.isTemplateExpression(node)) return null;
  let text = node.head.text;
  let spans = node.templateSpans;
  if (text === "" && spans[0]?.literal.text.startsWith("/") === true) {
    text = spans[0].literal.text;
    spans = ts.factory.createNodeArray(spans.slice(1));
  }
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  for (const span of spans) text += HOLE + span.literal.text;
  return { segments: toSegments(text), literal: false };
}

function isParam(segment: string): boolean {
  return segment.startsWith(":") || (segment.startsWith("[") && !segment.startsWith("[..."));
}

/** Number of literal segments that matched exactly, or null when the pattern cannot reach this route. */
export function matchRoute(pattern: readonly (string | null)[], routePath: string): number | null {
  const route = routePath.split("/").filter((s) => s !== "");
  let score = 0;
  for (let i = 0; i < route.length; i++) {
    const r = route[i] ?? "";
    if (r.startsWith("[[...")) return score;
    if (r.startsWith("[...")) return pattern.length > i ? score : null;
    if (i >= pattern.length) return null;
    const p = pattern[i];
    if (isParam(r) || p === null) continue;
    if (p !== r) return null;
    score++;
  }
  return pattern.length === route.length ? score : null;
}

/** Method from a fetch/axios init object: the literal value, "GET" when absent, null when computed. */
function methodFromInit(init: ts.Expression | undefined): string | null {
  if (init === undefined) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return null;
  for (const prop of init.properties) {
    if (ts.isSpreadAssignment(prop)) return null;
    if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && prop.name.text === "method") {
      return stringValue(prop.initializer)?.toUpperCase() ?? null;
    }
  }
  return "GET";
}

interface Call {
  url: ts.Expression | undefined;
  method: string | null;
  node: ts.Node;
}

/** A same-origin request found in a file, in cacheable form. */
export interface RawCall {
  pattern: UrlPattern;
  method: string | null;
  line: number;
}

export function fileCalls(sf: ts.SourceFile): RawCall[] {
  return httpCalls(sf).flatMap((call) => {
    const pattern = urlPattern(call.url);
    return pattern === null ? [] : [{ pattern, method: call.method, line: locOf(sf, call.node).line }];
  });
}

function httpCalls(sf: ts.SourceFile): Call[] {
  const bindings = importBindings(sf);
  const isAxios = (n: ts.Node): boolean => ts.isIdentifier(n) && bindings.get(n.text)?.module === "axios" && bindings.get(n.text)?.imported === "default";
  const calls: Call[] = [];
  forEachDescendant(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const [first, second] = node.arguments;
    const isFetch =
      (ts.isIdentifier(callee) && callee.text === "fetch") ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch" && ts.isIdentifier(callee.expression) && ["globalThis", "window", "self"].includes(callee.expression.text));
    if (isFetch) calls.push({ url: first, method: methodFromInit(second), node });
    else if (ts.isPropertyAccessExpression(callee) && isAxios(callee.expression) && AXIOS_METHODS.has(callee.name.text)) {
      calls.push({ url: first, method: callee.name.text.toUpperCase(), node });
    } else if (isAxios(callee)) {
      const config = first !== undefined && ts.isObjectLiteralExpression(first) ? first : undefined;
      const urlProp = config?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "url");
      calls.push({ url: config === undefined ? first : urlProp?.initializer, method: methodFromInit(config ?? second), node });
    }
  });
  return calls;
}

export const fetchCalls: Extractor = {
  id: ID,
  version: VERSION,
  run(ctx) {
    const routes = ctx.entryPoints.flatMap(({ entry }) => {
      const parsed = parseHttpEntryId(entry.id);
      return parsed === null ? [] : [{ id: entry.id, ...parsed }];
    });
    const edges: Array<{ component: NodeId; edge: Edge }> = [];
    if (routes.length === 0) return { edges };

    for (const component of ctx.components) {
      for (const file of ctx.filesOf(component.id).filter(isCodeFile)) {
        for (const call of ctx.cache.file(ID, VERSION, file, () => fileCalls(ctx.sources.get(file)))) {
          const { pattern } = call;
          const scored = routes
            .filter((r) => call.method === null || r.method === call.method || r.method === "ALL")
            .flatMap((r) => {
              const score = matchRoute(pattern.segments, r.path);
              return score === null ? [] : [{ id: r.id, score }];
            });
          if (scored.length === 0) continue;
          const best = Math.max(...scored.map((s) => s.score));
          const top = scored.filter((s) => s.score === best);
          // Exact only when nothing about the target was guessed: literal path, literal method, one route.
          const provenance: Provenance =
            top.length > 1
              ? { source: "inferred", confidence: "low" }
              : pattern.literal && call.method !== null
                ? extracted(ID)
                : { source: "inferred", confidence: "high" };
          for (const t of top) edges.push({ component: component.id, edge: { kind: "calls-http", to: t.id, evidence: [{ file, line: call.line }], provenance } });
        }
      }
    }
    return { edges };
  },
};
