import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createCore,
  defaultCountTokens,
  defaultPrompts,
  type CompressionCore,
  type CompressionState,
  type Config,
  type Prompts,
} from "acp-kernel";
import { resolveCompress, resolveConfig, type AdapterConfig } from "./config.js";
import { applyStrictReasoningGate, resolveReasoningDrop, type CompressReasoningConfig } from "./reasoning-drop.js";
import { entriesToCoreMessages, EntryProjectionCache, extractText, matchesStoredText, messageIdentity, messageRef } from "./messages.js";
import { SessionStateStore, deriveChildState, type LiveRefOrigin } from "./state.js";
import { hasCompressHistory, rebuildStateFromLog } from "./state-rebuild.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";
import { sanitizeSurfaceConfig } from "./surface.js";
import { ThrottleEpisode } from "./throttle-retry.js";
import { logInfo, logWarn, setDebugEnabled } from "./log.js";
import { findPositionalPrefixRun, findUniqueLongestRun, type MatchRange } from "./sequence-match.js";
import { OverflowEpisode } from "./overflow-selfheal.js";
import { lastTurnBoundaryId, type TurnBoundaryPolicy } from "./turn-boundary.js";
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

/** #453: key for the compress-retry circuit breaker, derived from PERSISTED
 *  entries only. Live-merged tail ids (content-addressed since #459) can still
 *  churn when the host's view of a not-yet-persisted message drifts, so a
 *  breaker keyed on the merged view could reset failCount mid-episode (#452
 *  log: cap → inject loop). Persisted entry ids are immutable; this key
 *  changes only when a genuine new user message reaches the session log.
 *  pi-native hosts see no change. */
export function retryBreakerKey(sm: ExtensionContext["sessionManager"], policy?: TurnBoundaryPolicy): string | undefined {
  return lastTurnBoundaryId(readContextEntries(sm), policy);
}

/** Minimal identity of a session for state operations that don't need a live
 *  ExtensionContext (hosts deriving inline child sessions build these from
 *  whatever session handles they hold). */
export interface SessionRef {
  sessionId: string;
  sessionFile?: string;
}

