import { configDefaults, defineConfig } from "vitest/config";

// examples/ are separate workspaces with their own dependencies and test runs.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "examples/**"] },
});
