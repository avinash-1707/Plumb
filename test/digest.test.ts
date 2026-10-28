import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hookCommand } from "../src/commands/hooks.ts";
import { DIGEST_MAX_CHARS, sessionDigest } from "../src/hooks/digest.ts";
import { main } from "../src/main.ts";
import { makeProject } from "./helpers/project.ts";

const quiet = { stdout: () => undefined, stderr: () => undefined };

async function mapped(files: Record<string, string>): Promise<string> {
  const root = makeProject(files);
  await main(["map", "--cwd", root], quiet);
  return root;
}

describe("session digest", () => {
  it("names the commands and each component with its edges, and nothing for a repo without a map", async () => {
    const root = await mapped({
      "package.json": JSON.stringify({ name: "shop", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      "packages/db/package.json": JSON.stringify({ name: "@shop/db", main: "src/index.ts" }),
      "packages/db/src/index.ts": "export const db = 1;",
      "apps/api/package.json": JSON.stringify({ name: "api" }),
      "apps/api/src/main.ts": 'import { db } from "../../../packages/db/src/index.ts";\nexport const x = db;',
    });
    const digest = sessionDigest(root) ?? "";
    expect(digest).toContain("plumb impact --staged");
    expect(digest).toContain("Components (2):");
    expect(digest).toContain("- api (app, apps/api; 0 entry points; uses db)");
    expect(digest).toContain("- db (package, packages/db; 0 entry points; used by api)");
    expect(sessionDigest(makeProject({ "a.ts": "" }))).toBeNull();
  });

  it("stays under its size cap however many components there are, and can be turned off", async () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "big" }) };
    const components = Array.from({ length: 400 }, (_, i) => ({ id: `component-with-a-long-name-${String(i)}`, include: [`c${String(i)}/**`] }));
    for (let i = 0; i < 400; i++) files[`c${String(i)}/x.ts`] = "export const x = 1;";
    files[".plumb/config.json"] = JSON.stringify({ schemaVersion: 1, components });
    const root = await mapped(files);
    const digest = sessionDigest(root) ?? "";
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest).toMatch(/- \.\.\. \d+ more: plumb map show <component>/);

    writeFileSync(path.join(root, ".plumb/config.json"), JSON.stringify({ schemaVersion: 1, components, sessionDigest: false }));
    expect(sessionDigest(root)).toBeNull();
  });

  it("is printed by the SessionStart hook for the payload's cwd", async () => {
    const root = await mapped({ "package.json": JSON.stringify({ name: "solo" }), "src/a.ts": "export const a = 1;" });
    let out = "";
    const code = await hookCommand(["claude-session-start"], { stdout: (t) => (out += t), stderr: () => undefined }, () => JSON.stringify({ cwd: root, hook_event_name: "SessionStart" }));
    expect(code).toBe(0);
    expect(out).toContain("Components (1):");
  });
});
