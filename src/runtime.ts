import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  createCore,
  defaultCountTokens,
  type CompressionCore,
  type CompressionState,
  type Config,
} from "acp-kernel";
import { resolveConfig, type AdapterConfig } from "./config.js";
import { entriesToCoreMessages } from "./messages.js";
import { SessionStateStore } from "./state.js";
import { logInfo, logWarn } from "./log.js";

// pi exposes `sessionManager.buildContextEntries()`; omp (oh-my-pi) only has
// `getBranch()`. Both return chronological SessionEntry[]; feature-detect so the
// adapter runs under either host (omp's runner silently swallows the TypeError).
type SessionEntrySource = {
  buildContextEntries?: () => SessionEntry[];
  getBranch?: () => SessionEntry[];
};

type AgentMessage = SessionMessageEntry["message"];

export function readContextEntries(sm: ExtensionContext["sessionManager"]): SessionEntry[] {
  const source = sm as unknown as SessionEntrySource;
  if (typeof source.buildContextEntries === "function") return source.buildContextEntries();
  if (typeof source.getBranch === "function") return source.getBranch();
  return [];
}

// True only on pi: `--mode json` event streaming (used by async delegates) is a
// pi feature. omp (oh-my-pi) has no json mode, so delegates must fall back to
// `-p` there — same detection as readContextEntries above.
export function isPiHost(sm: ExtensionContext["sessionManager"]): boolean {
  const source = sm as unknown as SessionEntrySource;
  return typeof source.buildContextEntries === "function";
}

export interface AcpRuntime {
  core: CompressionCore;
  store: SessionStateStore;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  /** Record that a nudge was already shown for the turn keyed by last user msg
   *  id, so a tier/growth nudge prints at most once per turn instead of on
   *  every context event (pi fires multiple per assistant reply). */
  markNudgeShown(turnKey: string): void;
  nudgeShownFor(turnKey: string): boolean;
  /** Clear per-turn nudge tracking. Called on session_start so the Set does not
   *  grow unbounded across sessions in a long-lived Pi process. */
  clearNudgeTracking(): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  stateFor(ctx: ExtensionContext, liveMessages?: AgentMessage[]): Promise<{ state: CompressionState; coreMessages: ReturnType<typeof entriesToCoreMessages>; entries: SessionEntry[] }>;
  save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
  acquireLock(sid: string): Promise<() => void>;
}

// omp fires the context event before the current user message is persisted to
// the session branch (its agent-loop emits message_end only after
// prepareProviderCall → transformContext), so getBranch() lags one message
// behind. Merge event.messages — the exact messages about to be sent,
// including the not-yet-persisted tail — with the persisted branch records:
// matching messages keep their stable entry id (so kernel refs survive once
// the message is persisted on the next turn), unmatched tail messages get
// `live-N` ids until they are persisted.
function mergeLiveEntries(entries: SessionEntry[], live: AgentMessage[]): SessionEntry[] {
  const persisted = entries.filter((e): e is SessionMessageEntry => e.type === "message");
  const out: SessionEntry[] = [];
  let p = 0;
  let unmatched = 0;
  for (let i = 0; i < live.length; i++) {
    const msg = live[i]!;
    let matched: SessionMessageEntry | undefined;
    let j = p;
    while (j < persisted.length && persisted[j]!.message.role !== msg.role) j++;
    if (j < persisted.length && sameMessage(persisted[j]!.message, msg)) {
      matched = persisted[j]!;
      p = j + 1;
    }
    if (matched) {
      out.push(matched);
    } else {
      unmatched++;
      out.push({
        type: "message",
        id: `live-${i}`,
        parentId: null,
        timestamp: String(msg.timestamp ?? Date.now()),
        message: msg,
      });
    }
  }
  if (unmatched > 0) logInfo("runtime", { event: "merge-live-entries", live: live.length, unmatched });
  return out;
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
  const ra = (a as { role?: string }).role;
  const rb = (b as { role?: string }).role;
  if (ra !== rb) return false;
  const ca = (a as { content?: unknown }).content;
  const cb = (b as { content?: unknown }).content;
  if (ca === undefined || cb === undefined) return false;
  try {
    return JSON.stringify(ca) === JSON.stringify(cb);
  } catch (e) {
    logWarn("runtime", { event: "message-compare-failed", error: e instanceof Error ? e.message : String(e) });
    return a === b;
  }
}

export function createRuntime(adapter: AdapterConfig): AcpRuntime {
  const core = createCore({ countTokens: defaultCountTokens });
  const store = new SessionStateStore();
  const locks = new Map<string, Promise<void>>();
  let adapterRef = adapter;
  const nudgeShownTurns = new Set<string>();

  async function acquireLock(sid: string): Promise<() => void> {
    const prev = locks.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => next);
    locks.set(sid, chain);
    await prev;
    return () => {
      // Only clear the map entry when we are the LATEST chain — otherwise a
      // queued acquireLock's chain would be dropped and it would run unlocked
      // concurrently with us (two processTurn/applyCompression + save pairs
      // racing on the same session).
      if (locks.get(sid) === chain) locks.delete(sid);
      release();
    };
  }

  function liveContextLimit(ctx: ExtensionContext): number {
    // Prefer pi's reported context window (matches what the footer shows) over
    // ctx.model.contextWindow, which can be stale or unset for some providers.
    const usage = ctx.getContextUsage?.();
    if (usage?.contextWindow && usage.contextWindow > 0) return usage.contextWindow;
    const m = ctx.model as { contextWindow?: number } | undefined;
    return m?.contextWindow ?? 0;
  }

  function configFor(ctx: ExtensionContext): Config {
    return resolveConfig(adapterRef, liveContextLimit(ctx));
  }

  async function stateFor(ctx: ExtensionContext, liveMessages?: AgentMessage[]) {
    const sm = ctx.sessionManager;
    const state = await store.load(sm.getSessionFile() ?? undefined, sm.getSessionId());
    const entries = readContextEntries(sm);
    // omp fires the context event BEFORE the current user message is persisted
    // to the session branch (its agent-loop emits message_end only after
    // prepareProviderCall → transformContext), so getBranch() lags one message
    // behind and the current prompt would be dropped from the rebuilt context.
    // pi appends user messages to the session before the LLM call, so its
    // buildContextEntries() is always current. Merge event.messages (the exact
    // messages about to be sent, including the not-yet-persisted tail) with the
    // persisted branch records on the omp path only.
    const merged = isPiHost(sm) || !liveMessages || liveMessages.length === 0 ? entries : mergeLiveEntries(entries, liveMessages);
    return { state, coreMessages: entriesToCoreMessages(merged), entries: merged };
  }

  async function save(state: CompressionState, ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    await store.save(state, sm.getSessionFile() ?? undefined, sm.getSessionId());
  }

  return { core, store, get adapter() { return adapterRef; }, setAdapter: (a) => { adapterRef = a; }, markNudgeShown: (k) => { nudgeShownTurns.add(k); }, nudgeShownFor: (k) => nudgeShownTurns.has(k), clearNudgeTracking: () => { nudgeShownTurns.clear(); }, liveContextLimit, configFor, stateFor, save, acquireLock };
}
