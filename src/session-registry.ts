// Long-lived hosts (fork-host servers such as Pi Pocket) serve many sessions
// in ONE process for days or weeks, and a session that simply goes quiet may
// never emit session_shutdown (#672). Every per-session structure therefore
// shares one lifetime policy instead of relying on the shutdown event alone:
// explicit drop on session_shutdown PLUS automatic eviction once the session
// has been idle past the TTL, or when more sessions are tracked than the cap
// allows (least recently seen first). Eviction is safe by construction: a
// returning session re-derives its bookkeeping from the next context fire (or
// re-reads its sidecar), and the worst case of losing a tracker is a reset
// ledger — never corrupted state.

export const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_SESSION_MAX_TRACKED = 32;

export type SessionDropHandler = (sid: string) => void;

export interface SessionRegistryOptions {
  /** Idle window after which a session's bookkeeping is evicted (ms). */
  ttlMs?: number;
  /** Hard cap on tracked sessions; beyond it the least recently seen go first. */
  maxTracked?: number;
}

export class SessionRegistry {
  private readonly ttlMs: number;
  private readonly maxTracked: number;
  private readonly lastSeenAt = new Map<string, number>();
  private readonly handlers: SessionDropHandler[] = [];

  constructor(options: SessionRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
    this.maxTracked = Math.max(1, Math.floor(options.maxTracked ?? DEFAULT_SESSION_MAX_TRACKED));
  }

  /** Register a per-session structure's dropper. It fires on explicit drop
   *  AND on idle/cap eviction, so registration is the only wiring a new
   *  per-session map needs to stop leaking. Droppers must be idempotent. */
  track(handler: SessionDropHandler): void {
    this.handlers.push(handler);
  }

  /** Record activity for a session, then evict whatever fell out of the
   *  lifetime window. Called on the hot path (every context fire and ACP
   *  tool call), so it stays O(tracked sessions). */
  touch(sid: string, now: number = Date.now()): void {
    this.lastSeenAt.set(sid, now);
    this.sweep(now);
  }

  /** Explicitly release a session's bookkeeping (session_shutdown). Safe to
   *  call for unknown or already-released sessions. */
  drop(sid: string): void {
    if (!this.lastSeenAt.delete(sid)) return;
    this.fire(sid);
  }

  /** Number of tracked sessions (observability/test hook). */
  get size(): number {
    return this.lastSeenAt.size;
  }

  private fire(sid: string): void {
    for (const handler of this.handlers) handler(sid);
  }

  private sweep(now: number): void {
    // Oldest first: idle expiry is monotonic along the sort, and the over-cap
    // budget is consumed from the front, so the first entry that is neither
    // expired nor capped ends the walk. The just-touched sid is the newest
    // entry and can never be a victim (maxTracked is clamped to >= 1).
    const entries = [...this.lastSeenAt.entries()].sort((a, b) => a[1] - b[1]);
    let overCap = entries.length - this.maxTracked;
    for (const [sid, seen] of entries) {
      const expired = now - seen > this.ttlMs;
      const capped = overCap > 0;
      if (!expired && !capped) break;
      this.lastSeenAt.delete(sid);
      if (capped) overCap--;
      this.fire(sid);
    }
  }
}
