import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  createCore,
  defaultCountTokens,
  defaultPrompts,
  type CompressionCore,
  type CompressionState,
  type Config,
  type Prompts,
} from "acp-kernel";
import { resolveConfig, type AdapterConfig } from "./config.js";
import { DensityEstimator } from "./density.js";
import { entriesToCoreMessages, extractText, matchesStoredText, messageIdentity, messageRef } from "./messages.js";
import { SessionStateStore, type LiveRefOrigin } from "./state.js";
import { loadUserConfig, applyUserConfig, saveCompressionModelId } from "./user-config.js";
import { CompressionModelClient } from "./compress-model.js";
import { ThrottleEpisode } from "./throttle-retry.js";
import { logInfo, logWarn, setDebugEnabled } from "./log.js";
import { findUniqueLongestRun, type MatchRange } from "./sequence-match.js";
import { OverflowEpisode } from "./overflow-selfheal.js";
// pi exposes `sessionManager.buildContextEntries()`; omp (oh-my-pi) only has
// `getBranch()`. Both return chronological SessionEntry[]; feature-detect so
// the adapter runs under either host (omp's runner silently swallows the TypeError).
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

export function isPiHost(sm: ExtensionContext["sessionManager"]): boolean {
  const source = sm as unknown as SessionEntrySource;
  return typeof source.buildContextEntries === "function";
}

