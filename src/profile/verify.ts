import { randomBytes } from "node:crypto";
import path from "node:path";
import { ensureGitignore } from "../managed/block.ts";
import { type Outcome, portOpen, probeNow, runToCompletion, StartedProcess, waitReady } from "./runner.ts";
import type { Command, LocalConfig, Profile } from "./types.ts";

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

export interface VerifyResult {
  ok: boolean;
  evidenceDir: string;
  steps: StepResult[];
  teardown: string[];
}

function runId(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

const FROM_LOCAL = "<command from .plumb/local.json>";

/** Replaces every local.json value in text: secrets never reach the report, the transcript, or stdout. */
export function redactor(local: LocalConfig): (text: string) => string {
  const secrets = Object.values(local.env).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((t, secret) => t.replaceAll(secret, "<redacted>"), text);
}

/** Process env, then safe local defaults the app didn't get elsewhere, then the user's local.json answers. */
export function verificationEnv(profile: Profile, local: LocalConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const req of profile.env) {
    if (req.defaultForVerification !== null && env[req.name] === undefined) env[req.name] = req.defaultForVerification;
  }
  return { ...env, ...local.env };
}

/**
 * "Make it boot" (doc 2, init step 6): runs every profile command in order, stops at the first failure, and always
 * tears down what it started (reverse order), including on Ctrl-C. Logs go to .plumb/evidence/verify-<id>/ and
 * survive teardown.
 */
