import { spawnSync } from "node:child_process";
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