export interface AcpRuntime {
  core: CompressionCore;
  /** Per-session provider-throttle retry episode (attempt budget + kick
   *  pacing), keyed by session id so concurrent sessions in one extension
   *  instance cannot share an episode. Reset on session_start and on any
   *  real progress / user input. */
  throttleFor: (sid: string) => ThrottleEpisode;
  /** Drop a session's throttle episode entirely (session_shutdown): aborts a
   *  pending kick sleep and releases the map entry so a long-lived process
   *  that cycles through many sessions doesn't accumulate them. */
  throttleDrop: (sid: string) => void;
  store: SessionStateStore;
  density: DensityEstimator;
  /** 设置 countTokens 闭包使用的 modelId（每轮 context 事件调用）。 */
  setCountModel(modelId: string): void;
  /** Record this session's active block ids for the current context round;
   *  returns true when a new active block appeared since the previous round
   *  (i.e. a compress happened out-of-band — blocks are created by the
   *  compress tool between context events, so they can never be detected by
   *  comparing a single processTurn's input/output state). */
  noteActiveBlocks(sid: string, activeBlockIds: string[]): boolean;
  /** Drop per-session tracking state (session_start). */
  clearSessionTracking(sid: string): void;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  prompts: Prompts;
  setPrompts(prompts: Prompts): void;
  markNudgeShown(turnKey: string): void;
  nudgeShownFor(turnKey: string): boolean;
  /** Process compress toolResults for the CURRENT user turn only (the caller
   *  scopes the list — see collectCompressOutcomes in src/index.ts); idempotent
   *  per toolCallId. Outcome classes: isError or noop (0-block panel) →
   *  failure (count++), success panel (>= 1 block) → reset, other non-error
    *  text → neutral (count unchanged). Returns the failure count and
    *  whether the cap was just reached. */
  noteCompressOutcomes(turnKey: string, outcomes: ReadonlyArray<{ toolCallId: string; isError: boolean; success: boolean; noop?: boolean }>): { count: number; cappedNow: boolean };
  /** True when this turn already burned MAX_COMPRESS_ATTEMPTS failed/no-op
   *  compress calls — used to stop re-injecting the (dedup-exempt) emergency
   *  nudge that would otherwise keep looping no-op compressions (issue #6). */
  compressRetryCappedFor(turnKey: string): boolean;
  clearNudgeTracking(): void;
  clearCompressRetryTracking(): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  /** Re-read ~/.<dir>/acp.json + <cwd>/<dir>/acp.json and re-derive the adapter
   *  config when the contents change. Cheap no-op when unchanged. Called at
   *  session_start and on every context event so config edits apply live. */
  reloadConfig(cwd: string): Promise<void>;
  stateFor(ctx: ExtensionContext, liveMessages?: AgentMessage[]): Promise<{ state: CompressionState; coreMessages: ReturnType<typeof entriesToCoreMessages>; entries: SessionEntry[] }>;
  save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
  acquireLock(sid: string): Promise<() => void>;
  /** Per-session overflow self-heal state (learned window + armed emergency).
   *  Keyed by session id so concurrent sessions cannot share an episode. */
  overflowFor(sid: string): OverflowEpisode;
  /** Drop a session's overflow episode entirely (session_shutdown): releases
   *  the map entry so a long-lived process cycling through many sessions
   *  doesn't accumulate them. */
  overflowDrop(sid: string): void;
  /** Client for the dedicated compression model (reads models.json). */
  compressionModel: CompressionModelClient;
  /** The configured compression model ref, or undefined (main model writes). */
  getCompressionModelRef(): string | undefined;
  /** Persist the compression model ref to ~/.pi/acp.json and update the
   *  in-memory adapter so it takes effect immediately. null clears it. */
  setCompressionModelRef(value: string | null): Promise<void>;
  /** Store the exact transformed AgentMessage[] Pi sent in the last context
   *  round. The dedicated compression model reuses this as a prompt prefix so
   *  its call hits the provider's prompt cache (same system prompt + tools +
   *  messages the main model just saw). */
  setLastSentMessages(sid: string, messages: AgentMessage[]): void;
  /** The transformed messages from the last context round, or null. */
  getLastSentMessages(sid: string): AgentMessage[] | null;
}
// omp fires the context event before the current user message is persisted to
// the session branch, so merge event.messages (exact messages about to be sent,
// including the not-yet-persisted tail) with the persisted branch: matching
// messages keep their stable entry id, unmatched tail messages get `live-N`
// ids until persisted.
function mergeLiveEntries(entries: SessionEntry[], live: AgentMessage[], state: CompressionState, origins: LiveRefOrigin[]): SessionEntry[] {
  const persisted = entries.filter((e): e is SessionMessageEntry => e.type === "message");
  const liveIdentities = live.map(messageIdentity);
  const persistedIdentities = persisted.map((entry) => messageIdentity(entry.message));
  const persistedRange = findUniqueLongestRun<MatchKey>(persistedIdentities, normalizePersistedMatchKeys(persisted, persistedIdentities, live, liveIdentities));
  const originRange = findUniqueLongestRun(origins.map((origin) => origin.identity), liveIdentities);
  const out: SessionEntry[] = [];
  const nextOrigins: LiveRefOrigin[] = [];
  const usedIds = new Set<string>();
  for (let i = 0; i < live.length; i++) {
    const msg = live[i]!;
    const entry = valueInRange(persisted, persistedRange, i);
    const origin = valueInRange(origins, originRange, i);
    if (entry) {
      if (origin) migrateLiveRefs(state, origin.rawId, entry.id);
      else migrateTaggedRef(state, msg, entry.id);
      out.push(entry);
      continue;
    }
    const id = origin?.rawId ?? nextLiveId(state, usedIds, i);
    usedIds.add(id);
    out.push({ type: "message", id, parentId: null, timestamp: String(msg.timestamp ?? Date.now()), message: msg });
    nextOrigins.push({ rawId: id, identity: liveIdentities[i]! });
  }
  origins.splice(0, origins.length, ...nextOrigins);
  const unmatched = live.length - (persistedRange?.length ?? 0);
  if (unmatched > 0) logInfo("runtime", { event: "merge-live-entries", live: live.length, unmatched });
  return out;
}


function nextLiveId(state: CompressionState, used: Set<string>, index: number): string {
  let id = `live-${index}`;
  let suffix = index;
  while (used.has(id) || state.messageRefs.byRaw[id] !== undefined) id = `live-${++suffix}`;
  return id;
}

function migrateTaggedRef(state: CompressionState, message: AgentMessage, stableId: string): void {
  const ref = messageRef(message);
  const rawId = ref ? state.messageRefs.byRef[ref] : undefined;
  if (rawId?.startsWith("live-")) migrateLiveRefs(state, rawId, stableId);
}

