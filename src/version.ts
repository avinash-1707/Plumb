import { readFileSync } from "node:fs";

// Resolves from both src/ (tests) and dist/ (published bin), which sit one level below the package root.
const PACKAGE_JSON = new URL("../package.json", import.meta.url);

export function readVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") {
    return pkg.version;
  }
  throw new Error(`${PACKAGE_JSON.pathname} has no string "version" field`);
}
