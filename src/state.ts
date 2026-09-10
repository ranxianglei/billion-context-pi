import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";
import { logError, logInfo, logWarn } from "./log.js";

const STATE_SUFFIX = ".acp.json";

export interface LiveRefOrigin {
  rawId: string;
  identity: string;
}

/** One-time marker persisted in a child sidecar when deriveChildState ran
 *  (#364): proves this session's state was explicitly derived from a parent,
 *  so later loads never re-derive. */
export interface DerivedFrom {
  parentSessionId: string;
  derivedAt: number;
}

interface StateCacheSlot {
  state: CompressionState;
  liveRefOrigins: LiveRefOrigin[];
  derivedFrom: DerivedFrom | null;
}

function stateFileFor(sessionFile: string | undefined): string | null {
  if (sessionFile) return sessionFile + STATE_SUFFIX;
  return null;
}

export async function readParentSessionPath(sessionFile: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(sessionFile, "r");
    try {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) return undefined;
      const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
      if (!firstLine.startsWith("{")) return undefined;
      const header = JSON.parse(firstLine);
      return typeof header.parentSession === "string" ? header.parentSession : undefined;
    } finally {
      await handle.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logWarn("state", { event: "read-parent-header-failed", file: sessionFile, error: e instanceof Error ? e.message : String(e) });
    }
    return undefined;
  }
}

function cacheKey(sessionFile: string | undefined, sessionId: string): string {
  return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

export class SessionStateStore {
  private cache = new Map<string, StateCacheSlot>();

  async load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    const key = cacheKey(sessionFile, sessionId);
    const cached = this.cache.get(key);
    if (cached) return cached.state;
    let state = createInitialState();
    let liveRefOrigins: LiveRefOrigin[] = [];
    let derivedFrom: DerivedFrom | null = null;
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as CompressionState & { liveRefOrigins?: unknown; derivedFrom?: unknown };
        if (parsed && Array.isArray(parsed.blocks)) {
          state = mergeInitialState(parsed);
          liveRefOrigins = parseLiveRefOrigins(parsed.liveRefOrigins);
          derivedFrom = parseDerivedFrom(parsed.derivedFrom);
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // Inherit from parent when own state has no compression blocks.
      // Covers two cases: (1) ENOENT — file doesn't exist yet (new clone);
      // (2) empty blocks — file exists but was poisoned by a pre-fix resume
      // that saved createInitialState() before inheritance was added.
      if (state.blocks.length === 0 && sessionFile) {
        const parentState = await this.tryLoadParentState(sessionFile);
        if (parentState) state = parentState;
      }
    }
    this.cache.set(key, { state, liveRefOrigins, derivedFrom });
    return state;
  }

  async save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void> {
    const file = stateFileFor(sessionFile);
    const key = cacheKey(sessionFile, sessionId);
    const prev = this.cache.get(key);
    const liveRefOrigins = prev?.liveRefOrigins ?? [];
    const derivedFrom = prev?.derivedFrom ?? null;
    // Cache update is unconditional: file-less (in-memory) sessions have no
    // sidecar to persist, but their state must still survive across turns in
    // this process — otherwise every compress result is dropped and the model
    // re-compresses the same original context forever (issue #322).
    this.cache.set(key, { state, liveRefOrigins, derivedFrom });
    if (!file) return;
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true }).catch((e: unknown) => {
      logError("state", { event: "save-mkdir-failed", dir, error: e instanceof Error ? e.message : String(e) });
    });
    const tmp = path.join(dir, `.acp-tmp-${path.basename(file)}`);
    try {
      const payload: Record<string, unknown> = { ...state, liveRefOrigins };
      if (derivedFrom) payload.derivedFrom = derivedFrom;
      await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.rename(tmp, file);
    } catch (e) {
      logError("state", { event: "save-failed", file, error: e instanceof Error ? e.message : String(e) });
    }
  }

  getLiveRefOrigins(sessionFile: string | undefined, sessionId: string): LiveRefOrigin[] {
    return [...(this.cache.get(cacheKey(sessionFile, sessionId))?.liveRefOrigins ?? [])];
  }

  setLiveRefOrigins(sessionFile: string | undefined, sessionId: string, origins: LiveRefOrigin[]): void {
    const key = cacheKey(sessionFile, sessionId);
    const slot = this.cache.get(key);
    if (slot) this.cache.set(key, { state: slot.state, liveRefOrigins: [...origins], derivedFrom: slot.derivedFrom });
  }

  getDerivedFrom(sessionFile: string | undefined, sessionId: string): DerivedFrom | null {
    return this.cache.get(cacheKey(sessionFile, sessionId))?.derivedFrom ?? null;
  }

  setDerivedFrom(sessionFile: string | undefined, sessionId: string, mark: DerivedFrom | null): void {
    const key = cacheKey(sessionFile, sessionId);
    const slot = this.cache.get(key);
    if (slot) this.cache.set(key, { state: slot.state, liveRefOrigins: slot.liveRefOrigins, derivedFrom: mark });
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async tryLoadParentState(sessionFile: string): Promise<CompressionState | undefined> {
    const MAX_CHAIN_DEPTH = 8;
    let current = sessionFile;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      const parentJsonl = await readParentSessionPath(current);
      if (!parentJsonl) return undefined;
      const parentAcp = stateFileFor(parentJsonl);
      if (!parentAcp) return undefined;
      try {
        const raw = await fs.readFile(parentAcp, "utf8");
        const parsed = JSON.parse(raw) as CompressionState;
        if (parsed && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
          logInfo("state", { event: "inherited-parent-state", file: parentAcp, depth, blocks: parsed.blocks.length, tokensCompressed: parsed.stats?.tokensCompressed ?? 0 });
          return mergeInitialState(parsed);
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "parent-state-load-failed", file: parentAcp, error: e instanceof Error ? e.message : String(e) });
          return undefined;
        }
      }
      current = parentJsonl;
    }
    logWarn("state", { event: "parent-chain-exhausted", file: sessionFile, maxDepth: MAX_CHAIN_DEPTH });
    return undefined;
  }
}

