import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { FEATURES_PATH, type FeatureIndex } from "../features.ts";
import { matchGlob } from "../glob.ts";
import type { RepoMap } from "../map/types.ts";
import type { Profile } from "../profile/types.ts";
import { validate } from "../schema/validate.ts";
import { CouldNotCompleteError } from "../errors.ts";
import { DOCTOR_HELPER, draftDir, skillDir } from "./paths.ts";

export interface SkillIssue {
  file: string;
  line: number | null;
  message: string;
}

/** The skill's required H2s, in order (doc 5), then the ones that only have to be present. */
const ORDERED_SECTIONS = ["Launch", "Doctor", "Drive", "Evidence", "Cleanup"];
const OTHER_SECTIONS = ["Helpers", "Proof standards"];
/** A feature file's four H2s, in this order and no others. The third one names the harness. */
const FEATURE_SECTIONS = ["Sub-features", "How to get to it (user POV)", "Driving it with ", "Gotchas"];
const TOKEN = /\{\{[^}\n]*\}\}/;

function headings(lines: readonly string[], level: 1 | 2): Array<{ text: string; line: number }> {
  const prefix = `${"#".repeat(level)} `;
  const out: Array<{ text: string; line: number }> = [];
  let fenced = false;
  lines.forEach((l, i) => {
    if (l.startsWith("```")) fenced = !fenced;
    else if (!fenced && l.startsWith(prefix)) out.push({ text: l.slice(prefix.length).trim(), line: i + 1 });
  });
  return out;
}

/** Template tokens the generator left behind, and managed markers that don't pair up. */
function textIssues(rel: string, text: string): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const open: Array<{ name: string; line: number }> = [];
  text.split("\n").forEach((l, i) => {
    const token = TOKEN.exec(l);
    if (token !== null) issues.push({ file: rel, line: i + 1, message: `template token left in: ${token[0].slice(0, 80)}` });
    const marker = /plumb:managed:(start|end) ([a-z0-9-]+)/.exec(l);
    if (marker?.[2] === undefined) return;
    if (marker[1] === "start") {
      if (open.length > 0) issues.push({ file: rel, line: i + 1, message: `managed block "${marker[2]}" starts inside "${open.at(-1)?.name ?? ""}"` });
      open.push({ name: marker[2], line: i + 1 });
    } else if (open.at(-1)?.name !== marker[2]) issues.push({ file: rel, line: i + 1, message: `managed block end "${marker[2]}" has no matching start` });
    else open.pop();
  });
  for (const o of open) issues.push({ file: rel, line: o.line, message: `managed block "${o.name}" is never closed` });
  return issues;
}

function checkSkillFile(rel: string, text: string, slug: string): SkillIssue[] {
  const issues = textIssues(rel, text);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (fm?.[1] === undefined) {
    issues.push({ file: rel, line: 1, message: "no YAML frontmatter: the skill never registers without it" });
  } else {
    let data: unknown;
    try {
      data = parseYaml(fm[1]);
    } catch (err) {
      issues.push({ file: rel, line: 1, message: `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}` });
    }
    const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    if (data !== undefined && record["name"] !== `verify-${slug}`) issues.push({ file: rel, line: 2, message: `frontmatter name must be "verify-${slug}"` });
    if (data !== undefined && (typeof record["description"] !== "string" || record["description"].trim() === "")) issues.push({ file: rel, line: 2, message: "frontmatter needs a description" });
  }
  const h2 = headings(text.split("\n"), 2);
  let last = 0;
  for (const name of ORDERED_SECTIONS) {
    const found = h2.find((h) => h.text === name);
    if (found === undefined) issues.push({ file: rel, line: null, message: `missing required section "## ${name}"` });
    else if (found.line < last) issues.push({ file: rel, line: found.line, message: `"## ${name}" is out of order (Launch, Doctor, Drive, Evidence, Cleanup)` });
    else last = found.line;
  }
  for (const name of OTHER_SECTIONS) if (!h2.some((h) => h.text === name)) issues.push({ file: rel, line: null, message: `missing required section "## ${name}"` });
  return issues;
}

