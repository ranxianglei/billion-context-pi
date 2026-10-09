import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionMessageEntry["message"];

// Conservative cap: a healthy host appends one or two messages (pi-web auto-name
// appends exactly one); a large count means the structural model misfired, so we
// leave behaviour unchanged instead of dumping an unbounded tail onto the request.
const MAX_LIVE_ONLY_TAIL = 8;

// Raw content text WITHOUT ref-tag stripping: input messages (persisted entries
// and the live array) carry no tags here — ACP adds them in its output transform —
// so skipping stripRefTag keeps the signature regex-free and deterministic.
function sigText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

// Weak structural signature for walking the common prefix between persisted and
// live. Invariant to timestamps/tags; head+tail of the text stops a same-length
// mid-history rewrite reading as "aligned". A false no-match just leaves behaviour
// unchanged — we never append on uncertainty.
function weakMessageSig(message: unknown): string {
  const m = (message ?? {}) as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const customType = typeof m.customType === "string" ? m.customType : "";
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  const text = sigText(m.content);
  return [role, customType, toolCallId, String(text.length), text.slice(0, 32), text.length > 32 ? text.slice(-32) : ""].join("\u0000");
}

// Map a persisted entry onto the shape its counterpart carries in the live array.
// Pi projects every custom_message as role:"custom" (createCustomMessage), NOT as a
// user message — mapping it here is what keeps sessions that ever received a
// <background-task-notification> aligned (#471 trap 1). Kinds that never reach LLM
// context are absent from both views and need no mapping (→ undefined).
function entryAsLiveShape(entry: SessionEntry): Record<string, unknown> | undefined {
  if (entry.type === "message") {
    const msg = entry.message as unknown as Record<string, unknown>;
    return { role: msg.role, customType: msg.customType, toolCallId: msg.toolCallId, content: msg.content };
  }
  if (entry.type === "custom_message") {
    return { role: "custom", customType: entry.customType, content: entry.content };
  }
  return undefined;
}

// An aborted/errored turn can persist a message with NO content blocks
// (content: []). Some hosts (pi-web's auto-name route) prune such messages from
// the context array before sending, while entryAsLiveShape() keeps them verbatim —
// so a single dropped entry shifts persisted/live out of alignment by one forever
// and the prefix walk never reaches the extension (#565). Dropping these shapes
// from BOTH sides before walking is symmetric (restores alignment whether or not
// the host pruned them) and cannot mask a real divergence, since an empty message
// carries no text to differ on.
function isEmptyContent(content: unknown): boolean {
  if (Array.isArray(content)) return content.length === 0;
  if (typeof content === "string") return content.trim().length === 0;
  return false;
}
function isIgnorableEmpty(message: unknown): boolean {
  return isEmptyContent((message as Record<string, unknown> | undefined)?.content);
}
// Zero-allocation twin of isIgnorableEmpty(entryAsLiveShape(e)) for the cached
// count/canary walks: reads the entry's content field directly so cache
// bookkeeping stays allocation-free on 20k+ entry session files.
function entryIsIgnorableEmpty(entry: SessionEntry): boolean {
  if (entry.type === "message") return isEmptyContent((entry.message as unknown as Record<string, unknown>).content);
  if (entry.type === "custom_message") return isEmptyContent(entry.content);
  return false;
}

// Bounded, payload-free diagnostic for a "no tail recovered" verdict (#559): the
// conservative contract is right, but it made undetected drops invisible (only the
// ABSENCE of an appended line). These fields say WHERE the positional walk broke and
// WHY, in one read. Computed only on a genuine miss, never on the aligned no-op.
export interface LiveOnlyTailMiss {
  persisted: number;      // message+custom_message entries in the walked view
  live: number;           // live array length in the walked view
  droppedPersisted: number; // ignorable-empty entries dropped from the persisted side (#565)
  droppedLive: number;      // ignorable-empty messages dropped from the live side (#565)
  prefix: number;         // leading messages that aligned (front walk)
  suffix: number;         // trailing messages that aligned (back walk)
  gapPersisted: number;   // divergent middle-region size, persisted side
  gapLive: number;        // divergent middle-region size, live side
  atRole: string;         // role at the front divergence point ("-": none)
  atCustom: string;       // customType at the divergence point ("-": none)
  atTool: string;         // toolCallId at the divergence point ("-": none), truncated
  sameSig: boolean;       // weak signature still matched at the divergence
  text: string | null;    // truncated before/after text delta, when text differs
}