function parseDerivedFrom(value: unknown): DerivedFrom | null {
  if (!value || typeof value !== "object") return null;
  const mark = value as { parentSessionId?: unknown; derivedAt?: unknown };
  if (typeof mark.parentSessionId !== "string" || typeof mark.derivedAt !== "number") return null;
  return { parentSessionId: mark.parentSessionId, derivedAt: mark.derivedAt };
}

/** #364: derive an INLINE child session's compression state from its parent's
 *  (same-process sub-sessions, e.g. Prime RLM). Inherits exactly what makes
 *  inherited blocks usable — blocks (deep-copied: they carry mutable fields),
 *  message refs, the per-message token snapshot, and the id counters so new
 *  child blocks cannot collide with inherited ids — and resets every rhythm
 *  ledger (nudge cadence baseline, stats counters, absorb records) so the
 *  child starts its own clock. Separate-process pi-native delegates must NOT
 *  use this: their session files carry a parentSession header that already
 *  inherits the parent state verbatim. */
export function deriveChildState(parent: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: structuredClone(parent.blocks),
    messageRefs: { byRaw: { ...parent.messageRefs.byRaw }, byRef: { ...parent.messageRefs.byRef } },
    tokenSnapshot: { ...parent.tokenSnapshot },
    nudge: fresh.nudge,
    stats: fresh.stats,
    absorbed: [],
    nextBlockId: parent.nextBlockId,
    nextRunId: parent.nextRunId,
  };
}

function parseLiveRefOrigins(value: unknown): LiveRefOrigin[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is LiveRefOrigin => {
    if (!item || typeof item !== "object") return false;
    const origin = item as { rawId?: unknown; identity?: unknown };
    return typeof origin.rawId === "string" && typeof origin.identity === "string";
  });
}

function mergeInitialState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
  };
}
