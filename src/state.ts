import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";
import { logError, logWarn } from "./log.js";

const STATE_SUFFIX = ".acp.json";

function stateFileFor(sessionFile: string | undefined): string | null {
  if (sessionFile) return sessionFile + STATE_SUFFIX;
  return null;
}

export class SessionStateStore {
  private cache: CompressionState | null = null;
  private loadedKey: string | null = null;

  async load(sessionFile: string | undefined, _sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    if (file && this.loadedKey === file && this.cache) return this.cache;
    let state = createInitialState();
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as CompressionState;
        if (parsed && Array.isArray(parsed.blocks)) state = mergeInitialState(parsed);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    this.cache = state;
    this.loadedKey = file;
    return state;
  }

  async save(state: CompressionState, sessionFile: string | undefined, _sessionId: string): Promise<void> {
    const file = stateFileFor(sessionFile);
    if (!file) return;
    this.cache = state;
    this.loadedKey = file;
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true }).catch((e: unknown) => {
      logError("state", { event: "save-mkdir-failed", dir, error: e instanceof Error ? e.message : String(e) });
    });
    const tmp = path.join(dir, `.acp-tmp-${path.basename(file)}`);
    try {
      await fs.writeFile(tmp, JSON.stringify(state), "utf8");
      await fs.rename(tmp, file);
    } catch (e) {
      logError("state", { event: "save-failed", file, error: e instanceof Error ? e.message : String(e) });
    }
  }

  invalidate(): void {
    this.cache = null;
    this.loadedKey = null;
  }
}

// Persisted state may predate new fields; fill any gaps so acp-kernel always sees
// a complete CompressionState (forward-compatible load).
function mergeInitialState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
  };
}

/** Drop messageRefs entries whose message is gone (pruned/compacted) AND whose
 *  ref is not referenced by any block (blocks track their messages via
 *  effectiveMessageIds). The highest-numbered ref survives even when stale:
 *  acp-kernel allocates new refs from highestUsedIndex + 1, so dropping it
 *  would reuse ref numbers and break monotonicity (nudge panel shows
 *  out-of-order start>end ranges). Keeps stale id→ref mappings bounded in
 *  long sessions (e.g. omp live-entry id swaps). */
export function pruneStaleRefs(state: CompressionState, aliveIds: Iterable<string>): void {
  const alive = new Set(aliveIds);
  const used = new Set<string>();
  for (const b of state.blocks) {
    for (const id of b.effectiveMessageIds ?? []) {
      const ref = state.messageRefs.byRaw[id];
      if (ref) used.add(ref);
    }
  }
  let highestRef: string | null = null;
  let highestNum = -1;
  for (const ref of Object.values(state.messageRefs.byRaw)) {
    const n = Number(ref.slice(1));
    if (Number.isInteger(n) && n > highestNum) {
      highestNum = n;
      highestRef = ref;
    }
  }
  for (const [id, ref] of Object.entries(state.messageRefs.byRaw)) {
    if (ref === highestRef) continue;
    if (!alive.has(id) && !used.has(ref)) {
      delete state.messageRefs.byRaw[id];
      delete state.messageRefs.byRef[ref];
    }
  }
}
