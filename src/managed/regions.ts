import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * `# plumb:managed:start <name> [h=<hash>]` in shell files, `<!-- plumb:managed:start <name> [h=<hash>] -->` in
 * markdown. The hash is of the region's body as Plumb wrote it, so an edit inside the region is detectable.
 */
const MARKER = /^(#|<!--) plumb:managed:(start|end) ([a-z0-9-]+)(?: h=([0-9a-f]+))?(?: -->)?$/;

export interface Region {
  name: string;
  /** Lines between the markers, joined with "\n" (no trailing newline). */
  body: string;
  /** The hash recorded on the start marker; null for a region written before hashes existed. */
  hash: string | null;
}

export class ManagedRegionError extends Error {}

export function regionHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

/** The managed regions of a file, in order. Unpaired or nested markers are an error, not something to guess around. */
export function parseRegions(text: string): Region[] {
  const regions: Region[] = [];
  let open: { name: string; start: number; hash: string | null } | null = null;
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = MARKER.exec(line.trim());
    if (m?.[3] === undefined) continue;
    if (m[2] === "start") {
      if (open !== null) throw new ManagedRegionError(`line ${String(i + 1)}: managed region "${m[3]}" starts inside "${open.name}"`);
      open = { name: m[3], start: i + 1, hash: m[4] ?? null };
    } else {
      if (open?.name !== m[3]) throw new ManagedRegionError(`line ${String(i + 1)}: managed region end "${m[3]}" has no matching start`);
      regions.push({ name: m[3], body: lines.slice(open.start, i).join("\n"), hash: open.hash });
      open = null;
    }
  }
  if (open !== null) throw new ManagedRegionError(`managed region "${open.name}" is never closed`);
  return regions;
}

/** Records each region's body hash on its start marker. Every generator passes its output through this. */
export function withHashes(text: string): string {
  const hashes = new Map(parseRegions(text).map((r) => [r.name, regionHash(r.body)]));
  return text
    .split("\n")
    .map((line) => {
      const m = MARKER.exec(line.trim());
      if (m?.[2] !== "start" || m[3] === undefined) return line;
      const indent = line.slice(0, line.length - line.trimStart().length);
      const hash = hashes.get(m[3]) ?? "";
      return m[1] === "#" ? `${indent}# plumb:managed:start ${m[3]} h=${hash}` : `${indent}<!-- plumb:managed:start ${m[3]} h=${hash} -->`;
    })
    .join("\n");
}

/** Regions whose body no longer matches the hash Plumb recorded: the user edited inside them. */
export function editedRegions(text: string): string[] {
  return parseRegions(text).filter((r) => r.hash !== null && regionHash(r.body) !== r.hash).map((r) => r.name);
}

/**
 * Replaces each managed region of `current` with the same-named region of `generated` (both hashed). Everything
 * outside the markers stays byte for byte. A region the generated file has but the current one lost is an error:
 * Plumb can't know where the user wants it.
 */
export function replaceRegions(current: string, generated: string): string {
  const wanted = new Map<string, { marker: string; body: string }>();
  const generatedLines = generated.split("\n");
  for (const region of parseRegions(generated)) {
    const marker = generatedLines.find((l) => {
      const m = MARKER.exec(l.trim());
      return m?.[2] === "start" && m[3] === region.name;
    });
    wanted.set(region.name, { marker: marker?.trim() ?? "", body: region.body });
  }
  const present = new Set(parseRegions(current).map((r) => r.name));
  for (const name of wanted.keys()) if (!present.has(name)) throw new ManagedRegionError(`managed region "${name}" is missing; restore its markers or delete the file to regenerate it`);
  const out: string[] = [];
  let skipping: string | null = null;
  for (const line of current.split("\n")) {
    const m = MARKER.exec(line.trim());
    const region = m?.[3] === undefined ? undefined : wanted.get(m[3]);
    if (m?.[2] === "start" && region !== undefined) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      out.push(`${indent}${region.marker}`);
      if (region.body !== "") out.push(...region.body.split("\n"));
      skipping = m[3] ?? null;
      continue;
    }
    if (m?.[2] === "end" && m[3] === skipping) skipping = null;
    if (skipping === null) out.push(line);
  }
  return out.join("\n");
}

export type RefreshOutcome = "created" | "updated" | "unchanged" | "conflict";

/**
 * Regenerates a file's managed regions (doc 2): a missing file is written whole; regions the user didn't touch are
 * replaced; if the user edited inside a region (its body no longer matches the recorded hash, or an unhashed region
 * differs from what Plumb would write), the file is left alone and the new version goes to `<file>.plumb-new`.
 */
export function refreshManagedFile(file: string, generated: string): RefreshOutcome {
  if (!existsSync(file)) {
    writeFileSync(file, generated);
    return "created";
  }
  const current = readFileSync(file, "utf8");
  const fresh = new Map(parseRegions(generated).map((r) => [r.name, r.body]));
  const edited = parseRegions(current).some((r) => (r.hash === null ? fresh.has(r.name) && fresh.get(r.name) !== r.body : regionHash(r.body) !== r.hash));
  if (edited) {
    writeFileSync(`${file}.plumb-new`, replaceRegionsLoosely(current, generated));
    return "conflict";
  }
  const next = replaceRegions(current, generated);
  if (next === current) return "unchanged";
  writeFileSync(file, next);
  return "updated";
}

/** For `.plumb-new`: the user's file with Plumb's regions swapped in, or the plain generated file if that fails. */
function replaceRegionsLoosely(current: string, generated: string): string {
  try {
    return replaceRegions(current, generated);
  } catch (err) {
    if (err instanceof ManagedRegionError) return generated;
    throw err;
  }
}
