import path from "node:path";

// path.matchesGlob never lets * or ** match a segment starting with "." (minimatch's dot:false), so "apps/api/**"
// would silently skip apps/api/.env.example. Leading dots become a private-use character on both sides, which
// wildcards do match and which no real path contains.
const DOT = "";

function hideLeadingDots(p: string): string {
  return p
    .split("/")
    .map((segment) => (segment.startsWith(".") && segment !== "." && segment !== ".." ? DOT + segment.slice(1) : segment))
    .join("/");
}

/** Glob match where wildcards also match dotfiles and dot-directories. */
export function matchGlob(file: string, pattern: string): boolean {
  return path.matchesGlob(hideLeadingDots(file), hideLeadingDots(pattern));
}

export function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchGlob(file, pattern));
}
