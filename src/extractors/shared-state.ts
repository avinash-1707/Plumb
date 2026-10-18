import ts from "typescript";
import { stateId } from "../map/ids.ts";
import type { Loc, NodeId, SharedState, SharedStateKind } from "../map/types.ts";
import { forEachDescendant, isCodeFile, locOf, stringValue } from "./source.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "shared-state";
const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const COLLECTION_MUTATORS = new Set(["set", "add", "delete", "clear"]);
const TIMERS = new Set(["setInterval", "setTimeout"]);
const LISTENER_METHODS = new Set(["on", "addListener"]);

function timerCall(node: ts.Node): ts.CallExpression | undefined {
  // Look through the expression (e.g. setInterval(...).unref()) but never into function bodies.
  let found: ts.CallExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (found !== undefined || ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && TIMERS.has(n.expression.text)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function assignmentsTo(sf: ts.SourceFile, name: string): Loc[] {
  const locs: Loc[] = [];
  forEachDescendant(sf, (node) => {
    const isTarget = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === name;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && isTarget(node.left)) {
      locs.push(locOf(sf, node));
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && isTarget(node.operand)) {
      locs.push(locOf(sf, node));
    }
  });
  return locs;
}

function collectionMutations(sf: ts.SourceFile, name: string): Loc[] {
  const locs: Loc[] = [];
  forEachDescendant(sf, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      COLLECTION_MUTATORS.has(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === name
    ) {
      locs.push(locOf(sf, node));
    }
  });
  return locs;
}

/** Module-scope state in one file: let bindings, Map/Set collections, timers, and listeners. */
export function moduleState(sf: ts.SourceFile): SharedState[] {
  const found: SharedState[] = [];
  const add = (name: string, kind: SharedStateKind, node: ts.Node, mutatedFrom: Loc[]): void => {
    found.push({ id: stateId(sf.fileName, name), kind, location: locOf(sf, node), mutatedFrom, provenance: extracted(ID) });
  };
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        if (init !== undefined && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && COLLECTIONS.has(init.expression.text)) {
          add(name, "cache", decl, collectionMutations(sf, name));
        } else if (init !== undefined && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && TIMERS.has(init.expression.text)) {
          add(name, "timer", decl, []);
        } else if (isLet) {
          add(name, "global-mutable", decl, assignmentsTo(sf, name));
        }
      }
    } else if (ts.isExpressionStatement(statement)) {
      const expr = statement.expression;
      if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && LISTENER_METHODS.has(expr.expression.name.text)) {
        const target = expr.expression.expression.getText(sf);
        const event = stringValue(expr.arguments[0]);
        const line = String(locOf(sf, expr).line);
        add(`${target}.${expr.expression.name.text}${event === undefined ? `@${line}` : `:${event}`}`, "listener", expr, []);
        continue;
      }
      const timer = timerCall(expr);
      if (timer !== undefined && ts.isIdentifier(timer.expression)) {
        add(`${timer.expression.text}@${String(locOf(sf, timer).line)}`, "timer", timer, []);
      }
    }
  }
  return found;
}

export const sharedState: Extractor = {
  id: ID,
  version: "1",
  run(ctx) {
    const state: Array<{ component: NodeId; state: SharedState }> = [];
    for (const component of ctx.components) {
      for (const file of ctx.filesOf(component.id).filter(isCodeFile)) {
        for (const s of moduleState(ctx.sources.get(file))) state.push({ component: component.id, state: s });
      }
    }
    return { state };
  },
};