function migrateLiveRefs(state: CompressionState, liveId: string, stableId: string): void {
  const rootId = liveId.split("#", 1)[0]!;
  if (!rootId.startsWith("live-")) return;
  for (const [rawId, ref] of Object.entries(state.messageRefs.byRaw)) {
    if (rawId !== rootId && !rawId.startsWith(`${rootId}#`)) continue;
    const stableRawId = `${stableId}${rawId.slice(rootId.length)}`;
    if (state.messageRefs.byRaw[stableRawId] === undefined) {
      state.messageRefs.byRaw[stableRawId] = ref;
      state.messageRefs.byRef[ref] = stableRawId;
    } else if (state.messageRefs.byRef[ref] === rawId) {
      delete state.messageRefs.byRef[ref];
    }
    delete state.messageRefs.byRaw[rawId];
  }
}

type MatchKey = string | symbol;

const NO_PERSISTED_MATCH = Symbol("no-persisted-match");

function normalizePersistedMatchKeys(
  persisted: readonly SessionMessageEntry[],
  persistedIdentities: readonly string[],
  live: readonly AgentMessage[],
  liveIdentities: readonly string[],
): MatchKey[] {
  const persistedByStructure = new Map<string, number>();
  for (let index = 0; index < persisted.length; index++) {
    const key = toolResultStructureKey(persisted[index]!.message);
    if (key === undefined) continue;
    persistedByStructure.set(key, persistedByStructure.has(key) ? -1 : index);
  }
  return live.map((message, liveIndex) => {
    const key = toolResultStructureKey(message);
    const candidateIndex = key === undefined ? undefined : persistedByStructure.get(key);
    if (candidateIndex === undefined) return liveIdentities[liveIndex]!;
    if (candidateIndex < 0) return NO_PERSISTED_MATCH;
    return sameToolResult(persisted[candidateIndex]!.message, message)
      ? persistedIdentities[candidateIndex]!
      : liveIdentities[liveIndex]!;
  });
}

function toolResultStructureKey(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult") return undefined;
  return `${message.toolName}\0${message.toolCallId}`;
}

function valueInRange<T>(values: readonly T[], range: MatchRange | undefined, liveIndex: number): T | undefined {
  if (!range || liveIndex < range.liveStart || liveIndex >= range.liveStart + range.length) return undefined;
  return values[range.candidateStart + liveIndex - range.liveStart];
}

function sameToolResult(stored: AgentMessage, visible: AgentMessage): boolean {
  if (stored.role !== "toolResult" || visible.role !== "toolResult") return false;
  return sameNonTextBlocks(stored.content, visible.content)
    && matchesStoredText(extractText(stored.content), extractText(visible.content));
}

function sameNonTextBlocks(a: unknown, b: unknown): boolean {
  const nonText = (blocks: unknown[]): unknown[] => blocks.filter((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return true;
    return block.type !== "text";
  });
  try {
    const na = Array.isArray(a) ? nonText(a) : [];
    const nb = Array.isArray(b) ? nonText(b) : [];
    return JSON.stringify(na) === JSON.stringify(nb);
  } catch {
    return false;
  }
}

function pruneOrphanRefs(state: CompressionState, messages: ReturnType<typeof entriesToCoreMessages>): void {
  const retainedRawIds = new Set(messages.map((message) => message.id));
  for (const block of state.blocks) {
    for (const rawId of [...block.directMessageIds, ...block.effectiveMessageIds]) retainedRawIds.add(rawId);
  }
  for (const [rawId, ref] of Object.entries(state.messageRefs.byRaw)) {
    if (retainedRawIds.has(rawId)) continue;
    delete state.messageRefs.byRaw[rawId];
    if (state.messageRefs.byRef[ref] === rawId) delete state.messageRefs.byRef[ref];
  }
  for (const [ref, rawId] of Object.entries(state.messageRefs.byRef)) {
    if (!retainedRawIds.has(rawId)) delete state.messageRefs.byRef[ref];
  }
}
/** Max FAILED compress calls per user turn before the nudge circuit breaker engages. */
export const MAX_COMPRESS_ATTEMPTS = 3;