export interface LiveOnlyTailResult {
  /** Trailing live-only messages to re-append after the rebuild, or null. */
  tail: AgentMessage[] | null;
  /** Set only on a genuine miss (mid-sequence divergence or over-cap trailing
   *  extension); null on the happy aligned/no-op path so ordinary turns emit
   *  nothing. */
  miss: LiveOnlyTailMiss | null;
}

function snip(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? flat.slice(0, 24) + "…" : flat;
}

function missDiag(persisted: Record<string, unknown>[], live: AgentMessage[], prefix: number, droppedPersisted: number, droppedLive: number): LiveOnlyTailMiss {
  const pLen = persisted.length;
  const lLen = live.length;
  const span = Math.min(pLen, lLen);
  let suffix = 0;
  const backBudget = Math.max(0, span - prefix);
  while (suffix < backBudget && weakMessageSig(persisted[pLen - 1 - suffix]) === weakMessageSig(live[lLen - 1 - suffix])) suffix++;
  const gapPersisted = Math.max(0, pLen - prefix - suffix);
  const gapLive = Math.max(0, lLen - prefix - suffix);

  const pd = prefix < pLen ? persisted[prefix] : undefined;
  const ld = prefix < lLen ? live[prefix] : undefined;
  const pm = (pd ?? {}) as Record<string, unknown>;
  const lm = (ld ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" && v ? v : "");
  const atRole = str(lm.role) || str(pm.role) || "-";
  const atCustom = str(lm.customType) || str(pm.customType) || "-";
  const rawTool = str(lm.toolCallId) || str(pm.toolCallId);
  const atTool = rawTool ? (rawTool.length > 16 ? rawTool.slice(0, 16) + "…" : rawTool) : "-";
  const sameSig = pd !== undefined && ld !== undefined && weakMessageSig(pd) === weakMessageSig(ld);

  let text: string | null = null;
  if (pd !== undefined && ld !== undefined) {
    const before = sigText(pm.content);
    const after = sigText(lm.content);
    if (before !== after) {
      text = `"${snip(before)}" -> "${snip(after)}" start=${after.startsWith(before)} end=${after.endsWith(before)}`;
    }
  }

  return { persisted: pLen, live: lLen, droppedPersisted, droppedLive, prefix, suffix, gapPersisted, gapLive, atRole, atCustom, atTool, sameSig, text };
}

/** Messages a host put in the live array WITHOUT writing a session entry. pi-web's
 *  "Generate title" copies session state into a fresh Agent and appends its
 *  instruction to `event.messages` only; on a Pi host ACP rebuilds the request from
 *  persisted entries alone (src/runtime.ts stateFor), so those messages are dropped
 *  and the model replies to nothing (#471). Returns the trailing live-only messages
 *  to re-append after the rebuild (`tail`), or a null tail when the live array is not
 *  a clean structural extension of the persisted branch — then the caller leaves
 *  behaviour unchanged and logs `miss` (a #559 diagnostic) unless the arrays simply
 *  align with nothing to add. Empty-content entries (aborted turns) are ignored on
 *  both sides so a host that prunes them stays aligned (#565). Recognised shapes:
 *  (1) new trailing message(s); (2) a text suffix appended INTO the final user
 *  message (returned as one fresh user msg). */
type PersistedShape = Record<string, unknown>;

// Persisted entries projected to their live-array shape, dropping kinds that never
// reach LLM context and (#565) ignorable-empty messages; reports how many empties
// were dropped so a miss line can show whether normalization fired.
function projectPersisted(entries: SessionEntry[]): { shapes: PersistedShape[]; dropped: number } {
  const shapes: PersistedShape[] = [];
  let dropped = 0;
  for (const e of entries) {
    const shape = entryAsLiveShape(e);
    if (shape === undefined) continue;
    if (isIgnorableEmpty(shape)) {
      dropped++;
      continue;
    }
    shapes.push(shape);
  }
  return { shapes, dropped };
}

function countPersisted(entries: SessionEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if ((e.type === "message" || e.type === "custom_message") && !entryIsIgnorableEmpty(e)) n++;
  }
  return n;
}