export interface AcpRuntime {
  core: CompressionCore;
  /** Set when the host is unsupported (currently: OMP / oh-my-pi) or when the
   *  model's baseUrl routes through the billion-context wire proxy (#296).
   *  Once true, the extension stands down: the context transform, system-prompt
   *  injection, compaction-cancel and ACP tools all no-op so the host runs
   *  untouched. Set at session_start (first context event as fallback). */
  refused: boolean;
  /** User-facing reason shown when a refused ACP tool is invoked; null means
   *  the default OMP refusal text applies. Set together with `refused`. */
  refusalMessage: string | null;
  /** True when acp_delegate stood down this session because a third-party
   *  subagent extension (pi-subagents) is installed and delegate.forceEnable
   *  is not set (#415). Gates delegate tool registration and the system-prompt
   *  delegate section. Reset on every session_start. */
  delegateStoodDown: boolean;
  /** Per-session provider-throttle retry episode (attempt budget + kick
   *  pacing), keyed by session id so concurrent sessions in one extension
   *  instance cannot share an episode. Reset on session_start and on any
   *  real progress / user input. */
  throttleFor: (sid: string) => ThrottleEpisode;
  /** Drop a session's throttle episode entirely (session_shutdown): aborts a
   *  pending kick sleep and releases the map entry so a long-lived process
   *  that cycles through many sessions doesn't accumulate them. */
  throttleDrop: (sid: string) => void;
  /** Per-session tokenCount scale tracker (estimate vs provider). Returns true
   *  when the scale just flipped (stale↔not-stale) so the caller can reset the
   *  growth baseline — a cross-scale delta is a false artifact, not real growth
   *  (issue #267). The first observation for a session never reports a flip. */
  noteTokenScale: (sid: string, stale: boolean) => boolean;
  /** Drop a session's token-scale tracker (session_shutdown). */
  dropTokenScale: (sid: string) => void;
  store: SessionStateStore;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  prompts: Prompts;
  setPrompts(prompts: Prompts): void;
  markNudgeShown(sid: string, turnKey: string, tokenCount?: number): void;
  nudgeShownFor(sid: string, turnKey: string): boolean;
  /** tokenCount at the last actual nudge injection for this turn, for growth-aware re-inject (issue #269). */
  nudgeShownTokensFor(sid: string, turnKey: string): number | undefined;
  /** Clears the token-count stamps recorded by markNudgeShown — used on a token-scale flip (issue #267) so the same-turn re-inject floor (#269 / PR #316) is not computed against an old-scale stamp. */
  clearNudgeTokenStamps(sid: string): void;
  /** Process compress toolResults for the CURRENT user turn only (the caller
   *  scopes the list — see collectCompressOutcomes in src/index.ts); idempotent
   *  per toolCallId. turnKey MUST be the stable persisted-boundary key
   *  (retryBreakerKey) — a key derived from live-merged entries churns under
   *  fork hosts and resets the counter mid-episode (#453). Outcome classes:
   *  isError or noop (0-block panel) → failure (count++), success panel
   *  (>= 1 block) → reset, other non-error text → neutral (count unchanged).
   *  Returns the failure count and whether the cap was just reached. */
  noteCompressOutcomes(sid: string, turnKey: string, outcomes: ReadonlyArray<{ toolCallId: string; isError: boolean; success: boolean; noop?: boolean }>): { count: number; cappedNow: boolean };
  /** True when this turn already burned MAX_COMPRESS_ATTEMPTS failed/no-op
   *  compress calls — used to stop re-injecting the (dedup-exempt) emergency
   *  nudge that would otherwise keep looping no-op compressions (issue #6). */
  compressRetryCappedFor(sid: string, turnKey: string): boolean;
  clearNudgeTracking(sid: string): void;
  clearCompressRetryTracking(sid: string): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  /** [#336] Effective compress.reasoning drop settings for the active model
   *  (three-level merge + defaults). Feeds the request-time pass in the
   *  context transform. */
  reasoningDropFor(ctx: ExtensionContext): Required<CompressReasoningConfig>;
  /** Effective historical-image strip policy for the active model (issue #321).
   *  Host-side policy — deliberately NOT part of the kernel Config object. */
  stripImagesFor(ctx: ExtensionContext): { enabled: boolean; keepRecent: number };
  /** Re-read ~/.<dir>/acp.json + <cwd>/<dir>/acp.json and re-derive the adapter
   *  config when the contents change. Cheap no-op when unchanged. Called at
   *  session_start and on every context event so config edits apply live. */
  reloadConfig(cwd: string): Promise<void>;
  stateFor(ctx: ExtensionContext, liveMessages?: AgentMessage[]): Promise<{ state: CompressionState; coreMessages: ReturnType<typeof entriesToCoreMessages>; entries: SessionEntry[] }>;
  /** Record the EXACT sent view measured off the real processTurn output for
   *  this turn (issue #561): `viewTokens` counts turn.messages (the pruned,
   *  summary-injected projection that actually went on the wire), and `usable`
   *  marks whether that count is an honest view — a turn that ran with
   *  tokenCount at/above the truncate band may have truncated its output, so
   *  its post-truncation size under-reports and must not be trusted next turn. */
  noteSentViewCount(sid: string, record: { viewTokens: number; blocksLen: number; activeBlocks: number; limit: number; usable: boolean }): void;
  /** Last turn's measured sent view, or undefined on the first turn / after a
   *  signature change (blocks added or dropped, window re-centered). */
  peekSentViewCount(sid: string): { viewTokens: number; blocksLen: number; activeBlocks: number; limit: number; usable: boolean } | undefined;
  /** Drop a session's sent-view meter (session_shutdown). */
  dropSentViewCount(sid: string): void;
  save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
  /** #364 inline child sessions (same process, e.g. Prime RLM): derive the
   *  child's compression state from another session's. Inherits blocks /
   *  message refs / token snapshot so decompress + search_context keep working
   *  on inherited blocks; resets every rhythm ledger (nudge cadence, stats,
   *  absorb). One-time: writes a derivation marker into the child sidecar and
   *  refuses to run again; also refuses when the child already owns real
   *  (non-derived) blocks or when the parent has no blocks. Separate-process
   *  pi-native delegates must NOT call this — their parentSession header
   *  already inherits verbatim. Returns true when the child state was derived. */
  deriveChildState(child: SessionRef, parent: SessionRef): Promise<boolean>;
  acquireLock(sid: string): Promise<() => void>;
  /** Per-session overflow self-heal state (learned window + armed emergency).
   *  Keyed by session id so concurrent sessions cannot share an episode. */
  overflowFor(sid: string): OverflowEpisode;
  /** Drop a session's overflow episode entirely (session_shutdown): releases
   *  the map entry so a long-lived process cycling through many sessions
   *  doesn't accumulate them. */
  overflowDrop(sid: string): void;
  /** Record a compress call whose every requested range is dead (refs stale or
   *  unknown — the kernel cannot create a block from it no matter what summary
   *  is written). Returns the failure count for this exact range fingerprint
   *  in this session (issue #250 loop breaker). */
  noteDeadCompress(sid: string, fingerprint: string): number;
  /** Drop a session's dead-range repeat tracking (a successful compress is
   *  progress — reset the #250 loop breaker for the next attempt round;
   *  session_shutdown for memory hygiene). Compress does NOT renumber refs. */
  clearDeadCompress(sid: string): void;
  /** Record one turn's FRESH-anchor provider usage sample and report whether
   *  the recent window is stable enough to calibrate the internal estimate
   *  against it (issue #455): >=3 of the last 4 samples agree within a 25%
   *  spread. A jittering getContextUsage() must not become a moving cap, so
   *  unstable windows report false and the raw estimate stands. */
  noteHostUsage(sid: string, tokens: number): boolean;
  /** Drop a session's host-usage stability window (session_shutdown). */
  dropHostUsageSamples(sid: string): void;
  /** Track persistent >2x internal-vs-provider size disagreement (issue #455);
   *  returns true exactly once per episode — on the third consecutive
   *  divergent turn — so the caller warns once instead of every turn. A
   *  convergent turn ends the episode. */
  noteSizeDivergence(sid: string, divergent: boolean): boolean;
  /** Drop a session's size-divergence episode (session_shutdown). */
  dropSizeDivergence(sid: string): void;
  /** Track the kernel's terminal-escape signal (issue #464): returns true
   *  exactly once per episode — the first consecutive stuck fire — so the
   *  caller logs/notifies once instead of every turn. A non-escaping turn
   *  ends the episode. */
  noteTerminalEscape(sid: string, active: boolean): boolean;
  /** Drop a session's terminal-escape episode (session_shutdown). */
  dropTerminalEscape(sid: string): void;
  /** Track the kernel's truncation-skipped signal (issue #464): returns true
   *  exactly once per episode for low-frequency diagnostics. A turn that
   *  truncates (or skips nothing) ends the episode. */
  noteTruncationSkipped(sid: string, active: boolean): boolean;
  /** Drop a session's truncation-skipped episode (session_shutdown). */
  dropTruncationSkipped(sid: string): void;
}
// omp fires the context event before the current user message is persisted to
// the session branch, so merge event.messages (exact messages about to be sent,
// including the not-yet-persisted tail) with the persisted branch: matching
// messages keep their stable entry id, unmatched tail messages get
// content-addressed `live-<hash>` ids (#459) until persisted.
function mergeLiveEntries(entries: SessionEntry[], live: AgentMessage[], state: CompressionState, origins: LiveRefOrigin[]): SessionEntry[] {
  const persisted = entries.filter((e): e is SessionMessageEntry => e.type === "message");
  const liveIdentities = live.map(messageIdentity);
  const persistedIdentities = persisted.map((entry) => messageIdentity(entry.message));
  const normalizedKeys = normalizePersistedMatchKeys(persisted, persistedIdentities, live, liveIdentities);
  // #459: the unique matcher gives up on duplicate-heavy views (ambiguous best
  // run), which previously stranded every live message and renumbered its
  // volatile live-N id each fire; the tail-anchored prefix run recovers the
  // alignment deterministically under append-only growth.
  const persistedRange = findUniqueLongestRun<MatchKey>(persistedIdentities, normalizedKeys) ?? findPositionalPrefixRun<MatchKey>(persistedIdentities, normalizedKeys);
  const originRange = findUniqueLongestRun(origins.map((origin) => origin.identity), liveIdentities);
  // #459: occurrence rank of each identity across (persisted + unmatched live
  // prefix). When a message gets persisted it moves from the live count into
  // the persisted count, so every still-live duplicate keeps the same rank —
  // its id stays put across fires.
  const identityRanks = new Map<string, number>();
  for (const identity of persistedIdentities) identityRanks.set(identity, (identityRanks.get(identity) ?? 0) + 1);
  const out: SessionEntry[] = [];
  const nextOrigins: LiveRefOrigin[] = [];
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
    const identity = liveIdentities[i]!;
    const rank = identityRanks.get(identity) ?? 0;
    identityRanks.set(identity, rank + 1);
    const id = origin?.rawId ?? stableLiveId(identity, rank);
    out.push({ type: "message", id, parentId: null, timestamp: String(msg.timestamp ?? Date.now()), message: msg });
    nextOrigins.push({ rawId: id, identity });
  }
  origins.splice(0, origins.length, ...nextOrigins);
  const unmatched = live.length - (persistedRange?.length ?? 0);
  if (unmatched > 0) logInfo("runtime", { event: "merge-live-entries", live: live.length, unmatched });
  return out;
}

