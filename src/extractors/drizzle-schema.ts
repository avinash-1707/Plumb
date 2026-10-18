import ts from "typescript";
import { dbTableId } from "../map/ids.ts";
import type { Loc, Resource } from "../map/types.ts";
import { forEachDescendant, isCodeFile, locOf, stringValue, type SourceCache } from "./source.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "drizzle-schema";
const TABLE_FACTORIES = new Set(["pgTable", "mysqlTable", "sqliteTable"]);

export interface DrizzleTable {
  table: string;
  /** Variable the table is bound to (`export const orders = pgTable("orders", ...)`), if any. */
  variable: string | null;
  loc: Loc;
}

export function drizzleTables(sf: ts.SourceFile): DrizzleTable[] {
  const tables: DrizzleTable[] = [];
  forEachDescendant(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
    const table = stringValue(node.arguments[0]);
    if (!TABLE_FACTORIES.has(callee) || table === undefined) return;
    const variable = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : null;
    tables.push({ table, variable, loc: locOf(sf, node) });
  });
  return tables;
}

/** Drizzle tables across the project; only files that import drizzle-orm are parsed. */
export function projectDrizzleTables(files: readonly string[], sources: SourceCache): DrizzleTable[] {
  return files.filter((f) => isCodeFile(f) && sources.text(f).includes("drizzle-orm")).flatMap((f) => drizzleTables(sources.get(f)));
}

export const drizzleSchema: Extractor = {
  id: ID,
  version: "1",
  run(ctx) {
    const resources: Resource[] = projectDrizzleTables(ctx.files, ctx.sources).map((t) => ({
      id: dbTableId(t.table),
      kind: "db-table",
      definedAt: t.loc,
      provenance: extracted(ID),
    }));
    return { resources };
  },
};