// Index of the n-th kept (non-empty message|custom_message) entry WITHOUT building
// the intermediate shape array — used by the cached path to sig one boundary
// entry in O(n) index walk with zero allocations.
function persistedAt(entries: SessionEntry[], n: number): SessionEntry | undefined {
  let i = 0;
  for (const e of entries) {
    if ((e.type === "message" || e.type === "custom_message") && !entryIsIgnorableEmpty(e)) {
      if (i === n) return e;
      i++;
    }
  }
  return undefined;
}

interface AlignmentResult extends LiveOnlyTailResult {
  /** True when the walk reached min(persisted, live) — persisted and live
   *  aligned on the whole common prefix. False = diverged mid-history. */
  alignedFully: boolean;
  /** Length of the proven-aligned prefix [0, alignedPrefix). In the suffix-
   *  recovery case this is i, NOT i+1: the final pair is the divergence point
   *  itself (persisted text vs suffixed live text) and must be re-walked next
   *  turn — storing i+1 would let the cached path skip it and drop the tail. */
  alignedPrefix: number;
}

function alignAndExtract(entries: SessionEntry[], live: AgentMessage[]): AlignmentResult {
  const { shapes: persisted, dropped: droppedPersisted } = projectPersisted(entries);
  const seq = live.filter((m) => !isIgnorableEmpty(m));
  const droppedLive = live.length - seq.length;

  const max = Math.min(persisted.length, seq.length);
  let i = 0;
  while (i < max && weakMessageSig(persisted[i]) === weakMessageSig(seq[i])) i++;

  if (i === max) {
    // Persisted is a prefix of live (or identical); the extension is the tail.
    const tail = seq.slice(max);
    if (tail.length > 0 && tail.length <= MAX_LIVE_ONLY_TAIL) return { tail, miss: null, alignedFully: true, alignedPrefix: max };
    if (tail.length === 0) return { tail: null, miss: null, alignedFully: true, alignedPrefix: max }; // aligned, nothing to add: silent
    return { tail: null, miss: missDiag(persisted, seq, i, droppedPersisted, droppedLive), alignedFully: true, alignedPrefix: max }; // over-cap: surface it
  }

  // Diverged before the end: recover only the safe case — equal-length arrays, all
  // aligned except the final element, which is a user message whose text grew by a
  // strict suffix. Anything else (middle divergence, removals, rewrites) → miss.
  if (i === max - 1 && i === persisted.length - 1 && i === seq.length - 1) {
    const liveMsg = seq[i] as Record<string, unknown> | undefined;
    if (liveMsg && typeof liveMsg.role === "string" && liveMsg.role === "user") {
      const before = sigText((persisted[i] as Record<string, unknown> | undefined)?.content);
      const after = sigText(liveMsg.content);
      if (before && after && after.startsWith(before)) {
        const suffix = after.slice(before.length).trim();
        if (suffix.length > 0) {
          return { tail: [{ role: "user", content: [{ type: "text", text: suffix }], timestamp: Date.now() } as AgentMessage], miss: null, alignedFully: true, alignedPrefix: i };
        }
      }
    }
  }

  return { tail: null, miss: missDiag(persisted, seq, i, droppedPersisted, droppedLive), alignedFully: false, alignedPrefix: i };
}

export function liveOnlyTail(entries: SessionEntry[], live: AgentMessage[]): LiveOnlyTailResult {
  return alignAndExtract(entries, live);
}

