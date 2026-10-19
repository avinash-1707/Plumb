import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CouldNotCompleteError, UsageError } from "../errors.ts";
import { writeTree } from "../git.ts";
import { ensureGitignore } from "../managed/block.ts";
import { freePort, groupAlive, logTail, portOpen, probeNow, processStart, runToCompletion, sameGroup, spawnDetached, type StartedProcess, stopGroup, waitReadyDetached } from "../profile/runner.ts";
import { type StartedService, type StepResult, startService, stopServices } from "../profile/services.ts";
import type { Command, LocalConfig, Profile, ReadinessProbe } from "../profile/types.ts";
import { redactor, runId as newRunId, verificationEnv } from "../profile/verify.ts";
import { runDir } from "./paths.ts";
import { checkReportArtifacts } from "./report.ts";

/** What a launch started, written to .plumb/evidence/<run-id>/run.json so doctor and cleanup act on exactly that. */
export interface RunState {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  /** `git write-tree` at launch: the staged content this run drives, which report.json must name. */
  tree: string;
  /** Extra env from `--launch --env`, needed again for stop commands. Gitignored like the rest of the evidence. */
  envOverrides: Record<string, string>;
  /** `leaderStart`: the group leader's start time, so a reused id is never signalled days later (see sameGroup). */
  targets: Array<{ name: string; pgid: number; leaderStart: string | null; port: number | null; ready: ReadinessProbe; log: string; stop: "signal" | Command }>;
  services: StartedService[];
  cleanedUpAt: string | null;
  teardown: string[];
}

export interface LaunchResult {
  ok: boolean;
  runId: string;
  evidenceDir: string;
  tree: string;
  steps: StepResult[];
  targets: Array<{ name: string; port: number | null; url: string | null }>;
  /** Filled when a failed launch tore down what it had started. */
  teardown: string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses `KEY=VALUE` pairs; values may use {port:<target>} and {runId}, expanded once ports are known. */
export function parseEnvOverrides(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (eq === -1 || !ENV_NAME.test(key)) throw new UsageError(`--env takes KEY=VALUE, got "${pair}"`);
    out[key] = pair.slice(eq + 1);
  }
  return out;
}

export function expandPlaceholders(value: string, ports: ReadonlyMap<string, number | null>, runId: string): string {
  return value.replaceAll(/\{(port:([a-z0-9][a-z0-9_-]*)|runId)\}/gi, (whole, _inner: string, target: string | undefined) => {
    if (target === undefined) return runId;
    const port = ports.get(target);
    if (port === undefined) throw new UsageError(`${whole} names no run target (have: ${[...ports.keys()].join(", ")})`);
    if (port === null) throw new UsageError(`${whole}: run target "${target}" has no port`);
    return String(port);
  });
}

/** The readiness probe moved to the port this run allocated, when it pointed at the profile's port. */
export function probeOnPort(probe: ReadinessProbe, profilePort: number | null, port: number | null): ReadinessProbe {
  if (port === null || profilePort === null || port === profilePort) return probe;
  if (probe.kind === "port") return probe.port === profilePort ? { kind: "port", port } : probe;
  if (probe.kind === "http") {
    const url = new URL(probe.url);
    const effective = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (effective !== profilePort) return probe;
    url.port = String(port);
    return { ...probe, url: url.toString() };
  }
  return probe;
}

/** `URL_<TARGET>='<origin>'` lines a POSIX shell can source (the doctor helper does). */
export function urlsEnv(targets: ReadonlyArray<{ name: string; url: string | null }>): string {
  return targets
    .filter((t) => t.url !== null)
    .map((t) => `URL_${t.name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}='${t.url ?? ""}'\n`)
    .join("");
}

function statePath(root: string, runId: string): string {
  return path.join(root, runDir(runId), "run.json");
}

function saveState(root: string, state: RunState): void {
  writeFileSync(statePath(root, state.runId), `${JSON.stringify(state, null, 2)}\n`);
}

export function loadState(root: string, runId: string): RunState {
  const file = statePath(root, runId);
  if (!existsSync(file)) throw new CouldNotCompleteError(`no launched run "${runId}" (${path.relative(root, file)} doesn't exist)`);
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  // Plumb wrote it; this only catches a file from another tool or a hand edit, not every field.
  const ok = typeof data === "object" && data !== null && "schemaVersion" in data && data.schemaVersion === 1 && "runId" in data && data.runId === runId;
  if (!ok) throw new CouldNotCompleteError(`${path.relative(root, file)} is not a Plumb run state`);
  return data as RunState;
}

