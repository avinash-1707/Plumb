import { dbTableId } from "../map/ids.ts";
import type { Resource } from "../map/types.ts";
import { type Extractor, extracted } from "./types.ts";

const ID = "prisma-schema";

export interface PrismaModel {
  model: string;
  /** Prisma Client accessor: `prisma.<accessor>.findMany()`. */
  accessor: string;
  table: string;
  file: string;
  line: number;
}

// SIMPLIFIED: line-based grammar subset (model blocks, @@map, // comments). Switch to Prisma's own parser
// (@prisma/internals getDMMF) if real schemas break it.
export function parsePrismaModels(file: string, text: string): PrismaModel[] {
  const models: PrismaModel[] = [];
  let current: PrismaModel | null = null;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const start = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
    if (current === null && start?.[1] !== undefined) {
      const model = start[1];
      current = { model, accessor: model.charAt(0).toLowerCase() + model.slice(1), table: model, file, line: i + 1 };
      return;
    }
    if (current === null) return;
    const mapped = /^@@map\(\s*(?:name:\s*)?"([^"]+)"\s*\)/.exec(line);
    if (mapped?.[1] !== undefined) current.table = mapped[1];
    if (line.startsWith("}")) {
      models.push(current);
      current = null;
    }
  });
  return models;
}

export function prismaModels(files: readonly string[], read: (file: string) => string): PrismaModel[] {
  return files.filter((f) => f.endsWith(".prisma")).flatMap((f) => parsePrismaModels(f, read(f)));
}

export const prismaSchema: Extractor = {
  id: ID,
  version: "1",
  run(ctx) {
    const resources: Resource[] = prismaModels(ctx.files, (f) => ctx.sources.text(f)).map((m) => ({
      id: dbTableId(m.table),
      kind: "db-table",
      definedAt: { file: m.file, line: m.line },
      provenance: extracted(ID),
    }));
    return { resources };
  },
};