// Per-session cache for the alignment walk (issue #561): proving that 20k+
// persisted messages still align with the live array costs one full-text sig
// per pair, every turn, on a path that almost never changes its answer. The
// append-only argument: pi's session jsonl only grows (rewind = truncate =
// count drop → full rewalk), live positions below the persisted count map to
// those same session messages, so an alignment proven last turn for
// [0, alignedTo) carries over — re-verified with one canary sig at the last
// boundary, then only the NEW pairs are walked (a handful per turn). Counts and
// the canary run over KEPT (non-empty) entries only, so appending an empty
// aborted-turn entry leaves them unchanged and the proof carries over (#565).
interface TailCacheEntry {
  persistedCount: number;
  liveCount: number;
  alignedTo: number;
  lastPersistedSig: string | null;
}

const tailCache = new Map<string, TailCacheEntry>();

/** Cached variant of liveOnlyTail keyed by session id. Behaviourally identical
 *  (same tail/miss verdicts); only the prefix proof is memoized. Doubt always
 *  falls back to the full walk. */
export function liveOnlyTailCached(sid: string, entries: SessionEntry[], live: AgentMessage[]): LiveOnlyTailResult {
  const seq = live.filter((m) => !isIgnorableEmpty(m));
  const prev = tailCache.get(sid);
  const persistedCount = countPersisted(entries);
  if (
    prev &&
    prev.lastPersistedSig !== null &&
    persistedCount >= prev.persistedCount &&
    seq.length >= prev.liveCount &&
    seq.length - prev.liveCount <= MAX_LIVE_ONLY_TAIL * 4
  ) {
    const canaryEntry = persistedAt(entries, prev.persistedCount - 1);
    const canary = canaryEntry ? weakMessageSig(entryAsLiveShape(canaryEntry)) : null;
    if (canary === prev.lastPersistedSig) {
      // Prefix alignment [0, prev.alignedTo) carries over; one forward walk
      // checks only the new pairs [prev.alignedTo, min(persisted, live)).
      const max = Math.min(persistedCount, seq.length);
      let pIdx = 0;
      let aligned = true;
      for (const e of entries) {
        if (pIdx >= max) break;
        if ((e.type === "message" || e.type === "custom_message") && !entryIsIgnorableEmpty(e)) {
          if (pIdx >= prev.alignedTo && weakMessageSig(entryAsLiveShape(e)) !== weakMessageSig(seq[pIdx])) {
            aligned = false;
            break;
          }
          pIdx++;
        }
      }
      if (aligned) {
        const lastEntry = persistedAt(entries, persistedCount - 1);
        tailCache.set(sid, {
          persistedCount,
          liveCount: seq.length,
          alignedTo: max,
          lastPersistedSig: lastEntry ? weakMessageSig(entryAsLiveShape(lastEntry)) : null,
        });
        const tail = seq.slice(max);
        if (tail.length > 0 && tail.length <= MAX_LIVE_ONLY_TAIL) return { tail, miss: null };
        if (tail.length === 0) return { tail: null, miss: null };
        // Over-cap trailing extension: same verdict AND diagnostic as the full
        // walk (the shape list is built lazily — only misses pay for it).
        const { shapes: persisted, dropped } = projectPersisted(entries);
        return { tail: null, miss: missDiag(persisted, seq, max, dropped, live.length - seq.length) };
      }
      // New pairs diverged (host rewrote history past the boundary): fall
      // through to the full walk so the mid-history recovery logic runs.
    }
  }
  const result = alignAndExtract(entries, live);
  const lastEntry = persistedAt(entries, persistedCount - 1);
  tailCache.set(sid, {
    persistedCount,
    liveCount: seq.length,
    alignedTo: result.alignedPrefix,
    lastPersistedSig: lastEntry ? weakMessageSig(entryAsLiveShape(lastEntry)) : null,
  });
  return { tail: result.tail, miss: result.miss };
}

/** Drop a session's alignment cache (session_shutdown for memory hygiene). */
export function dropLiveOnlyTailCache(sid: string): void {
  tailCache.delete(sid);
}
