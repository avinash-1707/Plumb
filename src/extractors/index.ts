import { compose } from "./compose.ts";
import { dbAccess } from "./db-access.ts";
import { depcruiseImports } from "./depcruise-imports.ts";
import { drizzleSchema } from "./drizzle-schema.ts";
import { env } from "./env.ts";
import { expressRoutes } from "./express-routes.ts";
import { fetchCalls } from "./fetch-calls.ts";
import { nextRoutes } from "./next-routes.ts";
import { prismaSchema } from "./prisma-schema.ts";
import { sharedState } from "./shared-state.ts";
import type { Extractor } from "./types.ts";
import { workspace } from "./workspace.ts";

/**
 * Run order matters: workspace defines components; schemas, compose, env and routes define the nodes that
 * edge extractors (imports, db-access, fetch-calls) point at.
 */
export const EXTRACTORS: readonly Extractor[] = [
  workspace,
  prismaSchema,
  drizzleSchema,
  compose,
  env,
  nextRoutes,
  expressRoutes,
  depcruiseImports,
  dbAccess,
  fetchCalls,
  sharedState,
];