export async function verifyProfile(root: string, profile: Profile, local: LocalConfig, options: { bootOnly?: boolean } = {}): Promise<VerifyResult> {
  ensureGitignore(root);
  const evidenceRel = `.plumb/evidence/verify-${runId()}`;
  const evidence = path.join(root, evidenceRel);
  const env = verificationEnv(profile, local);
  const steps: StepResult[] = [];
  const teardown: string[] = [];
  // Every process this run started, including a step still in progress, so Ctrl-C can stop all of them.
  const started: StartedProcess[] = [];
  const running: StartedProcess[] = [];
  const startedServices: Array<{ name: string; stop: Command | null }> = [];
  const track = {
    onStart: (proc: StartedProcess): void => {
      started.push(proc);
    },
  };
  const redact = redactor(local);

  const logFor = (step: string): { abs: string; rel: string } => {
    const file = `${step.replaceAll(/[^a-z0-9-]+/gi, "-")}.log`;
    return { abs: path.join(evidence, file), rel: `${evidenceRel}/${file}` };
  };
  const record = (step: string, command: Command | null, outcome: Outcome | null, extra: Partial<StepResult> = {}): boolean => {
    const log = logFor(step).rel;
    const ok = outcome?.ok ?? true;
    steps.push({
      step,
      command: command === null ? null : redact(command.cmd),
      cwd: command?.cwd ?? null,
      status: ok ? "passed" : "failed",
      ...(outcome === null ? {} : { log, durationMs: outcome.durationMs }),
      ...(ok || outcome === null ? {} : { detail: redact(outcome.reason ?? "failed"), tail: outcome.tail.map(redact) }),
      ...extra,
    });
    return ok;
  };
  const runStep = async (step: string, command: Command | null): Promise<boolean> => {
    if (command === null) return true;
    const outcome = await runToCompletion(step, command.cmd, path.resolve(root, command.cwd), env, command.timeoutSec, logFor(step).abs, { ...track, sweep: true });
    return record(step, command, outcome);
  };

  const stopAll = async (): Promise<void> => {
    for (const proc of running.splice(0).reverse()) {
      await proc.stop();
      teardown.push(`stopped ${proc.name}`);
    }
    // Steps interrupted mid-run (Ctrl-C); finished ones were already swept or are services stopped below.
    for (const proc of started.splice(0).reverse()) if (proc.exit === null) await proc.stop();
    for (const service of startedServices.splice(0).reverse()) {
      if (service.stop === null) {
        teardown.push(`left ${service.name} running: the profile has no stop command for it`);
        continue;
      }
      const outcome = await runToCompletion(`stop-${service.name}`, service.stop.cmd, path.resolve(root, service.stop.cwd), env, service.stop.timeoutSec, logFor(`stop-${service.name}`).abs, { sweep: true });
      teardown.push(outcome.ok ? `stopped ${service.name}` : `could not stop ${service.name}: ${redact(outcome.reason ?? "failed")} (see ${logFor(`stop-${service.name}`).rel})`);
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    void stopAll().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (options.bootOnly !== true) {
      if (!(await runStep("install", profile.install))) return { ok: false, evidenceDir: evidenceRel, steps, teardown };
      if (!(await runStep("build", profile.build))) return { ok: false, evidenceDir: evidenceRel, steps, teardown };
    }

    for (const service of profile.services) {
      const step = `service-${service.name}`;
      const override = local.services[service.name];
      if (override?.skip === true) {
        steps.push({ step, command: null, cwd: null, status: "skipped", detail: "skipped in .plumb/local.json" });
        continue;
      }
      // A local.json answer replaces the profile's command, or supplies one the profile couldn't know.
      const withOverride = (base: Command | null, cmd: string | undefined, timeoutSec: number): Command | null =>
        cmd === undefined ? base : { cmd, cwd: base?.cwd ?? ".", timeoutSec: base?.timeoutSec ?? timeoutSec };
      const start = withOverride(service.start, override?.start, 180);
      const stop = withOverride(service.stop, override?.stop, 60);
      const shownStart = start === null ? null : override?.start !== undefined ? FROM_LOCAL : redact(start.cmd);
      if (service.ready !== null && (await probeNow(service.ready))) {
        // Something is already serving it; use it, but it isn't Plumb's to stop.
        steps.push({ step, command: shownStart, cwd: start?.cwd ?? null, status: "passed", detail: "already running; not started or stopped by Plumb" });
        continue;
      }
      if (start === null) {
        steps.push({ step, command: null, cwd: null, status: "failed", detail: "not running, and the profile has no start command" });
        return { ok: false, evidenceDir: evidenceRel, steps, teardown };
      }
      // Registered before it starts, so a start that fails halfway (a healthcheck timeout) is still stopped. Without
      // a readiness probe Plumb can't tell it wasn't already running, so it never stops it; validate requires a
      // probe on any service with a stop command.
      if (service.ready !== null) startedServices.push({ name: service.name, stop });
      const outcome = await runToCompletion(step, start.cmd, path.resolve(root, start.cwd), env, start.timeoutSec, logFor(step).abs, track);
      if (!record(step, start, outcome, shownStart === null ? {} : { command: shownStart })) return { ok: false, evidenceDir: evidenceRel, steps, teardown };
      if (service.ready !== null) {
        const ready = await waitReady(service.ready, null, start.timeoutSec);
        if (!ready.ok) {
          const last = steps.at(-1);
          if (last !== undefined) Object.assign(last, { status: "failed", detail: ready.reason ?? "never became ready" });
          return { ok: false, evidenceDir: evidenceRel, steps, teardown };
        }
      }
    }

    if (options.bootOnly !== true) {
      for (const name of ["lint", "typecheck", "unit", "integration", "e2e"] as const) {
        if (!(await runStep(name, profile.checks[name]))) return { ok: false, evidenceDir: evidenceRel, steps, teardown };
      }
    }

    for (const target of profile.run) {
      const step = `run-${target.name}`;
      // Never probe or drive an instance this run didn't start.
      if (target.port !== null && (await portOpen(target.port))) {
        steps.push({ step, command: redact(target.start.cmd), cwd: target.start.cwd, status: "failed", detail: `port ${String(target.port)} is already in use by another process; stop it and retry` });
        return { ok: false, evidenceDir: evidenceRel, steps, teardown };
      }
      if (await probeNow(target.ready)) {
        steps.push({ step, command: redact(target.start.cmd), cwd: target.start.cwd, status: "failed", detail: "something already answers its readiness probe before Plumb started it; stop it and retry" });
        return { ok: false, evidenceDir: evidenceRel, steps, teardown };
      }
      const startedAt = Date.now();
      const proc = new StartedProcess(target.name, target.start.cmd, path.resolve(root, target.start.cwd), env, logFor(step).abs);
      running.push(proc);
      const ready = await waitReady(target.ready, proc, target.start.timeoutSec);
      const outcome: Outcome = { ok: ready.ok, ...(ready.reason === undefined ? {} : { reason: ready.reason }), tail: proc.tail, durationMs: Date.now() - startedAt };
      if (!record(step, target.start, outcome)) return { ok: false, evidenceDir: evidenceRel, steps, teardown };
    }
    return { ok: true, evidenceDir: evidenceRel, steps, teardown };
  } finally {
    for (const target of [...profile.run].reverse()) {
      if (target.stop !== "signal" && running.some((p) => p.name === target.name)) {
        await runToCompletion(`stop-${target.name}`, target.stop.cmd, path.resolve(root, target.stop.cwd), env, target.stop.timeoutSec, logFor(`stop-${target.name}`).abs, { sweep: true });
      }
    }
    await stopAll();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/** The standard failure report shape (doc 6): step, command, log, and the relevant lines. */
export function formatVerify(result: VerifyResult): string {
  const lines: string[] = [];
  for (const s of result.steps) {
    const mark = s.status === "passed" ? "✓" : s.status === "skipped" ? "-" : "✗";
    const time = s.durationMs === undefined ? "" : ` ${(s.durationMs / 1000).toFixed(1)}s`;
    lines.push(`${mark} ${s.step}${s.command === null ? "" : ` (${s.command})`}${time}${s.status !== "failed" && s.detail !== undefined ? ` - ${s.detail}` : ""}`);
    if (s.status === "failed") {
      lines.push("", `✗ plumb profile verify failed: ${s.step}`, "");
      if (s.command !== null) lines.push(`  command  ${s.command}`, `  cwd      ${s.cwd ?? "."}`);
      lines.push(`  reason   ${s.detail ?? "failed"}`);
      if (s.log !== undefined) lines.push(`  log      ${s.log}`);
      if (s.tail !== undefined && s.tail.length > 0) lines.push("", ...s.tail.map((l) => `  ${l}`));
      lines.push("");
    }
  }
  if (result.teardown.length > 0) lines.push(`teardown: ${result.teardown.join("; ")}`);
  lines.push(result.ok ? `profile verified; logs in ${result.evidenceDir}` : `evidence kept in ${result.evidenceDir}`);
  return `${lines.join("\n")}\n`;
}