function checkFeatureFile(rel: string, text: string): SkillIssue[] {
  const issues = textIssues(rel, text);
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1 || !lines[first]?.startsWith("# ")) issues.push({ file: rel, line: first + 1 || 1, message: "must start with an H1 title" });
  const h2 = headings(lines, 2);
  const firstH2 = h2[0]?.line ?? lines.length + 1;
  if (!lines.slice(first + 1, firstH2 - 1).some((l) => l.trim() !== "" && !l.startsWith("#"))) issues.push({ file: rel, line: first + 1, message: "needs a paragraph describing the user-visible behavior before the first H2" });
  const names = h2.map((h) => h.text);
  const matches = names.length === FEATURE_SECTIONS.length && FEATURE_SECTIONS.every((s, i) => (s.endsWith(" ") ? (names[i] ?? "").startsWith(s) && (names[i] ?? "").length > s.length : names[i] === s));
  if (!matches) issues.push({ file: rel, line: h2[0]?.line ?? null, message: `needs exactly these H2s in order: Sub-features, How to get to it (user POV), Driving it with <harness>, Gotchas (found: ${names.join(", ") || "none"})` });
  const sectionBody = (index: number): string[] => {
    const start = h2[index]?.line;
    if (start === undefined) return [];
    return lines.slice(start, h2[index + 1] === undefined ? lines.length : (h2[index + 1]?.line ?? lines.length) - 1).filter((l) => l.trim() !== "");
  };
  if (matches) {
    if (!sectionBody(0).some((l) => /^[-*] `[a-z0-9]+(-[a-z0-9]+)*`/.test(l))) issues.push({ file: rel, line: h2[0]?.line ?? null, message: "Sub-features needs at least one bullet starting with a `kebab-id`" });
    if (!(sectionBody(2)[0] ?? "").startsWith("Preconditions:")) issues.push({ file: rel, line: h2[2]?.line ?? null, message: "\"Driving it with\" must start with a Preconditions: line" });
  }
  return issues;
}

function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(path.join(dir, f)).isFile()).map((f) => f.split(path.sep).join("/"));
}

function isExecutable(file: string): boolean {
  return (statSync(file).mode & 0o111) !== 0;
}

/**
 * The verify skill's structural contract (doc 5, `plumb verify --validate`): frontmatter, required sections, the
 * feature files' four H2s, no template tokens, helpers executable and shown, and a features.json that matches the
 * feature files and the map.
 */
