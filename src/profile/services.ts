import path from "node:path";
import { type Outcome, probeNow, runToCompletion, type StartedProcess, waitReady } from "./runner.ts";
import type { Command, LocalConfig, Service } from "./types.ts";

export interface StepResult {
  step: string;
  command: string | null;
  cwd: string | null;
  status: "passed" | "failed" | "skipped";
  /** Why it failed or was skipped. */
  detail?: string;
  log?: string;
  tail?: string[];
  durationMs?: number;
}

/** A service this run started, with the command that stops it (null: the profile has none). */
export interface StartedService {
  name: string;
  stop: Command | null;
}

const FROM_LOCAL = "<command from .plumb/local.json>";

export interface ServiceHooks {
  /** Called as soon as a start command's process exists, so a Ctrl-C handler can stop it mid-start. */
  onStart: (proc: StartedProcess) => void;
  /** Called before the start command runs, so a start that fails halfway is still stopped. */
  onRegister: (service: StartedService) => void;
}

/**
 * Brings up one profile service unless something already serves it. A service already answering its readiness probe
 * is used but never started or stopped: it isn't this run's to stop.
 */
export async function startService(
  root: string,
  service: Service,
  local: LocalConfig,
  env: NodeJS.ProcessEnv,
  log: { abs: string; rel: string },
  redact: (text: string) => string,
  hooks: ServiceHooks,
): Promise<StepResult> {
  const step = `service-${service.name}`;
  const override = local.services[service.name];
  if (override?.skip === true) return { step, command: null, cwd: null, status: "skipped", detail: "skipped in .plumb/local.json" };
  // A local.json answer replaces the profile's command, or supplies one the profile couldn't know.
  const withOverride = (base: Command | null, cmd: string | undefined, timeoutSec: number): Command | null =>
    cmd === undefined ? base : { cmd, cwd: base?.cwd ?? ".", timeoutSec: base?.timeoutSec ?? timeoutSec };
  const start = withOverride(service.start, override?.start, 180);
  const stop = withOverride(service.stop, override?.stop, 60);
  const shown = start === null ? null : override?.start !== undefined ? FROM_LOCAL : redact(start.cmd);
  if (service.ready !== null && (await probeNow(service.ready))) {
    return { step, command: shown, cwd: start?.cwd ?? null, status: "passed", detail: "already running; not started or stopped by Plumb" };
  }
  if (start === null) return { step, command: null, cwd: null, status: "failed", detail: "not running, and the profile has no start command" };
  // Without a readiness probe Plumb can't tell it wasn't already running, so it never stops it; validate requires a
  // probe on any service with a stop command.
  if (service.ready !== null) hooks.onRegister({ name: service.name, stop });
  const outcome: Outcome = await runToCompletion(step, start.cmd, path.resolve(root, start.cwd), env, start.timeoutSec, log.abs, { onStart: hooks.onStart });
  const base = { step, command: shown, cwd: start.cwd, log: log.rel, durationMs: outcome.durationMs };
  if (!outcome.ok) return { ...base, status: "failed", detail: redact(outcome.reason ?? "failed"), tail: outcome.tail.map(redact) };
  if (service.ready !== null) {
    const ready = await waitReady(service.ready, null, start.timeoutSec);
    if (!ready.ok) return { ...base, status: "failed", detail: ready.reason ?? "never became ready", tail: outcome.tail.map(redact) };
  }
  return { ...base, status: "passed" };
}

/** Stops started services in reverse order; returns one teardown line per service. */
export async function stopServices(
  root: string,
  services: StartedService[],
  env: NodeJS.ProcessEnv,
  logFor: (step: string) => { abs: string; rel: string },
  redact: (text: string) => string,
): Promise<string[]> {
  const lines: string[] = [];
  for (const service of [...services].reverse()) {
    if (service.stop === null) {
      lines.push(`left ${service.name} running: the profile has no stop command for it`);
      continue;
    }
    const log = logFor(`stop-${service.name}`);
    const outcome = await runToCompletion(`stop-${service.name}`, service.stop.cmd, path.resolve(root, service.stop.cwd), env, service.stop.timeoutSec, log.abs, { sweep: true });
    lines.push(outcome.ok ? `stopped ${service.name}` : `could not stop ${service.name}: ${redact(outcome.reason ?? "failed")} (see ${log.rel})`);
  }
  return lines;
}