export function createRuntime(adapter: AdapterConfig): AcpRuntime {
  const density = new DensityEstimator();
  let countModelId = "default";
  const core = createCore({
    // 密度校准版 countTokens（Phase 2）：默认回落 defaultCountTokens（density=1）
    countTokens: (text) => density.estimateWithDensity(countModelId, text),
  });
  const store = new SessionStateStore();
  const compressionModel = new CompressionModelClient();
  const lastActiveBlockIds = new Map<string, Set<string>>();
  const lastSentMessages = new Map<string, AgentMessage[]>();
  const locks = new Map<string, Promise<void>>();
  const factoryAdapter = adapter;
  let adapterRef = adapter;
  let lastUserConfigKey: string | undefined;
  let promptsRef: Prompts = defaultPrompts;
  const nudgeShownTurns = new Set<string>();
  // Per-session overflow self-heal state (learned window + armed emergency).
  const overflowEpisodes = new Map<string, OverflowEpisode>();
  function overflowFor(sid: string): OverflowEpisode {
    let ep = overflowEpisodes.get(sid);
    if (!ep) { ep = new OverflowEpisode(); overflowEpisodes.set(sid, ep); }
    return ep;
  }
  function overflowDrop(sid: string): void {
    overflowEpisodes.delete(sid);
  }

  const throttleEpisodes = new Map<string, ThrottleEpisode>();
  function throttleFor(sid: string): ThrottleEpisode {
    let ep = throttleEpisodes.get(sid);
    if (!ep) { ep = new ThrottleEpisode(); throttleEpisodes.set(sid, ep); }
    return ep;
  }
  function throttleDrop(sid: string): void {
    const ep = throttleEpisodes.get(sid);
    if (ep) ep.reset(); // abort a pending kick sleep before releasing the entry
    throttleEpisodes.delete(sid);
  }

  // Compress-failure tracking (see wireContextTransform): counts FAILED/no-op
  // compress calls per user turn so the nudge circuit breaker can stop
  // re-injecting the nudge at a model that answers every nudge with another
  // failed attempt (issue #6 emergency loop). The failed toolResult itself
  // persists in the session log — no transient retry prompt is injected
  // (transient re-injection per LLM call caused the #223 infinite loop). The
  // caller feeds only CURRENT-turn outcomes; success resets the counter,
  // neutral outcomes (non-error text that is not a success panel) leave it
  // frozen so mixed failure modes cannot bypass the cap.
  const compressOutcomeSeen = new Set<string>();
  let compressFailTurnKey: string | null = null;
  let compressFailCount = 0;

  function noteCompressOutcomes(turnKey: string, outcomes: ReadonlyArray<{ toolCallId: string; isError: boolean; success: boolean; noop?: boolean }>): { count: number; cappedNow: boolean } {
    if (compressFailTurnKey !== turnKey) {
      compressFailTurnKey = turnKey;
      compressFailCount = 0;
    }
    const prevCount = compressFailCount;
    for (const o of outcomes) {
      if (compressOutcomeSeen.has(o.toolCallId)) continue;
      compressOutcomeSeen.add(o.toolCallId);
      if (o.isError || o.noop === true) {
        compressFailCount += 1;
      } else if (o.success) {
        compressFailCount = 0;
      }
      // neutral: counter untouched
    }
    const cappedNow = compressFailCount >= MAX_COMPRESS_ATTEMPTS && prevCount < MAX_COMPRESS_ATTEMPTS;
    return { count: compressFailCount, cappedNow };
  }

  function compressRetryCappedFor(turnKey: string): boolean {
    return compressFailTurnKey === turnKey && compressFailCount >= MAX_COMPRESS_ATTEMPTS;
  }

  function clearCompressRetryTracking(): void {
    compressOutcomeSeen.clear();
    compressFailTurnKey = null;
    compressFailCount = 0;
  }

  async function acquireLock(sid: string): Promise<() => void> {
    const prev = locks.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = () => { locks.delete(sid); resolve(); }; });
    locks.set(sid, prev.then(() => next));
    await prev;
    return release;
  }

  function liveContextLimit(ctx: ExtensionContext): number {
    const usage = ctx.getContextUsage?.();
    if (usage?.contextWindow && usage.contextWindow > 0) return usage.contextWindow;
    const m = ctx.model as { contextWindow?: number } | undefined;
    return m?.contextWindow ?? 0;
  }

  function configFor(ctx: ExtensionContext): Config {
    const m = ctx.model as { provider?: string; id?: string } | undefined;
    return resolveConfig(adapterRef, liveContextLimit(ctx), m?.provider, m?.id);
  }

  function getCompressionModelRef(): string | undefined {
    return adapterRef.compressionModelId;
  }

  async function setCompressionModelRef(value: string | null): Promise<void> {
    await saveCompressionModelId(value);
    const next: AdapterConfig = { ...adapterRef };
    if (value === null) delete next.compressionModelId;
    else next.compressionModelId = value;
    adapterRef = next;
    // Force the next reloadConfig to re-read (the file now differs from the
    // cached key), keeping disk and memory in sync across sessions.
    lastUserConfigKey = undefined;
  }

  async function reloadConfig(cwd: string): Promise<void> {
    let user;
    try {
      user = await loadUserConfig(cwd);
    } catch (e) {
      logWarn("runtime", { event: "config-reload-failed", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      const key = JSON.stringify(user);
      if (key === lastUserConfigKey) return;
      lastUserConfigKey = key;
      // Re-derive from the factory config (not adapterRef) so a key REMOVED from
      // acp.json actually reverts, instead of lingering from a prior apply.
      adapterRef = applyUserConfig(factoryAdapter, user);
      if (adapterRef.debug !== undefined) setDebugEnabled(adapterRef.debug);
      logInfo("runtime", { event: "config-reloaded", limit: adapterRef.modelContextLimit ?? null });
    } catch (e) {
      logWarn("runtime", { event: "config-reload-failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function stateFor(ctx: ExtensionContext, liveMessages?: AgentMessage[]) {
    const sm = ctx.sessionManager;
    const sessionFile = sm.getSessionFile() ?? undefined;
    const sessionId = sm.getSessionId();
    const state = await store.load(sessionFile, sessionId);
    const entries = readContextEntries(sm);
    // omp fires the context event BEFORE the current user message is persisted
    // to the session branch (its agent-loop emits message_end only after
    // prepareProviderCall → transformContext), so getBranch() lags one message
    // behind and the current prompt would be dropped from the rebuilt context.
    // pi appends user messages to the session before the LLM call, so its
    // buildContextEntries() is always current. Merge event.messages (the exact
    // messages about to be sent, including the not-yet-persisted tail) with the
    // persisted branch records on the omp path only.
    if (!isPiHost(sm) && liveMessages && liveMessages.length > 0) {
      const origins = store.getLiveRefOrigins(sessionFile, sessionId);
      const merged = mergeLiveEntries(entries, liveMessages, state, origins);
      store.setLiveRefOrigins(sessionFile, sessionId, origins);
      const coreMessages = entriesToCoreMessages(merged);
      return { state, coreMessages, entries: merged };
    }
    const coreMessages = entriesToCoreMessages(entries);
    if (liveMessages === undefined) pruneOrphanRefs(state, coreMessages);
    return { state, coreMessages, entries };
  }

  async function save(state: CompressionState, ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    await store.save(state, sm.getSessionFile() ?? undefined, sm.getSessionId());
  }

  function noteActiveBlocks(sid: string, activeBlockIds: string[]): boolean {
    const current = new Set(activeBlockIds);
    const prev = lastActiveBlockIds.get(sid);
    const isNew = prev !== undefined && activeBlockIds.some((id) => !prev.has(id));
    lastActiveBlockIds.set(sid, current);
    return isNew;
  }
  function clearSessionTracking(sid: string): void {
    lastActiveBlockIds.delete(sid);
    lastSentMessages.delete(sid);
  }

  function setLastSentMessages(sid: string, messages: AgentMessage[]): void {
    lastSentMessages.set(sid, messages);
  }
  function getLastSentMessages(sid: string): AgentMessage[] | null {
    return lastSentMessages.get(sid) ?? null;
  }

  return { core, store, density, setCountModel: (m) => { countModelId = m; }, noteActiveBlocks, clearSessionTracking, get adapter() { return adapterRef; }, setAdapter: (a) => { adapterRef = a; }, get prompts() { return promptsRef; }, setPrompts: (p) => { promptsRef = p; }, markNudgeShown: (k) => { nudgeShownTurns.add(k); }, nudgeShownFor: (k) => nudgeShownTurns.has(k), clearNudgeTracking: () => { nudgeShownTurns.clear(); }, noteCompressOutcomes, compressRetryCappedFor, clearCompressRetryTracking, liveContextLimit, configFor, reloadConfig, stateFor, save, acquireLock, overflowFor, overflowDrop, throttleFor, throttleDrop, compressionModel, getCompressionModelRef, setCompressionModelRef, setLastSentMessages, getLastSentMessages };}