export function checkSkill(root: string, profile: Profile, map: RepoMap, trackedFiles: readonly string[], dir = skillDir(profile.app.slug)): SkillIssue[] {
  const skillFile = `${dir}/SKILL.md`;
  if (!existsSync(path.join(root, skillFile))) return [{ file: skillFile, line: null, message: "doesn't exist; generate it with plumb verify --scaffold" }];
  const skillText = readFileSync(path.join(root, skillFile), "utf8");
  const issues = checkSkillFile(skillFile, skillText, profile.app.slug);

  // Helpers: every script the skill ships is executable and its invocation appears in the skill body.
  const helpers = [DOCTOR_HELPER, ...listFilesUnder(path.join(root, dir, "scripts")).map((f) => `${dir}/scripts/${f}`)];
  for (const helper of helpers) {
    const abs = path.join(root, helper);
    if (!existsSync(abs)) {
      issues.push({ file: helper, line: null, message: "doesn't exist" });
      continue;
    }
    issues.push(...textIssues(helper, readFileSync(abs, "utf8")));
    if (!isExecutable(abs)) issues.push({ file: helper, line: null, message: "is not executable (chmod +x)" });
    const shown = helper.startsWith(`${dir}/`) ? helper.slice(dir.length + 1) : helper;
    if (!skillText.includes(shown)) issues.push({ file: skillFile, line: null, message: `doesn't show how to invoke ${helper}` });
  }

  const readme = `${dir}/features/README.md`;
  const readmeText = existsSync(path.join(root, readme)) ? readFileSync(path.join(root, readme), "utf8") : null;
  if (readmeText === null) issues.push({ file: readme, line: null, message: "doesn't exist" });
  else issues.push(...textIssues(readme, readmeText));

  const featureFiles = listFilesUnder(path.join(root, dir, "features")).filter((f) => f.endsWith(".md") && f !== "README.md");
  for (const f of featureFiles) issues.push(...checkFeatureFile(`${dir}/features/${f}`, readFileSync(path.join(root, dir, "features", f), "utf8")));

  // features.json: schema, then index hygiene against the feature files and the map.
  const indexFile = path.join(root, FEATURES_PATH);
  if (!existsSync(indexFile)) {
    issues.push({ file: FEATURES_PATH, line: null, message: "doesn't exist" });
    return issues;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(indexFile, "utf8"));
  } catch (err) {
    issues.push({ file: FEATURES_PATH, line: null, message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
    return issues;
  }
  const schema = validate("features", data);
  if (!schema.ok) {
    issues.push(...schema.issues.map((i) => ({ file: FEATURES_PATH, line: null, message: `${i.path} ${i.message}` })));
    return issues;
  }
  const index = data as FeatureIndex;
  const entries = new Set(map.components.flatMap((c) => c.entryPoints.map((e) => e.id)));
  const components = new Set(map.components.map((c) => c.id));
  const seen = new Set<string>();
  for (const [i, f] of index.features.entries()) {
    const at = `/features/${String(i)}`;
    if (seen.has(f.id)) issues.push({ file: FEATURES_PATH, line: null, message: `${at} duplicate feature id "${f.id}"` });
    seen.add(f.id);
    if (!featureFiles.includes(f.file.slice("features/".length))) issues.push({ file: FEATURES_PATH, line: null, message: `${at} ${f.file} doesn't exist in ${dir}` });
    if (readmeText !== null && !readmeText.includes(path.posix.basename(f.file))) issues.push({ file: readme, line: null, message: `the index doesn't list ${f.file}` });
    for (const e of f.entryPoints) if (!entries.has(e)) issues.push({ file: FEATURES_PATH, line: null, message: `${at} entry point ${e} is not in the map` });
    for (const c of f.components) if (!components.has(c)) issues.push({ file: FEATURES_PATH, line: null, message: `${at} component ${c} is not in the map` });
    for (const p of f.paths) if (!trackedFiles.some((file) => matchGlob(file, p))) issues.push({ file: FEATURES_PATH, line: null, message: `${at} path "${p}" matches no file` });
  }
  for (const f of featureFiles) {
    if (!index.features.some((x) => x.file === `features/${f}`)) issues.push({ file: `${dir}/features/${f}`, line: null, message: `has no entry in ${FEATURES_PATH}` });
  }
  return issues;
}

/** The skill directory `--validate` checks: the draft while one exists, else the published skill. */
export function skillUnderValidation(root: string, slug: string): string {
  return existsSync(path.join(root, draftDir(slug), "SKILL.md")) ? draftDir(slug) : skillDir(slug);
}

/** Marks a draft made by `--edit`: the published skill's content hash when the edit started. */
const EDIT_BASE = ".plumb-edit-base";

/** Hash of every file in a directory (paths and bytes), ignoring Plumb's edit marker. */
function dirHash(dir: string): string {
  const hash = createHash("sha256");
  for (const f of listFilesUnder(dir).filter((f) => f !== EDIT_BASE).sort()) hash.update(`${f}\0`).update(readFileSync(path.join(dir, f))).update("\0");
  return hash.digest("hex");
}

/**
 * Copies the published skill into the draft directory for editing (refine), since agents can't write under
 * `.claude/` without a prompt. `--publish` puts it back.
 */
export function editSkill(root: string, slug: string): string {
  const draft = draftDir(slug);
  const target = skillDir(slug);
  if (!existsSync(path.join(root, target, "SKILL.md"))) throw new CouldNotCompleteError(`${target} isn't published yet; nothing to edit`);
  if (existsSync(path.join(root, draft))) throw new CouldNotCompleteError(`a draft already exists at ${draft}; publish it (plumb verify --publish) or delete it first`);
  cpSync(path.join(root, target), path.join(root, draft), { recursive: true });
  writeFileSync(path.join(root, draft, EDIT_BASE), `${dirHash(path.join(root, target))}\n`);
  return draft;
}

/**
 * Moves a valid draft into `.claude/skills/verify-<slug>/`. A new skill is copied in; an edit made with `--edit`
 * replaces the published skill only if nobody changed it since the edit started. An invalid draft stays put.
 */
export function publishDraft(root: string, profile: Profile, map: RepoMap, trackedFiles: readonly string[]): { published: string | null; issues: SkillIssue[] } {
  const draft = draftDir(profile.app.slug);
  const target = skillDir(profile.app.slug);
  const absDraft = path.join(root, draft);
  const absTarget = path.join(root, target);
  if (!existsSync(path.join(absDraft, "SKILL.md"))) throw new CouldNotCompleteError(`no draft at ${draft}; run plumb verify --scaffold (new skill) or --edit (published skill) first`);
  const baseFile = path.join(absDraft, EDIT_BASE);
  if (existsSync(absTarget)) {
    if (!existsSync(baseFile)) throw new CouldNotCompleteError(`${target} already exists and this draft wasn't made from it with --edit; Plumb never overwrites a published skill blindly`);
    if (readFileSync(baseFile, "utf8").trim() !== dirHash(absTarget)) throw new CouldNotCompleteError(`${target} changed since plumb verify --edit copied it; delete ${draft}, run plumb verify --edit again, and redo the change on the current skill`);
  }
  const issues = checkSkill(root, profile, map, trackedFiles, draft);
  if (issues.length > 0) return { published: null, issues };
  rmSync(baseFile, { force: true });
  rmSync(absTarget, { recursive: true, force: true });
  cpSync(absDraft, absTarget, { recursive: true });
  rmSync(absDraft, { recursive: true });
  return { published: target, issues: [] };
}
