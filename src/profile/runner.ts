import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, readFileSync, writeSync, type WriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ReadinessProbe } from "./types.ts";

const TAIL_LINES = 30;
const KILL_GRACE_MS = 5000;

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A command Plumb started in its own process group, so teardown kills exactly what it started and nothing else. */
export class StartedProcess {
  readonly name: string;
  readonly logFile: string;
  readonly exited: Promise<Exit>;
  readonly #child: ChildProcess;
  readonly #log: WriteStream;
  readonly #tail: string[] = [];
  readonly #lineListeners = new Set<(line: string) => void>();
  #partial = "";
  #exit: Exit | null = null;

  constructor(name: string, cmd: string, cwd: string, env: NodeJS.ProcessEnv, logFile: string) {
    this.name = name;
    this.logFile = logFile;
    mkdirSync(path.dirname(logFile), { recursive: true });
    this.#log = createWriteStream(logFile);
    this.#log.write(`$ ${cmd}\n# cwd: ${cwd}\n`);
    // detached: the shell leads a new process group, so killing -pid reaches every process it spawned.
    this.#child = spawn("sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer): void => {
      this.#log.write(chunk);
      const text = this.#partial + chunk.toString("utf8");
      const lines = text.split("\n");
      this.#partial = lines.pop() ?? "";
      for (const line of lines) this.#line(line);
    };
    this.#child.stdout?.on("data", onData);
    this.#child.stderr?.on("data", onData);
    this.exited = new Promise((resolve) => {
      this.#child.on("error", (err) => {
        this.#line(`plumb: could not start: ${err.message}`);
        this.#exit = { code: 127, signal: null };
        resolve(this.#exit);
      });
      this.#child.on("close", (code, signal) => {
        if (this.#partial !== "") this.#line(this.#partial);
        this.#exit = { code, signal };
        this.#log.end();
        resolve(this.#exit);
      });
    });
  }

  #line(line: string): void {
    this.#tail.push(line);
    if (this.#tail.length > TAIL_LINES) this.#tail.shift();
    for (const listener of this.#lineListeners) listener(line);
  }

  get tail(): string[] {
    return [...this.#tail];
  }

  get exit(): Exit | null {
    return this.#exit;
  }

  onLine(listener: (line: string) => void): () => void {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  #signalGroup(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      // ESRCH: the group is gone. EPERM after the leader exited: macOS's answer for a group with only zombies left.
      if (code !== "ESRCH" && !(code === "EPERM" && this.#exit !== null)) throw err;
    }
  }

  /**
   * SIGTERM to the whole group, then SIGKILL after a grace period. The group is signalled even when the shell
   * itself has exited, since a descendant that redirected its output can outlive it.
   */
  async stop(): Promise<void> {
    if (this.#child.pid === undefined) return;
    if (this.#exit !== null) {
      this.#signalGroup("SIGTERM");
      return;
    }
    this.#signalGroup("SIGTERM");
    const timer = new Promise<"timeout">((resolve) => setTimeout(() => { resolve("timeout"); }, KILL_GRACE_MS).unref());
    if ((await Promise.race([this.exited, timer])) === "timeout") {
      this.#signalGroup("SIGKILL");
      await this.exited;
    }
  }
}

export interface Outcome {
  ok: boolean;
  /** Why it failed, in one line. */
  reason?: string;
  tail: string[];
  durationMs: number;
}

export interface RunOptions {
  /** Called as soon as the process exists, so a Ctrl-C handler can stop a step that is still running. */
  onStart?: (proc: StartedProcess) => void;
  /**
   * Kill anything the command left behind in its process group once it finishes. Off for service starts, which may
   * leave a daemon running on purpose.
   */
  sweep?: boolean;
}

/** Runs a command to completion with a timeout. */
export async function runToCompletion(name: string, cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeoutSec: number, logFile: string, options: RunOptions = {}): Promise<Outcome> {
  const started = Date.now();
  const proc = new StartedProcess(name, cmd, cwd, env, logFile);
  options.onStart?.(proc);
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => { resolve("timeout"); }, timeoutSec * 1000).unref());
  const result = await Promise.race([proc.exited, timer]);
  if (result === "timeout") {
    await proc.stop();
    return { ok: false, reason: `timed out after ${String(timeoutSec)}s`, tail: proc.tail, durationMs: Date.now() - started };
  }
  if (options.sweep === true) await proc.stop();
  const ok = result.code === 0;
  return {
    ok,
    ...(ok ? {} : { reason: result.signal !== null ? `killed by ${result.signal}` : `exited with code ${String(result.code)}` }),
    tail: proc.tail,
    durationMs: Date.now() - started,
  };
}

/**
 * Whether anything accepts connections on the port over IPv4 or IPv6 loopback: dev servers often bind `localhost`,
 * which is ::1 only on macOS.
 */
export async function portOpen(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([connects(port, "127.0.0.1"), connects(port, "::1")]);
  return v4 || v6;
}

function connects(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

async function httpReady(url: string, expectStatus: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return res.status === expectStatus;
  } catch (err) {
    // Connection refused or a slow first response: not ready yet.
    if (err instanceof TypeError || (err instanceof DOMException && err.name === "TimeoutError")) return false;
    throw err;
  }
}

/** Whether a probe passes right now, without starting anything. */
export async function probeNow(probe: ReadinessProbe): Promise<boolean> {
  if (probe.kind === "http") return httpReady(probe.url, probe.expectStatus);
  if (probe.kind === "port") return portOpen(probe.port);
  return false;
}

/** Waits until the probe passes, the process exits, or the timeout runs out. */
export async function waitReady(probe: ReadinessProbe, proc: StartedProcess | null, timeoutSec: number): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutSec * 1000;
  if (probe.kind === "log") {
    if (proc === null) return { ok: false, reason: "a log readiness probe needs a process Plumb started" };
    const pattern = new RegExp(probe.pattern);
    if (proc.tail.some((l) => pattern.test(l))) return { ok: true };
    return new Promise((resolve) => {
      const off = proc.onLine((line) => {
        if (pattern.test(line)) finish({ ok: true });
      });
      const timer = setTimeout(() => { finish({ ok: false, reason: `log never matched /${probe.pattern}/ within ${String(timeoutSec)}s` }); }, Math.max(0, deadline - Date.now()));
      void proc.exited.then((exit) => { finish({ ok: false, reason: `exited with code ${String(exit.code)} before it was ready` }); });
      let done = false;
      function finish(result: { ok: boolean; reason?: string }): void {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve(result);
      }
    });
  }
  for (;;) {
    if (proc?.exit != null) return { ok: false, reason: `exited with code ${String(proc.exit.code)} before it was ready` };
    if (await probeNow(probe)) return { ok: true };
    if (Date.now() >= deadline) {
      const what = probe.kind === "http" ? `${probe.url} never returned ${String(probe.expectStatus)}` : `port ${String(probe.port)} never opened`;
      return { ok: false, reason: `${what} within ${String(timeoutSec)}s` };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Starts a command in its own session and process group that outlives this CLI process: `plumb verify --launch`
 * returns while the app keeps running, and `--cleanup` later kills the group by the recorded id. Output goes straight
 * to the log file because no process stays behind to read a pipe.
 */
export async function spawnDetached(cmd: string, cwd: string, env: NodeJS.ProcessEnv, logFile: string): Promise<number> {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    writeSync(fd, `$ ${cmd}\n# cwd: ${cwd}\n`);
    const child = spawn("sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("spawn", () => {
        if (child.pid === undefined) reject(new Error(`could not start: ${cmd}`));
        else resolve(child.pid);
      });
      child.once("error", reject);
    });
    child.unref();
    return pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether any process in the group is still running. EPERM is macOS's answer for a group that only holds zombies of a
 * dead leader, which is as good as gone (the processes are this user's, so it is never a permission problem).
 */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw err;
  }
}

