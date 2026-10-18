import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.ts";
import { buildMap, renderMap } from "../src/map/build.ts";
import { gitInit, tempDir } from "./helpers/project.ts";

const EXAMPLE = fileURLToPath(new URL("../examples/node-web/", import.meta.url));
const GOLDEN = path.join(EXAMPLE, ".plumb-golden/map");
// The golden can't list its own hashes, so extraction ignores it; the M1 golden stores 40 zeros for HEAD.
const CONFIG = { schemaVersion: 1 as const, ignore: [".plumb-golden/**"] };
const PLACEHOLDER_HEAD = "0".repeat(40);

function goldenFiles(): Map<string, string> {
  const rels = ["manifest.json", "resources.json", ...readdirSync(path.join(GOLDEN, "components")).map((f) => `components/${f}`)];
  return new Map(rels.map((rel) => [rel, readFileSync(path.join(GOLDEN, rel), "utf8")]));
}

async function extract(root: string): Promise<Map<string, string>> {
  const { map } = await buildMap({ root, config: CONFIG });
  return renderMap({ ...map, manifest: { ...map.manifest, builtAtCommit: PLACEHOLDER_HEAD } });
}

describe("map of examples/node-web", () => {
  it("has its dependencies installed", () => {
    expect(existsSync(path.join(EXAMPLE, "node_modules")), "run: pnpm --dir examples/node-web install --frozen-lockfile").toBe(true);
  });

  it("matches the golden map byte for byte, and a second build changes nothing", async () => {
    const first = await extract(EXAMPLE);
    expect(Object.fromEntries(first)).toEqual(Object.fromEntries(goldenFiles()));
    expect(Object.fromEntries(await extract(EXAMPLE))).toEqual(Object.fromEntries(first));
  });

  it("records an extractor failure instead of a silent partial map when node_modules is missing", async () => {
    const copy = tempDir();
    cpSync(EXAMPLE, copy, {
      recursive: true,
      filter: (src) => !/(^|\/)(node_modules|\.plumb-golden|\.next|generated|\.env)$/.test(path.relative(EXAMPLE, src)),
    });
    gitInit(copy);

    const { map } = await buildMap({ root: copy, config: CONFIG });
    const failures = map.manifest.extractorFailures;
    expect(failures.map((f) => [f.extractor, f.component])).toEqual([
      ["depcruise-imports", "component:api"],
      ["depcruise-imports", "component:db"],
      ["depcruise-imports", "component:web"],
    ]);
    expect(failures.every((f) => f.reason.startsWith("dependencies not installed") && f.fallback === "none")).toBe(true);
    // Facts that don't need node_modules are still extracted; only import edges are withheld.
    expect(map.components.flatMap((c) => c.edges).some((e) => e.kind === "imports")).toBe(false);
    expect(map.resources.resources.length).toBe(13);

    let stderr = "";
    const code = await main(["map", "--cwd", copy], { stdout: () => undefined, stderr: (t) => (stderr += t) });
    expect(code).toBe(2);
    expect(stderr).toContain("depcruise-imports (component:web): dependencies not installed");
    expect(existsSync(path.join(copy, ".plumb/map/manifest.json"))).toBe(true);
  });
});
