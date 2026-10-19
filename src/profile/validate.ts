import type { Config } from "../config.ts";
import type { RepoMap } from "../map/types.ts";
import { type SchemaIssue, validate } from "../schema/validate.ts";
import { checkCommand } from "./commands.ts";
import { selectStrategy } from "./strategy.ts";
import type { Command, Profile } from "./types.ts";

export interface ProfileCheck {
  profile: Profile | null;
  issues: SchemaIssue[];
  strategy: { strategy: Profile["strategy"]; reason: string } | null;
}

/** Every command in a profile with the JSON pointer it lives at. */
export function profileCommands(profile: Profile): Array<{ path: string; command: Command; scoped?: string }> {
  const out: Array<{ path: string; command: Command; scoped?: string }> = [];
  if (profile.install !== null) out.push({ path: "/install", command: profile.install });
  if (profile.build !== null) out.push({ path: "/build", command: profile.build });
  for (const name of ["lint", "typecheck", "unit", "integration", "e2e"] as const) {
    const c = profile.checks[name];
    if (c === null) continue;
    out.push({ path: `/checks/${name}`, command: c, ...("scoped" in c && c.scoped !== null ? { scoped: c.scoped } : {}) });
  }
  profile.services.forEach((s, i) => {
    if (s.start !== null) out.push({ path: `/services/${String(i)}/start`, command: s.start });
    if (s.stop !== null) out.push({ path: `/services/${String(i)}/stop`, command: s.stop });
  });
  profile.run.forEach((r, i) => {
    out.push({ path: `/run/${String(i)}/start`, command: r.start });
    if (r.stop !== "signal") out.push({ path: `/run/${String(i)}/stop`, command: r.stop });
  });
  return out;
}

// An install that may rewrite the lockfile, keyed by the lockfile that makes it a problem.
const LOCKFILE_INSTALLS: Array<{ lockfile: string; loose: RegExp; fix: string }> = [
  { lockfile: "package-lock.json", loose: /^npm (install|i)\b(?!.*--(package-lock-only))/, fix: "npm ci" },
  { lockfile: "pnpm-lock.yaml", loose: /^pnpm (install|i)\b(?!.*--frozen-lockfile)/, fix: "pnpm install --frozen-lockfile" },
  { lockfile: "yarn.lock", loose: /^yarn( install)?(?!.*--(immutable|frozen-lockfile))(\s|$)/, fix: "yarn install --immutable (Yarn 1: --frozen-lockfile)" },
  { lockfile: "bun.lock", loose: /^bun (install|i)\b(?!.*--frozen-lockfile)/, fix: "bun install --frozen-lockfile" },
];

/** Whether an install command would rewrite a lockfile the repo tracks: verification must never change tracked files. */
export function lockfileIssue(cmd: string, cwd: string, files: readonly string[]): string | null {
  const dir = cwd === "." ? "" : `${cwd.replace(/\/$/, "")}/`;
  for (const rule of LOCKFILE_INSTALLS) {
    if (files.includes(`${dir}${rule.lockfile}`) && rule.loose.test(cmd.trim())) return `can rewrite the tracked ${rule.lockfile}; use ${rule.fix}`;
  }
  return null;
}

/** Schema first; then what the schema can't say: commands must be runnable and the strategy must be the derived one. */
export function checkProfile(root: string, files: readonly string[], data: unknown, map: RepoMap, config: Config): ProfileCheck {
  const schema = validate("profile", data);
  if (!schema.ok) return { profile: null, issues: schema.issues, strategy: null };
  const profile = data as Profile;
  const issues: SchemaIssue[] = [];

  const options = { hasBuild: profile.build !== null };
  for (const { path: at, command, scoped } of profileCommands(profile)) {
    for (const message of checkCommand(root, files, command.cmd, command.cwd, options)) issues.push({ path: `${at}/cmd`, message });
    if (scoped !== undefined) for (const message of checkCommand(root, files, scoped, command.cwd, options)) issues.push({ path: `${at}/scoped`, message });
  }

  if (profile.install !== null) {
    const lock = lockfileIssue(profile.install.cmd, profile.install.cwd, files);
    if (lock !== null) issues.push({ path: "/install/cmd", message: lock });
  }

  const probes = [
    ...profile.run.map((r, i) => ({ at: `/run/${String(i)}/ready`, probe: r.ready })),
    ...profile.services.flatMap((s, i) => (s.ready === null ? [] : [{ at: `/services/${String(i)}/ready`, probe: s.ready }])),
  ];
  for (const { at, probe } of probes) {
    if (probe.kind !== "log") continue;
    try {
      new RegExp(probe.pattern);
    } catch (err) {
      issues.push({ path: `${at}/pattern`, message: `is not a valid regex: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  profile.services.forEach((s, i) => {
    // Without a probe Plumb can't tell whether the service was already running, so it can't know it's safe to stop.
    if (s.stop !== null && s.ready === null) issues.push({ path: `/services/${String(i)}/ready`, message: "a service with a stop command needs a readiness probe" });
  });

  const names = new Set<string>();
  profile.run.forEach((r, i) => {
    if (names.has(r.name)) issues.push({ path: `/run/${String(i)}/name`, message: `run target "${r.name}" is defined twice` });
    names.add(r.name);
  });
  const ports = profile.run.flatMap((r) => (r.port === null ? [] : [r.port]));
  const duplicatePort = ports.find((p, i) => ports.indexOf(p) !== i);
  if (duplicatePort !== undefined) issues.push({ path: "/run", message: `two run targets use port ${String(duplicatePort)}` });

  const strategy = selectStrategy(root, profile, map, config);
  if (profile.strategy !== strategy.strategy) issues.push({ path: "/strategy", message: `must be "${strategy.strategy}" (${strategy.reason})` });
  return { profile, issues, strategy };
}
