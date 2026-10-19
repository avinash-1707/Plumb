import { randomBytes } from "node:crypto";
import path from "node:path";
import { ensureGitignore } from "../managed/block.ts";
import { type Outcome, portOpen, probeNow, runToCompletion, StartedProcess, waitReady } from "./runner.ts";
import { type StartedService, type StepResult, startService, stopServices } from "./services.ts";
import type { Command, LocalConfig, Profile } from "./types.ts";

export interface VerifyResult {
  ok: boolean;
  evidenceDir: string;
  steps: StepResult[];
  teardown: string[];
}

export type { StepResult } from "./services.ts";

/** Sortable and unique enough for evidence directory names. */
export function runId(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

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
  const startedServices: StartedService[] = [];
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
    teardown.push(...(await stopServices(root, startedServices.splice(0), env, logFor, redact)));
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
      const result = await startService(root, service, local, env, logFor(step), redact, {
        onStart: track.onStart,
        onRegister: (s) => startedServices.push(s),
      });
      steps.push(result);
      if (result.status === "failed") return { ok: false, evidenceDir: evidenceRel, steps, teardown };
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