/**
 * Verification env with this run's ports: each target's portEnv set to its port, and loopback URLs that pointed at a
 * moved target's profile port (`API_URL=http://localhost:4000`) rewritten to follow it, since they would otherwise
 * reach nothing or the user's own dev server. `--env` overrides win over both. For a target, its own portEnv is set
 * last: several targets often read the same variable (PORT), and each must get its own port.
 */
function envFor(profile: Profile, local: LocalConfig, state: Pick<RunState, "envOverrides" | "targets">, forTarget?: string): NodeJS.ProcessEnv {
  const env = verificationEnv(profile, local);
  const moved = new Map<string, number>();
  for (const target of profile.run) {
    const port = state.targets.find((t) => t.name === target.name)?.port;
    if (target.portEnv === null || port === undefined || port === null) continue;
    if (target.port !== null && target.port !== port) moved.set(String(target.port), port);
  }
  if (moved.size > 0) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      env[key] = value.replaceAll(/\b(localhost|127\.0\.0\.1|\[::1\]):(\d+)\b/g, (whole, host: string, port: string) => {
        const to = moved.get(port);
        return to === undefined ? whole : `${host}:${String(to)}`;
      });
    }
  }
  for (const target of profile.run) {
    const port = state.targets.find((t) => t.name === target.name)?.port;
    if (target.portEnv !== null && port !== undefined && port !== null) env[target.portEnv] = String(port);
  }
  const own = profile.run.find((t) => t.name === forTarget);
  const ownPort = state.targets.find((t) => t.name === forTarget)?.port;
  const result = { ...env, ...state.envOverrides };
  if (own?.portEnv != null && ownPort != null) result[own.portEnv] = String(ownPort);
  return result;
}

function logFiles(root: string, runId: string): (step: string) => { abs: string; rel: string } {
  return (step) => {
    const rel = `${runDir(runId)}/logs/${step.replaceAll(/[^a-z0-9-]+/gi, "-")}.log`;
    return { abs: path.join(root, rel), rel };
  };
}

/**
 * Starts the profile's services and run targets for one verification run and returns while they keep running.
 * Every run target gets a free port through its `portEnv`, so two runs (or the user's own dev server) never share
 * one; a target without `portEnv` whose port is taken is refused, never driven. A failed launch tears down what it
 * started before returning.
 */
