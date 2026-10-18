import path from "node:path";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { serviceId } from "../map/ids.ts";
import type { ExtractorFailure, Resource } from "../map/types.ts";
import { type Extractor, extracted, failure } from "./types.ts";

const ID = "compose";
const COMPOSE_FILES = new Set(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]);

export const compose: Extractor = {
  id: ID,
  version: "1",
  run(ctx) {
    const resources: Resource[] = [];
    const failures: ExtractorFailure[] = [];
    for (const file of ctx.files.filter((f) => COMPOSE_FILES.has(path.posix.basename(f)))) {
      const lineCounter = new LineCounter();
      const doc = parseDocument(ctx.sources.text(file), { lineCounter });
      if (doc.errors.length > 0) {
        failures.push(failure(ID, ctx.componentOf(file)?.id ?? null, `${file} could not be parsed: ${doc.errors[0]?.message ?? "unknown error"}`));
        continue;
      }
      const services = doc.get("services", true);
      if (!isMap(services)) continue;
      for (const pair of services.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.range === undefined || pair.key.range === null) continue;
        resources.push({
          id: serviceId(pair.key.value),
          kind: "service",
          definedAt: { file, line: lineCounter.linePos(pair.key.range[0]).line },
          provenance: extracted(ID),
        });
      }
    }
    return { resources, failures };
  },
};
