import { describe, expect, it } from "vitest";
import { installCommand } from "../scripts/trial.ts";

const files = (...present: string[]) => (f: string) => present.includes(f);

describe("trial install command", () => {
  it("uses the declared packageManager version through corepack, without its hash", () => {
    expect(installCommand("pnpm@9.15.0+sha512.abc", files("pnpm-lock.yaml"))).toEqual([
      "corepack", "pnpm@9.15.0", "install", "--frozen-lockfile", "--ignore-scripts",
    ]);
  });

  it("falls back to the lockfile when packageManager is absent", () => {
    expect(installCommand(undefined, files("package-lock.json"))).toEqual(["npm", "ci", "--ignore-scripts"]);
    expect(installCommand(undefined, files("bun.lockb"))[0]).toBe("bun");
    expect(installCommand(undefined, files())).toEqual(["npm", "install", "--ignore-scripts"]);
  });

  it("tells yarn berry from classic, keeping lifecycle scripts off in both", () => {
    expect(installCommand("yarn@4.1.0", files("yarn.lock"))).toEqual(["corepack", "yarn@4.1.0", "install", "--immutable", "--mode=skip-build"]);
    expect(installCommand(undefined, files("yarn.lock", ".yarnrc.yml"))).toContain("--mode=skip-build");
    expect(installCommand("yarn@1.22.22", files("yarn.lock"))).toEqual(["corepack", "yarn@1.22.22", "install", "--frozen-lockfile", "--ignore-scripts"]);
  });
});