export async function launch(root: string, profile: Profile, local: LocalConfig, overrides: Record<string, string>): Promise<LaunchResult> {
  ensureGitignore(root);
  const id = `run-${newRunId()}`;
  const evidenceDir = runDir(id);
  mkdirSync(path.join(root, evidenceDir), { recursive: true });
  const logFor = logFiles(root, id);
  const redact = redactor(local);
  const steps: StepResult[] = [];

  const ports = new Map<string, number | null>();
  for (const target of profile.run) ports.set(target.name, target.portEnv === null ? target.port : await freePort());
  const envOverrides = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, expandPlaceholders(v, ports, id)]));
  const tree = writeTree(root);
  const state: RunState = { schemaVersion: 1, runId: id, startedAt: new Date().toISOString(), tree, envOverrides, targets: [], services: [], cleanedUpAt: null, teardown: [] };
  // Ports first, so envFor sees them; the state is saved before anything starts and after every change, so a launch
  // killed midway still leaves cleanup a record of what to stop.
  const planned = { envOverrides, targets: profile.run.map((t) => ({ name: t.name, pgid: 0, leaderStart: null, port: ports.get(t.name) ?? null, ready: t.ready, log: "", stop: t.stop })) };
  const env = envFor(profile, local, planned);
  saveState(root, state);

  const fail = async (): Promise<LaunchResult> => {
    const teardown = await teardownRun(root, profile, local, state);
    return { ok: false, runId: id, evidenceDir, tree, steps, targets: [], teardown };
  };
  // Ctrl-C: stop a service start still in flight (its process is detached, so the terminal's SIGINT misses it), then
  // tear down; `abort` keeps the loop from starting anything once teardown has begun.
  const abort = { requested: false };
  // A function, so the check is re-read after every await (a signal can arrive at any of them).
  const aborted = (): boolean => abort.requested;
  const inflight: StartedProcess[] = [];
  const onSignal = (signal: NodeJS.Signals): void => {
    abort.requested = true;
    void Promise.all(inflight.map((p) => p.stop()))
      .then(() => teardownRun(root, profile, local, state))
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (const service of profile.services) {
      if (aborted()) return await fail();
      const result = await startService(root, service, local, env, logFor(`service-${service.name}`), redact, {
        onStart: (proc) => inflight.push(proc),
        onRegister: (s) => {
          state.services.push(s);
          saveState(root, state);
        },
      });
      steps.push(result);
      if (result.status === "failed") return await fail();
    }

    for (const target of profile.run) {
      if (aborted()) return await fail();
      const step = `run-${target.name}`;
      const port = ports.get(target.name) ?? null;
      const probe = probeOnPort(target.ready, target.port, port);
      const shown = { step, command: redact(target.start.cmd), cwd: target.start.cwd };
      if (port !== null && (await portOpen(port))) {
        steps.push({ ...shown, status: "failed", detail: `port ${String(port)} is already in use by another process and ${target.name} has no portEnv to move it; stop that process and retry` });
        return await fail();
      }
      if (await probeNow(probe)) {
        steps.push({ ...shown, status: "failed", detail: "something already answers its readiness probe before Plumb started it; Plumb never drives an instance it didn't start" });
        return await fail();
      }
      const log = logFor(step);
      const startedAt = Date.now();
      const pgid = await spawnDetached(target.start.cmd, path.resolve(root, target.start.cwd), envFor(profile, local, planned, target.name), log.abs);
      state.targets.push({ name: target.name, pgid, leaderStart: processStart(pgid), port, ready: probe, log: log.rel, stop: target.stop });
      saveState(root, state);
      if (aborted()) return await fail();
      const ready = await waitReadyDetached(probe, pgid, log.abs, target.start.timeoutSec);
      const durationMs = Date.now() - startedAt;
      if (!ready.ok) {
        steps.push({ ...shown, status: "failed", detail: redact(ready.reason ?? "never became ready"), log: log.rel, tail: logTail(log.abs).map(redact), durationMs });
        return await fail();
      }
      steps.push({ ...shown, status: "passed", log: log.rel, durationMs });
    }
    const targets = state.targets.map((t) => ({ name: t.name, port: t.port, url: t.ready.kind === "http" ? new URL(t.ready.url).origin : null }));
    writeFileSync(path.join(root, evidenceDir, "urls.env"), urlsEnv(targets));
    return { ok: true, runId: id, evidenceDir, tree, steps, targets, teardown: [] };
  } catch (err) {
    // Anything unexpected (a missing cwd, an invalid log pattern) still tears down what already started.
    const teardown = await teardownRun(root, profile, local, state);
    throw new CouldNotCompleteError(`launch ${id} failed: ${err instanceof Error ? err.message : String(err)}; tore down what it started (${teardown.join("; ") || "nothing yet"})`);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/**
 * Stops run targets (their stop command, then the whole process group) and services the run started, in reverse.
 * The run counts as cleaned up only when everything stopped; otherwise a later `--cleanup` retries what failed.
 */
async function teardownRun(root: string, profile: Profile, local: LocalConfig, state: RunState): Promise<string[]> {
  const env = envFor(profile, local, state);
  const logFor = logFiles(root, state.runId);
  const redact = redactor(local);
  const lines: string[] = [];
  let failed = false;
  for (const target of [...state.targets].reverse()) {
    if (target.stop !== "signal" && groupAlive(target.pgid) && sameGroup(target.pgid, target.leaderStart)) {
      const log = logFor(`stop-${target.name}`);
      const outcome = await runToCompletion(`stop-${target.name}`, target.stop.cmd, path.resolve(root, target.stop.cwd), envFor(profile, local, state, target.name), target.stop.timeoutSec, log.abs, { sweep: true });
      if (!outcome.ok) lines.push(`stop command for ${target.name} failed: ${redact(outcome.reason ?? "failed")} (see ${log.rel}); signalling its process group`);
    }
    if (await stopGroup(target.pgid, target.leaderStart)) lines.push(`stopped ${target.name} (process group ${String(target.pgid)})`);
    else {
      failed = true;
      lines.push(`could not stop ${target.name}: process group ${String(target.pgid)} survived SIGKILL`);
    }
  }
  const stillRunning: StartedService[] = [];
  for (const service of [...state.services].reverse()) {
    const [line = ""] = await stopServices(root, [service], env, logFor, redact);
    lines.push(line);
    if (line.startsWith("could not stop")) {
      failed = true;
      stillRunning.unshift(service);
    }
  }
  // Services that stopped aren't stopped again on a retry.
  state.services = stillRunning;
  state.cleanedUpAt = failed ? null : new Date().toISOString();
  state.teardown = [...state.teardown, ...lines];
  saveState(root, state);
  return lines;
}

export interface CleanupResult {
  ok: boolean;
  runId: string;
  teardown: string[];
  /** Process groups still alive after teardown. */
  survivors: string[];
  /** Evidence check: artifacts the run's report.json lists, and which of them no longer exist. */
  evidence: { report: boolean; checked: number; missing: string[] };
}

/**
 * Tears down exactly what the launch recorded, never by process name, then confirms the evidence survived: every
 * artifact in report.json must still exist. Running it twice is safe: after a full teardown the second run only
 * re-checks; after a partial one it retries what didn't stop.
 */
export async function cleanup(root: string, profile: Profile, local: LocalConfig, runId: string): Promise<CleanupResult> {
  const state = loadState(root, runId);
  const teardown = state.cleanedUpAt === null ? await teardownRun(root, profile, local, state) : [`already cleaned up at ${state.cleanedUpAt}`];
  const survivors = state.targets.filter((t) => groupAlive(t.pgid) && sameGroup(t.pgid, t.leaderStart)).map((t) => `${t.name} (process group ${String(t.pgid)})`);
  const evidence = checkReportArtifacts(root, runId);
  const ok = survivors.length === 0 && evidence.missing.length === 0 && !teardown.some((l) => l.startsWith("could not stop"));
  return { ok, runId, teardown, survivors, evidence };
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Process groups listening on a port, via lsof; null when lsof isn't installed. */
function listenerGroups(port: number): Set<number> | null {
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (lsof.error !== undefined) {
    if ("code" in lsof.error && lsof.error.code === "ENOENT") return null;
    throw lsof.error;
  }
  const pids = lsof.stdout.split("\n").filter((p) => /^\d+$/.test(p));
  if (pids.length === 0) return new Set();
  const ps = spawnSync("ps", ["-o", "pgid=", "-p", pids.join(",")], { encoding: "utf8" });
  if (ps.error !== undefined) throw ps.error;
  return new Set(ps.stdout.split("\n").map((l) => Number(l.trim())).filter((n) => n > 0));
}

/**
 * Read-only "is this instance worth driving?" for a launched run: each target's process group is alive, its port is
 * held by that group (not something else), its readiness probe passes now, and every service still answers.
 */
export async function doctor(root: string, profile: Profile, runId: string): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const state = loadState(root, runId);
  const checks: DoctorCheck[] = [];
  if (state.cleanedUpAt !== null) checks.push({ name: "run", ok: false, detail: `cleaned up at ${state.cleanedUpAt}; launch a new run` });
  for (const target of state.targets) {
    const alive = groupAlive(target.pgid) && sameGroup(target.pgid, target.leaderStart);
    checks.push({ name: `${target.name}: process`, ok: alive, detail: alive ? `process group ${String(target.pgid)} is running` : `process group ${String(target.pgid)} has exited; see ${target.log}` });
    if (target.port !== null) {
      const owners = listenerGroups(target.port);
      if (owners === null) checks.push({ name: `${target.name}: port`, ok: true, detail: `port ${String(target.port)} ownership unchecked (lsof not installed)` });
      else {
        const owned = owners.has(target.pgid);
        checks.push({ name: `${target.name}: port`, ok: owned, detail: owned ? `port ${String(target.port)} is held by this run` : owners.size === 0 ? `nothing listens on port ${String(target.port)}` : `port ${String(target.port)} is held by another process group (${[...owners].join(", ")})` });
      }
    }
    if (target.ready.kind !== "log") {
      const ready = await probeNow(target.ready);
      const what = target.ready.kind === "http" ? `${target.ready.url} returns ${String(target.ready.expectStatus)}` : `port ${String(target.ready.port)} accepts connections`;
      checks.push({ name: `${target.name}: ready`, ok: ready, detail: ready ? what : `not ready: expected ${what}` });
    }
  }
  for (const service of profile.services) {
    if (service.ready === null) continue;
    const ready = await probeNow(service.ready);
    checks.push({ name: `service ${service.name}`, ok: ready, detail: ready ? "answers its readiness probe" : "does not answer its readiness probe" });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
