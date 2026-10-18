import ts from "typescript";
import { dbTableId } from "../map/ids.ts";
import type { Edge, Loc, NodeId } from "../map/types.ts";
import { drizzleTables, projectDrizzleTables } from "./drizzle-schema.ts";
import { prismaModels } from "./prisma-schema.ts";
import { forEachDescendant, importBindings, isCodeFile, locOf } from "./source.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "db-access";

const PRISMA_READS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const PRISMA_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
const DRIZZLE_WRITES = new Set(["insert", "update", "delete"]);
const DRIZZLE_QUERY_READS = new Set(["findMany", "findFirst"]);

type Access = { kind: "reads" | "writes"; table: string; loc: Loc };

/** `<client>.<model>.<op>(...)`: only the top-level model; nested relation writes are not edges. */
export function prismaAccesses(sf: ts.SourceFile, tableByAccessor: ReadonlyMap<string, string>): Access[] {
  const found: Access[] = [];
  forEachDescendant(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const op = node.expression.name.text;
    const model = node.expression.expression;
    if (!ts.isPropertyAccessExpression(model) || !ts.isIdentifier(model.expression)) return;
    const table = tableByAccessor.get(model.name.text);
    if (table === undefined) return;
    if (PRISMA_READS.has(op)) found.push({ kind: "reads", table, loc: locOf(sf, node) });
    else if (PRISMA_WRITES.has(op)) found.push({ kind: "writes", table, loc: locOf(sf, node) });
  });
  return found;
}

/** Drizzle: select().from(t), insert(t) / update(t) / delete(t), and db.query.<t>.findMany(). */
export function drizzleAccesses(sf: ts.SourceFile, tableByVariable: ReadonlyMap<string, string>): Access[] {
  const local = new Map(drizzleTables(sf).flatMap((t) => (t.variable === null ? [] : [[t.variable, t.table] as const])));
  const bindings = importBindings(sf);
  const tableOf = (node: ts.Node | undefined): string | undefined => {
    if (node === undefined || !ts.isIdentifier(node)) return undefined;
    return local.get(node.text) ?? tableByVariable.get(bindings.get(node.text)?.imported ?? "");
  };
  const found: Access[] = [];
  forEachDescendant(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const name = node.expression.name.text;
    const receiver = node.expression.expression;
    if (name === "from" && ts.isCallExpression(receiver)) {
      const table = tableOf(node.arguments[0]);
      if (table !== undefined) found.push({ kind: "reads", table, loc: locOf(sf, node) });
    } else if (DRIZZLE_WRITES.has(name) && (ts.isIdentifier(receiver) || ts.isPropertyAccessExpression(receiver))) {
      const table = tableOf(node.arguments[0]);
      if (table !== undefined) found.push({ kind: "writes", table, loc: locOf(sf, node) });
    } else if (DRIZZLE_QUERY_READS.has(name)) {
      const target = node.expression.expression;
      if (ts.isPropertyAccessExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === "query") {
        const table = tableByVariable.get(target.name.text) ?? local.get(target.name.text);
        if (table !== undefined) found.push({ kind: "reads", table, loc: locOf(sf, node) });
      }
    }
  });
  return found;
}

export const dbAccess: Extractor = {
  id: ID,
  version: "1",
  run(ctx) {
    const tableByAccessor = new Map(prismaModels(ctx.files, (f) => ctx.sources.text(f)).map((m) => [m.accessor, m.table]));
    const drizzle = projectDrizzleTables(ctx.files, ctx.sources);
    // A variable name bound to two different tables is ambiguous across files; leave it unresolved.
    const variableCounts = new Map<string, number>();
    for (const t of drizzle) if (t.variable !== null) variableCounts.set(t.variable, (variableCounts.get(t.variable) ?? 0) + 1);
    const tableByVariable = new Map(drizzle.flatMap((t) => (t.variable !== null && variableCounts.get(t.variable) === 1 ? [[t.variable, t.table] as const] : [])));

    const edges: Array<{ component: NodeId; edge: Edge }> = [];
    for (const component of ctx.components) {
      const grouped = new Map<string, { kind: "reads" | "writes"; table: string; evidence: Loc[] }>();
      for (const file of ctx.filesOf(component.id).filter(isCodeFile)) {
        const sf = ctx.sources.get(file);
        const accesses = [
          ...(tableByAccessor.size > 0 ? prismaAccesses(sf, tableByAccessor) : []),
          ...(drizzle.length > 0 ? drizzleAccesses(sf, tableByVariable) : []),
        ];
        for (const a of accesses) {
          const key = `${a.kind}:${a.table}`;
          const group = grouped.get(key) ?? { kind: a.kind, table: a.table, evidence: [] };
          group.evidence.push(a.loc);
          grouped.set(key, group);
        }
      }
      for (const g of grouped.values()) {
        edges.push({ component: component.id, edge: { kind: g.kind, to: dbTableId(g.table), evidence: g.evidence, provenance: extracted(ID) } });
      }
    }
    return { edges };
  },
};