/** When a process started, as `ps` prints it; null when no such process exists. */
export function processStart(pid: number): string | null {
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.error !== undefined) throw ps.error;
  const out = ps.stdout.trim();
  return ps.status === 0 && out !== "" ? out : null;
}

/**
 * Whether a recorded process group is still the one Plumb started. A pid is never reused while its process group
 * exists, so a live leader with a different start time means the group died and the id now belongs to someone else.
 * A gone leader with members left is still Plumb's group.
 */
export function sameGroup(pgid: number, leaderStart: string | null): boolean {
  if (leaderStart === null) return true;
  const now = processStart(pgid);
  return now === null || now === leaderStart;
}

/**
 * SIGTERM to a recorded process group, then SIGKILL after the grace period. Returns whether the group is gone; a
 * group whose id now belongs to another process (see sameGroup) is never signalled and counts as gone.
 */
export async function stopGroup(pgid: number, leaderStart: string | null = null): Promise<boolean> {
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, sig);
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      if (code !== "ESRCH" && code !== "EPERM") throw err;
    }
  };
  if (!groupAlive(pgid) || !sameGroup(pgid, leaderStart)) return true;
  signal("SIGTERM");
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (groupAlive(pgid)) signal("SIGKILL");
  for (let i = 0; i < 20 && groupAlive(pgid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  return !groupAlive(pgid);
}

/** The last lines of a log file, for failure reports. */
export function logTail(logFile: string, lines = TAIL_LINES): string[] {
  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1).slice(-lines);
}

/** Waits until the probe passes for a detached group, the group dies, or the timeout runs out. */
export async function waitReadyDetached(probe: ReadinessProbe, pgid: number, logFile: string, timeoutSec: number): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutSec * 1000;
  const pattern = probe.kind === "log" ? new RegExp(probe.pattern) : null;
  for (;;) {
    const ready = pattern === null ? await probeNow(probe) : logTail(logFile, Number.MAX_SAFE_INTEGER).some((l) => pattern.test(l));
    if (ready) return { ok: true };
    if (!groupAlive(pgid)) return { ok: false, reason: "exited before it was ready" };
    if (Date.now() >= deadline) {
      const what = probe.kind === "http" ? `${probe.url} never returned ${String(probe.expectStatus)}` : probe.kind === "port" ? `port ${String(probe.port)} never opened` : `log never matched /${probe.pattern}/`;
      return { ok: false, reason: `${what} within ${String(timeoutSec)}s` };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** A port nothing listens on over IPv4 or IPv6 loopback right now. */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address !== null && typeof address === "object") resolve(address.port);
          else reject(new Error("no port assigned"));
        });
      });
    });
    if (!(await portOpen(port))) return port;
  }
  throw new Error("could not find a free port");
}