// #459: deterministic id for an unmatched live message — sha256 over its
// content identity plus occurrence rank, so the same logical message gets the
// same id on every context fire (and after a state rebuild) even when the
// unique matcher cannot align it.
function stableLiveId(identity: string, rank: number): string {
  return `live-${createHash("sha256").update(`${identity}\u0000${rank}`).digest("hex").slice(0, 16)}`;
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
  const core = createCore({
    // CJK-aware base counter (kernel default); the meter's real-scale floor
    // (src/index.ts) covers provider-anchored calibration.
    countTokens: defaultCountTokens,
  });
  const store = new SessionStateStore();
  const locks = new Map<string, Promise<void>>();
  const factoryAdapter = adapter;
  let adapterRef = adapter;
  let lastUserConfigKey: string | undefined;
  let promptsRef: Prompts = defaultPrompts;
  const nudgeShownTurns = new Map<string, Set<string>>();
  const nudgeShownTokens = new Map<string, Map<string, number>>();
  function markNudgeShown(sid: string, turnKey: string, tokenCount?: number): void {
    let turns = nudgeShownTurns.get(sid);
    if (!turns) { turns = new Set(); nudgeShownTurns.set(sid, turns); }
    turns.add(turnKey);
    if (tokenCount !== undefined) {
      let toks = nudgeShownTokens.get(sid);
      if (!toks) { toks = new Map(); nudgeShownTokens.set(sid, toks); }
      toks.set(turnKey, tokenCount);
    }
  }
  function nudgeShownFor(sid: string, turnKey: string): boolean {
    return nudgeShownTurns.get(sid)?.has(turnKey) ?? false;
  }
  function nudgeShownTokensFor(sid: string, turnKey: string): number | undefined {
    return nudgeShownTokens.get(sid)?.get(turnKey);
  }
  function clearNudgeTracking(sid: string): void {
    nudgeShownTurns.delete(sid);
    nudgeShownTokens.delete(sid);
  }
  function clearNudgeTokenStamps(sid: string): void {
    nudgeShownTokens.delete(sid);
  }
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

  // Issue #561: the sent-view meter replaces the per-turn probe processTurn
  // (clone + full second pass). Steady-state turns read the previous turn's
  // measured view instead of re-measuring; see noteSentViewCount for fields.
  const sentViewMeters = new Map<string, { viewTokens: number; blocksLen: number; activeBlocks: number; limit: number; usable: boolean }>();
  function noteSentViewCount(sid: string, record: { viewTokens: number; blocksLen: number; activeBlocks: number; limit: number; usable: boolean }): void {
    sentViewMeters.set(sid, record);
  }
  function peekSentViewCount(sid: string): { viewTokens: number; blocksLen: number; activeBlocks: number; limit: number; usable: boolean } | undefined {
    return sentViewMeters.get(sid);
  }
  function dropSentViewCount(sid: string): void {
    sentViewMeters.delete(sid);
  }

  const deadCompressCounts = new Map<string, Map<string, number>>();
  function noteDeadCompress(sid: string, fingerprint: string): number {
    let per = deadCompressCounts.get(sid);
    if (!per) { per = new Map(); deadCompressCounts.set(sid, per); }
    const count = (per.get(fingerprint) ?? 0) + 1;
    per.set(fingerprint, count);
    return count;
  }
  function clearDeadCompress(sid: string): void {
    deadCompressCounts.delete(sid);
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

  // Per-session tokenCount scale (estimate vs provider). When the anchor flips
  // stale↔not-stale the meter switches rulers; a growth delta spanning that
  // switch is a false artifact (issue #267), so the caller resets the baseline.
  const tokenScaleStale = new Map<string, boolean>();
  function noteTokenScale(sid: string, stale: boolean): boolean {
    const prev = tokenScaleStale.get(sid);
    tokenScaleStale.set(sid, stale);
    return prev !== undefined && prev !== stale;
  }
  function dropTokenScale(sid: string): void {
    tokenScaleStale.delete(sid);
  }

  // [#455] Per-session window of FRESH-anchor provider usage samples. The
  // calibration anchor caps the internal estimate at measured × headroom, but
  // only while recent samples agree: a jittering getContextUsage() (±15K on
  // near-identical views in the #452 log) must not become a moving cap.
  const HOST_USAGE_WINDOW = 4;
  const HOST_USAGE_MIN_SAMPLES = 3;
  const HOST_USAGE_SPREAD_MAX = 0.25;
  const hostUsageSamples = new Map<string, number[]>();
  function noteHostUsage(sid: string, tokens: number): boolean {
    if (tokens <= 0) return false;
    let win = hostUsageSamples.get(sid);
    if (!win) {
      win = [];
      hostUsageSamples.set(sid, win);
    }
    win.push(tokens);
    if (win.length > HOST_USAGE_WINDOW) win.shift();
    if (win.length < HOST_USAGE_MIN_SAMPLES) return false;
    const lo = Math.min(...win);
    const hi = Math.max(...win);
    return (hi - lo) / lo <= HOST_USAGE_SPREAD_MAX;
  }
  function dropHostUsageSamples(sid: string): void {
    hostUsageSamples.delete(sid);
  }

  // [#455] Persistent >2x internal-vs-provider disagreement, one warn per
  // episode: fires on the third consecutive divergent turn, resets when the
  // rulers converge or the session ends.
  const sizeDivergenceStreaks = new Map<string, number>();
  function noteSizeDivergence(sid: string, divergent: boolean): boolean {
    if (!divergent) {
      sizeDivergenceStreaks.delete(sid);
      return false;
    }
    const streak = (sizeDivergenceStreaks.get(sid) ?? 0) + 1;
    sizeDivergenceStreaks.set(sid, streak);
    return streak === 3;
  }
  function dropSizeDivergence(sid: string): void {
    sizeDivergenceStreaks.delete(sid);
  }

  // [#464] Kernel observability signals (acp-kernel#302): terminalEscape is
  // the "compression cannot save this session" last signal, truncationSkipped
  // explains a silent emergency-truncate no-op. One episode flag each — the
  // kernel fires them every stuck turn, users must see them once.
  const terminalEscapeEpisodes = new Set<string>();
  function noteTerminalEscape(sid: string, active: boolean): boolean {
    if (!active) {
      terminalEscapeEpisodes.delete(sid);
      return false;
    }
    if (terminalEscapeEpisodes.has(sid)) return false;
    terminalEscapeEpisodes.add(sid);
    return true;
  }
  function dropTerminalEscape(sid: string): void {
    terminalEscapeEpisodes.delete(sid);
  }
  const truncationSkipEpisodes = new Set<string>();
  function noteTruncationSkipped(sid: string, active: boolean): boolean {
    if (!active) {
      truncationSkipEpisodes.delete(sid);
      return false;
    }
    if (truncationSkipEpisodes.has(sid)) return false;
    truncationSkipEpisodes.add(sid);
    return true;
  }
  function dropTruncationSkipped(sid: string): void {
    truncationSkipEpisodes.delete(sid);
  }

  // [#361] session ids already logged for the strict-echo auto-disable, so the
  // info event fires once per session rather than once per LLM call.
  const strictEchoLogged = new Set<string>();

  // Compress-failure tracking (see wireContextTransform): counts FAILED/no-op
  // compress calls per user turn so the nudge circuit breaker can stop
  // re-injecting the nudge at a model that answers every nudge with another
  // failed attempt (issue #6 emergency loop). The failed toolResult itself
  // persists in the session log — no transient retry prompt is injected
  // (transient re-injection per LLM call caused the #223 infinite loop). The
  // caller feeds only CURRENT-turn outcomes; success resets the counter,
  // neutral outcomes (non-error text that is not a success panel) leave it
  // frozen so mixed failure modes cannot bypass the cap.
  interface CompressOutcomeTracker {
    seen: Set<string>;
    failTurnKey: string | null;
    failCount: number;
  }
  const compressOutcomes = new Map<string, CompressOutcomeTracker>();
  function compressTrackerFor(sid: string): CompressOutcomeTracker {
    let t = compressOutcomes.get(sid);
    if (!t) { t = { seen: new Set(), failTurnKey: null, failCount: 0 }; compressOutcomes.set(sid, t); }
    return t;
  }

  function noteCompressOutcomes(sid: string, turnKey: string, outcomes: ReadonlyArray<{ toolCallId: string; isError: boolean; success: boolean; noop?: boolean }>): { count: number; cappedNow: boolean } {
    const t = compressTrackerFor(sid);
    if (t.failTurnKey !== turnKey) {
      t.failTurnKey = turnKey;
      t.failCount = 0;
    }
    const prevCount = t.failCount;
    for (const o of outcomes) {
      if (t.seen.has(o.toolCallId)) continue;
      t.seen.add(o.toolCallId);
      if (o.isError || o.noop === true) {
        t.failCount += 1;
      } else if (o.success) {
        t.failCount = 0;
      }
      // neutral: counter untouched
    }
    const cappedNow = t.failCount >= MAX_COMPRESS_ATTEMPTS && prevCount < MAX_COMPRESS_ATTEMPTS;
    return { count: t.failCount, cappedNow };
  }

  function compressRetryCappedFor(sid: string, turnKey: string): boolean {
    const t = compressOutcomes.get(sid);
    return t !== undefined && t.failTurnKey === turnKey && t.failCount >= MAX_COMPRESS_ATTEMPTS;
  }

  function clearCompressRetryTracking(sid: string): void {
    compressOutcomes.delete(sid);
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

  function reasoningDropFor(ctx: ExtensionContext): Required<CompressReasoningConfig> {
    const m = ctx.model as { provider?: string; id?: string; baseUrl?: string } | undefined;
    const resolved = resolveReasoningDrop(resolveCompress(adapterRef.compress, m?.provider, m?.id).reasoning);
    // [#361] strict-echo upstreams (DeepSeek thinking mode) must keep reasoning
    // round-tripping or the rebuilt request 400s — force the pass off regardless
    // of config so a thinking-mode session can't be broken by default drop:true.
    const gated = applyStrictReasoningGate(resolved, m?.provider, m?.baseUrl);
    if (resolved.drop && !gated.drop) {
      const sid = ctx.sessionManager.getSessionId();
      if (!strictEchoLogged.has(sid)) {
        strictEchoLogged.add(sid);
        logInfo("runtime", { sid, event: "compress-reasoning-auto-disabled", reason: "strict-echo-upstream", provider: m?.provider ?? null, issue: "#361" });
      }
    }
    return gated;
  }

  function stripImagesFor(ctx: ExtensionContext): { enabled: boolean; keepRecent: number } {
    const m = ctx.model as { provider?: string; id?: string } | undefined;
    const c = resolveCompress(adapterRef.compress, m?.provider, m?.id);
    const raw = Number(c.stripImagesKeepRecent);
    const keepRecent = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5;
    return { enabled: c.stripImages === true, keepRecent };
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
      adapterRef = sanitizeSurfaceConfig(applyUserConfig(factoryAdapter, user));
      if (adapterRef.debug !== undefined) setDebugEnabled(adapterRef.debug);
      logInfo("runtime", { event: "config-reloaded", limit: adapterRef.modelContextLimit ?? null });
    } catch (e) {
      logWarn("runtime", { event: "config-reload-failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  // #459: tools (compress/decompress/status/search) run stateFor WITHOUT the
  // context event's live tail, while the nudge that told the model which refs
  // to cite was rendered WITH it — on fork hosts getBranch() lags the live
  // tail, so every model-built range touching the tail died with "does not
  // exist" (#452 loop). Cache each session's last context-fire live tail and
  // replay it on the tool path so both views agree. The map is process-local:
  // a resumed session starts with an empty cache and the first context fire
  // repopulates it before any tool can run.
  const lastLiveBySession = new Map<string, AgentMessage[]>();

  // Issue #561: per-session incremental projection cache — pi hosts rebuild the
  // entries array (fresh objects) every turn from an append-only jsonl, so the
  // 24k-entry projection is prefix-stable and only the new tail needs work.
  const projectionCaches = new Map<string, EntryProjectionCache>();

  async function stateFor(ctx: ExtensionContext, liveMessages?: AgentMessage[]) {
    const sm = ctx.sessionManager;
    const sessionFile = sm.getSessionFile() ?? undefined;
    const sessionId = sm.getSessionId();
    const piHost = isPiHost(sm);
    if (!piHost && liveMessages && liveMessages.length > 0) lastLiveBySession.set(sessionId, [...liveMessages]);
    const live = piHost ? undefined : (liveMessages ?? lastLiveBySession.get(sessionId));
    let state = await store.load(sessionFile, sessionId);
    const entries = readContextEntries(sm);
    // Issue #299 (ranxianglei/billion-context-pi#299): pi's importFromJsonl
    // copies only the .jsonl, so the `${sessionFile}.acp.json` sidecar never
    // travels with an imported session and compression state silently resets
    // (the adapter then re-compresses already-compressed content). Last resort
    // after the sidecar and parent-session inheritance both miss: replay the
    // successful compress calls recorded in the session log itself. Uses only
    // persisted entries — the omp live tail is not part of history yet.
    if (sessionFile && state.blocks.length === 0 && hasCompressHistory(entries)) {
      const rebuilt = rebuildStateFromLog({ entries, state, config: configFor(ctx), core });
      if (rebuilt.report.blocks > 0) {
        state = rebuilt.state;
        await store.save(state, sessionFile, sessionId);
        logInfo("state", {
          sid: sessionId,
          event: "state-rebuilt",
          blocks: rebuilt.report.blocks,
          callsApplied: rebuilt.report.callsApplied,
          callsSkipped: rebuilt.report.callsSkipped,
        });
      }
    }
    // omp fires the context event BEFORE the current user message is persisted
    // to the session branch (its agent-loop emits message_end only after
    // prepareProviderCall → transformContext), so getBranch() lags one message
    // behind and the current prompt would be dropped from the rebuilt context.
    // pi appends user messages to the session before the LLM call, so its
    // buildContextEntries() is always current. Merge event.messages (the exact
    // messages about to be sent, including the not-yet-persisted tail) with the
    // persisted branch records on the omp path only.
    if (!piHost && live && live.length > 0) {
      const origins = store.getLiveRefOrigins(sessionFile, sessionId);
      const merged = mergeLiveEntries(entries, live, state, origins);
      store.setLiveRefOrigins(sessionFile, sessionId, origins);
      const coreMessages = entriesToCoreMessages(merged);
      // #459: enforce byRaw ⊆ view-ids ∪ block-ids on the merged view too —
      // without it, stale live-* refs from a shrunken/rewound host view linger
      // in state and get cited into compress ranges (#452 cross-generation refs).
      pruneOrphanRefs(state, coreMessages);
      return { state, coreMessages, entries: merged };
    }
    let projection = projectionCaches.get(sessionId);
    if (!projection) { projection = new EntryProjectionCache(); projectionCaches.set(sessionId, projection); }
    const coreMessages = projection.project(entries);
    if (live === undefined) pruneOrphanRefs(state, coreMessages);
    return { state, coreMessages, entries };
  }

  async function save(state: CompressionState, ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    await store.save(state, sm.getSessionFile() ?? undefined, sm.getSessionId());
  }

  // Own-sidecar check (not cache/load) because load() may have already filled
  // the slot via implicit parentSession-header inheritance — that implicit
  // state is replaceable by an explicit derivation, but real self-compressed
  // blocks are not.
  function ownSidecarHasBlocks(sessionFile: string): boolean {
    try {
      const parsed = JSON.parse(readFileSync(`${sessionFile}.acp.json`, "utf8")) as { blocks?: unknown };
      return Array.isArray(parsed.blocks) && parsed.blocks.length > 0;
    } catch {
      return false;
    }
  }

  async function deriveChild(child: SessionRef, parent: SessionRef): Promise<boolean> {
    if (!child.sessionFile) return false;
    if (ownSidecarHasBlocks(child.sessionFile)) return false;
    // Materialize the child cache slot (also surfaces any implicit header
    // inheritance or a marker persisted by an earlier process) so the marker
    // below has a slot to attach to and save() persists it.
    await store.load(child.sessionFile, child.sessionId);
    if (store.getDerivedFrom(child.sessionFile, child.sessionId)) return false;
    const parentState = await store.load(parent.sessionFile, parent.sessionId);
    if (parentState.blocks.length === 0) return false;
    const derived = deriveChildState(parentState);
    store.setDerivedFrom(child.sessionFile, child.sessionId, { parentSessionId: parent.sessionId, derivedAt: Date.now() });
    await store.save(derived, child.sessionFile, child.sessionId);
    logInfo("state", { sid: child.sessionId, event: "child-state-derived", parentSid: parent.sessionId, blocks: derived.blocks.length });
    return true;
  }

  let refused = false;
  let refusalMessage: string | null = null;
  let delegateStoodDown = false;
  return { core, store, get refused() { return refused; }, set refused(v: boolean) { refused = v; }, get refusalMessage() { return refusalMessage; }, set refusalMessage(v: string | null) { refusalMessage = v; }, get delegateStoodDown() { return delegateStoodDown; }, set delegateStoodDown(v: boolean) { delegateStoodDown = v; }, get adapter() { return adapterRef; }, setAdapter: (a) => { adapterRef = a; }, get prompts() { return promptsRef; }, setPrompts: (p) => { promptsRef = p; }, markNudgeShown, nudgeShownFor, nudgeShownTokensFor, clearNudgeTracking, clearNudgeTokenStamps, noteCompressOutcomes, compressRetryCappedFor, clearCompressRetryTracking, liveContextLimit, configFor, reasoningDropFor, reloadConfig, stateFor, save, deriveChildState: deriveChild, acquireLock, overflowFor, overflowDrop, noteSentViewCount, peekSentViewCount, dropSentViewCount, noteDeadCompress, clearDeadCompress, throttleFor, throttleDrop , noteTokenScale, dropTokenScale, noteHostUsage, dropHostUsageSamples, noteSizeDivergence, dropSizeDivergence, noteTerminalEscape, dropTerminalEscape, noteTruncationSkipped, dropTruncationSkipped, stripImagesFor };}
