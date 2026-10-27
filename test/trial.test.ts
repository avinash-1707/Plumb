import { describe, expect, it } from "vitest";
import { installCommand, pickProbe } from "../scripts/trial.ts";

const files = (contents: Record<string, string>) => (f: string) => contents[f] ?? null;
const present = (...names: string[]) => files(Object.fromEntries(names.map((n) => [n, ""])));

describe("trial install command", () => {
  it("uses the declared packageManager version through corepack, without its hash, and skips pnpmfiles", () => {
    expect(installCommand("pnpm@9.15.0+sha512.abc", present("pnpm-lock.yaml"))).toEqual({
      command: ["corepack", "pnpm@9.15.0", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"],
    });
  });

  it("falls back to the lockfile when packageManager is absent", () => {
    expect(installCommand(undefined, present("package-lock.json"))).toEqual({ command: ["npm", "ci", "--ignore-scripts"] });
    expect(installCommand(undefined, present("bun.lockb"))).toEqual({ command: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] });
    expect(installCommand(undefined, present())).toEqual({ command: ["npm", "install", "--ignore-scripts"] });
  });

  it("tells yarn berry from classic, keeping lifecycle scripts off in both", () => {
    expect(installCommand("yarn@4.1.0", present("yarn.lock"))).toEqual({ command: ["corepack", "yarn@4.1.0", "install", "--immutable", "--mode=skip-build"] });
    expect(installCommand(undefined, files({ "yarn.lock": "", ".yarnrc.yml": "nodeLinker: node-modules\n" }))).toEqual({
      command: ["corepack", "yarn", "install", "--immutable", "--mode=skip-build"],
    });
    expect(installCommand("yarn@1.22.22", present("yarn.lock"))).toEqual({ command: ["corepack", "yarn@1.22.22", "install", "--frozen-lockfile", "--ignore-scripts"] });
  });

  it("refuses yarn berry setups that would run code committed in the repo", () => {
    expect(installCommand("yarn@4.1.0", files({ ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.1.0.cjs\n" }))).toHaveProperty("refused");
    expect(installCommand("yarn@4.1.0", files({ ".yarnrc.yml": "plugins:\n  - path: .yarn/plugins/x.cjs\n" }))).toHaveProperty("refused");
  });
});

describe("trial probe file", () => {
  it("skips config files, dotfiles, and build output in favour of real source", () => {
    expect(pickProbe([], [".prettierrc.js", ".eslintrc.cjs", "dist/app.controller.js", "examples/a.js", "tests/a.test.ts", "vite.config.ts", "src/app.ts"])).toBe("src/app.ts");
  });

  it("prefers a source entry point, and falls back to any code file when nothing else is left", () => {
    expect(pickProbe(["app/routes/index.tsx"], ["app/a.ts"])).toBe("app/routes/index.tsx");
    expect(pickProbe([], [".prettierrc.js", "README.md"])).toBe(".prettierrc.js");
    expect(pickProbe([], ["README.md"])).toBeNull();
  });
});
