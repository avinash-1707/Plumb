import { describe, expect, it } from "vitest";
import { ExitCode } from "../src/exit-codes.ts";
import { main, run } from "../src/main.ts";
import { readVersion } from "../src/version.ts";

async function capture(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

describe("run", () => {
  it("prints the package version", async () => {
    const r = await capture(["--version"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.stdout).toBe(`${readVersion()}\n`);
  });

  it("prints usage on --help", async () => {
    const r = await capture(["-h"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.stdout).toContain("Usage: plumb");
  });

  it.each([
    [[], "missing command"],
    [["frobnicate"], 'unknown command "frobnicate"'],
    [["--nope"], "Unknown option '--nope'"],
    [["--json", "map"], "options go after the command"],
    [["map", "show"], "map show needs a node id"],
    [["map", "frobnicate"], 'unknown map subcommand "frobnicate"'],
  ])("rejects %j as invalid usage", async (argv, message) => {
    const r = await capture(argv);
    expect(r.code).toBe(ExitCode.InvalidUsage);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe("");
  });
});

describe("main", () => {
  it("maps an unexpected error to CouldNotComplete with the cause on stderr", async () => {
    let stderr = "";
    const code = await main(["--version"], {
      stdout: () => {
        throw new Error("EPIPE: broken pipe");
      },
      stderr: (t) => (stderr += t),
    });
    expect(code).toBe(ExitCode.CouldNotComplete);
    expect(stderr).toContain("plumb: internal error");
    expect(stderr).toContain("EPIPE: broken pipe");
  });
});
