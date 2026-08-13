import type { Readable } from "node:stream";

export interface WatchdogOptions {
  eofGraceMs: number;
  idleMs: number;
  timeoutMs: number;
  killGraceMs: number;
}

export interface WatchdogHooks {
  /** True once the run is finalized; watchdogs stop firing. */
  isSettled(): boolean;
  /** The child is about to be killed (SIGTERM). reason explains why. */
  onKill(reason: string): void;
  /** stdout EOF passed without the process exiting; force-finalize now. */
  onEofGrace(): void;
}

export interface WatchdogHandle {
  /** Re-arm the idle timer (call on every stdout data). */
  poke(): void;
  /** Stop all timers (call on finalize). */
  dispose(): void;
  /**
   * agent_settled has been received: the agent's full flow (prompt + continue
   * loop + retries) is over and pi emits this exactly once in the finally of
   * _runAgentPrompt, after which the process should exit within milliseconds.
   * If it is still alive after graceMs, the process is stuck in teardown
   * (e.g. a provider call not returning) — kill it via killByWatchdog. graceMs
   * is symmetric with EOF_GRACE_MS (10s): normal exits are millisecond-level,
   * so 10s only hits genuinely hung processes. Idempotent (no-op when already
   * settled or a grace timer is pending); dispose() clears the timer.
   */
  settledGrace(graceMs: number, _killGraceMs: number, reason: string): void;
}

/**
 * Guarantees a hung child process gets killed. A stuck child holds its stdout
 * fd open, so stdout EOF never fires — hence the idle timer (no output for
 * idleMs) is the main defense; the hard time limit and the EOF grace period
 * cover the rest. Kill is SIGTERM, escalated to SIGKILL after killGraceMs.
 */
export function attachWatchdogs(
  child: { kill(signal: NodeJS.Signals): boolean; stdout: Readable | null },
  hooks: WatchdogHooks,
  opts: WatchdogOptions,
): WatchdogHandle {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let eofTimer: ReturnType<typeof setTimeout> | undefined;
  let killGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let settledGraceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (eofTimer) clearTimeout(eofTimer);
    if (killGraceTimer) clearTimeout(killGraceTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (settledGraceTimer) clearTimeout(settledGraceTimer);
  };

  const killByWatchdog = (reason: string): void => {
    if (hooks.isSettled()) return;
    hooks.onKill(reason);
    try {
      child.kill("SIGTERM");
    } catch {
      /* best-effort */
    }
    killGraceTimer = setTimeout(() => {
      if (hooks.isSettled()) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
    }, opts.killGraceMs);
    killGraceTimer.unref?.();
  };

  const settledGrace = (graceMs: number, _killGraceMs: number, reason: string): void => {
    if (hooks.isSettled() || settledGraceTimer) return;
    settledGraceTimer = setTimeout(() => {
      // Clear the reference before killing so a re-entrant killByWatchdog
      // (or a subsequent settledGrace call) sees no pending timer.
      settledGraceTimer = undefined;
      killByWatchdog(reason);
    }, graceMs);
    settledGraceTimer.unref?.();
  };

  const poke = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => killByWatchdog(`no output for ${opts.idleMs / 60_000}m`), opts.idleMs);
    idleTimer.unref?.();
  };

  poke();
  timeoutTimer = setTimeout(() => killByWatchdog(`${opts.timeoutMs / 60_000}m limit`), opts.timeoutMs);
  timeoutTimer.unref?.();

  const onStdoutEnd = (): void => {
    if (hooks.isSettled()) return;
    eofTimer = setTimeout(() => {
      if (hooks.isSettled()) return;
      hooks.onEofGrace();
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }, opts.eofGraceMs);
    eofTimer.unref?.();
  };
  child.stdout?.once("end", onStdoutEnd);

  return {
    poke,
    settledGrace,
    dispose: () => {
      clearTimers();
      child.stdout?.removeListener("end", onStdoutEnd);
    },
  };
}
