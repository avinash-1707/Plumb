import ts from "typescript";
import { dbTableId } from "../map/ids.ts";
import type { Edge, Loc, NodeId } from "../map/types.ts";
import { drizzleTables, projectDrizzleTables } from "./drizzle-schema.ts";
import { prismaModels } from "./prisma-schema.ts";
import { forEachDescendant, importBindings, isCodeFile, locOf } from "./source.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "db-access";
const VERSION = "1";

const PRISMA_READS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const PRISMA_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
const DRIZZLE_WRITES = new Set(["insert", "update", "delete"]);
const DRIZZLE_QUERY_READS = new Set(["findMany", "findFirst"]);

type Access = { kind: "reads" | "writes"; table: string; loc: Loc };

/** Per-file candidates, independent of which models and tables exist, so they can be cached by file content. */
export interface DbCandidates {
  /** `<identifier>.<accessor>.<op>(` */
  prisma: Array<{ accessor: string; op: string; line: number }>;
  drizzle: {
    tables: Array<{ variable: string; table: string }>;
    /** local name -> imported name */
    bindings: Record<string, string>;
    calls: Array<{ kind: "from" | "write" | "query"; name: string; line: number }>;
  };
}

export function dbCandidates(sf: ts.SourceFile): DbCandidates {
  const result: DbCandidates = {
    prisma: [],
    drizzle: {
      tables: drizzleTables(sf).flatMap((t) => (t.variable === null ? [] : [{ variable: t.variable, table: t.table }])),
      bindings: Object.fromEntries([...importBindings(sf)].map(([local, b]) => [local, b.imported])),
      calls: [],
    },
  };
  forEachDescendant(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const name = node.expression.name.text;
    const receiver = node.expression.expression;
    const line = locOf(sf, node).line;
    if ((PRISMA_READS.has(name) || PRISMA_WRITES.has(name)) && ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression)) {
      result.prisma.push({ accessor: receiver.name.text, op: name, line });
    }
    const arg = node.arguments[0];
    // .from() only on a query-builder call (select()...), writes only on a client-like receiver: not Array.from or map.delete.
    if (name === "from" && ts.isCallExpression(receiver) && arg !== undefined && ts.isIdentifier(arg)) {
      result.drizzle.calls.push({ kind: "from", name: arg.text, line });
    } else if (DRIZZLE_WRITES.has(name) && (ts.isIdentifier(receiver) || ts.isPropertyAccessExpression(receiver)) && arg !== undefined && ts.isIdentifier(arg)) {
      result.drizzle.calls.push({ kind: "write", name: arg.text, line });
    } else if (
      DRIZZLE_QUERY_READS.has(name) &&
      ts.isPropertyAccessExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "query"
    ) {
      result.drizzle.calls.push({ kind: "query", name: receiver.name.text, line });
    }
  });
  return result;
}

/** Only the top-level model counts; nested relation writes are not edges. */
export function prismaAccesses(file: string, candidates: DbCandidates, tableByAccessor: ReadonlyMap<string, string>): Access[] {
  return candidates.prisma.flatMap((c) => {
    const table = tableByAccessor.get(c.accessor);
    if (table === undefined) return [];
    return [{ kind: PRISMA_READS.has(c.op) ? ("reads" as const) : ("writes" as const), table, loc: { file, line: c.line } }];
  });
}

/** Resolves Drizzle calls through a local table binding or an import of a uniquely named table variable. */
export function drizzleAccesses(file: string, candidates: DbCandidates, tableByVariable: ReadonlyMap<string, string>): Access[] {
  const { tables, bindings, calls } = candidates.drizzle;
  const local = new Map(tables.map((t) => [t.variable, t.table]));
  const tableOf = (name: string): string | undefined => local.get(name) ?? (name in bindings ? tableByVariable.get(bindings[name] ?? "") : undefined);
  return calls.flatMap((c) => {
    const table = c.kind === "query" ? (tableByVariable.get(c.name) ?? local.get(c.name)) : tableOf(c.name);
    if (table === undefined) return [];
    return [{ kind: c.kind === "write" ? ("writes" as const) : ("reads" as const), table, loc: { file, line: c.line } }];
  });
}

export const dbAccess: Extractor = {
  id: ID,
  version: VERSION,
  run(ctx) {
    const tableByAccessor = new Map(prismaModels(ctx.files, (f) => ctx.sources.text(f)).map((m) => [m.accessor, m.table]));
    const drizzle = projectDrizzleTables(ctx);
    // A variable name bound to two different tables is ambiguous across files; leave it unresolved.
    const variableCounts = new Map<string, number>();
    for (const t of drizzle) if (t.variable !== null) variableCounts.set(t.variable, (variableCounts.get(t.variable) ?? 0) + 1);
    const tableByVariable = new Map(drizzle.flatMap((t) => (t.variable !== null && variableCounts.get(t.variable) === 1 ? [[t.variable, t.table] as const] : [])));

    const edges: Array<{ component: NodeId; edge: Edge }> = [];
    if (tableByAccessor.size === 0 && drizzle.length === 0) return { edges };
    for (const component of ctx.components) {
      const grouped = new Map<string, { kind: "reads" | "writes"; table: string; evidence: Loc[] }>();
      for (const file of ctx.filesOf(component.id).filter(isCodeFile)) {
        const candidates = ctx.cache.file(ID, VERSION, file, () => dbCandidates(ctx.sources.get(file)));
        const accesses = [
          ...prismaAccesses(file, candidates, tableByAccessor),
          // Without a drizzle-orm table anywhere, a local pgTable() is not a resource and its calls are not edges.
          ...(drizzle.length > 0 ? drizzleAccesses(file, candidates, tableByVariable) : []),
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
