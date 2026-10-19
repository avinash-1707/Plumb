import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the TypeScript entry directly; Node >=22.18 strips types without a flag.
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("plumb bin entry", () => {
  it("propagates run()'s exit code to the process", () => {
    const r = spawnSync(process.execPath, [cli, "frobnicate"], { encoding: "utf8" });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('unknown command "frobnicate"');
  });
});

describe("plugin shim", () => {
  it("pins the npx fallback to the version the package and plugin manifest carry", () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
    const plugin = (JSON.parse(readFileSync(path.join(root, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
    expect(plugin).toBe(version);
    expect(readFileSync(path.join(root, "plugin/bin/plumb"), "utf8")).toContain(`npx -y @plumb-cli/plumb@${version} "$@"`);
  });
});
