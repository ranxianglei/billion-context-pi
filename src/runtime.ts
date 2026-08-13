import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  createCore,
  defaultCountTokens,
  type CompressionCore,
  type CompressionState,
  type Config,
} from "acp-kernel";
import { resolveConfig, type AdapterConfig } from "./config.js";
import { entriesToCoreMessages, extractText, matchesStoredText, messageIdentity, messageRef } from "./messages.js";
import { SessionStateStore, type LiveRefOrigin } from "./state.js";
import { logInfo, logWarn } from "./log.js";
import { findUniqueLongestRun, type MatchRange } from "./sequence-match.js";

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
  store: SessionStateStore;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  markNudgeShown(turnKey: string): void;
  nudgeShownFor(turnKey: string): boolean;
  clearNudgeTracking(): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  stateFor(ctx: ExtensionContext, liveMessages?: AgentMessage[]): Promise<{ state: CompressionState; coreMessages: ReturnType<typeof entriesToCoreMessages>; entries: SessionEntry[] }>;
  save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
  acquireLock(sid: string): Promise<() => void>;
}

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

  return { core, store, get adapter() { return adapterRef; }, setAdapter: (a) => { adapterRef = a; }, markNudgeShown: (k) => { nudgeShownTurns.add(k); }, nudgeShownFor: (k) => nudgeShownTurns.has(k), clearNudgeTracking: () => { nudgeShownTurns.clear(); }, liveContextLimit, configFor, stateFor, save, acquireLock };
}
