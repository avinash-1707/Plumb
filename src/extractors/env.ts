import path from "node:path";
import ts from "typescript";
import { envVarId } from "../map/ids.ts";
import { compareStrings } from "../map/serialize.ts";
import type { Edge, Loc, NodeId, Resource } from "../map/types.ts";
import { forEachDescendant, isCodeFile, isProcessEnv, locOf } from "./source.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "env";
const VERSION = "1";
const ENV_FILES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function isImportMetaEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** Every env var read in a file: process.env.X, process.env["X"], import.meta.env.X, const { X } = process.env. */
export function envReads(sf: ts.SourceFile): Array<{ name: string; loc: Loc }> {
  const reads: Array<{ name: string; loc: Loc }> = [];
  forEachDescendant(sf, (node) => {
    if (ts.isPropertyAccessExpression(node) && (isProcessEnv(node.expression) || isImportMetaEnv(node.expression))) {
      reads.push({ name: node.name.text, loc: locOf(sf, node) });
    } else if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
      reads.push({ name: node.argumentExpression.text, loc: locOf(sf, node) });
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) reads.push({ name: key.text, loc: locOf(sf, el) });
      }
    }
  });
  return reads;
}

export const env: Extractor = {
  id: ID,
  version: VERSION,
  run(ctx) {
    const defined = new Map<string, Loc>();
    for (const file of ctx.files.filter((f) => ENV_FILES.has(path.posix.basename(f))).sort(compareStrings)) {
      ctx.sources.text(file).split("\n").forEach((line, i) => {
        const name = KEY.exec(line)?.[1];
        if (name !== undefined && !defined.has(name)) defined.set(name, { file, line: i + 1 });
      });
    }

    const used = new Set<string>();
    const edges: Array<{ component: NodeId; edge: Edge }> = [];
    for (const component of ctx.components) {
      const byName = new Map<string, Loc[]>();
      for (const file of ctx.filesOf(component.id).filter(isCodeFile)) {
        for (const read of ctx.cache.file(ID, VERSION, file, () => envReads(ctx.sources.get(file)))) {
          byName.set(read.name, [...(byName.get(read.name) ?? []), read.loc]);
        }
      }
      for (const [name, evidence] of byName) {
        used.add(name);
        edges.push({ component: component.id, edge: { kind: "uses-env", to: envVarId(name), evidence, provenance: extracted(ID) } });
      }
    }

    const resources: Resource[] = [...new Set([...defined.keys(), ...used])].map((name) => ({
      id: envVarId(name),
      kind: "env-var",
      definedAt: defined.get(name) ?? null,
      provenance: extracted(ID),
    }));
    return { resources, edges };
  },
};
