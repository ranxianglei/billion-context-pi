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

// Bounded, payload-free diagnostic for a "no tail recovered" verdict (#559): the
// conservative contract is right, but it made undetected drops invisible (only the
// ABSENCE of an appended line). These fields say WHERE the positional walk broke and
// WHY, in one read. Computed only on a genuine miss, never on the aligned no-op.
export interface LiveOnlyTailMiss {
  persisted: number;      // message+custom_message entry count
  live: number;           // live array length
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
  /** Set only on a genuine miss (mid-sequence divergence or over-cap tail); null on
   *  the happy aligned/no-op path so ordinary turns emit nothing. */
  miss: LiveOnlyTailMiss | null;
}

function snip(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? flat.slice(0, 24) + "…" : flat;
}

function missDiag(persisted: Record<string, unknown>[], live: AgentMessage[], prefix: number): LiveOnlyTailMiss {
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

  return { persisted: pLen, live: lLen, prefix, suffix, gapPersisted, gapLive, atRole, atCustom, atTool, sameSig, text };
}

/** Messages a host put in the live array WITHOUT writing a session entry. pi-web's
 *  "Generate title" copies session state into a fresh Agent and appends its
 *  instruction to `event.messages` only; on a Pi host ACP rebuilds the request from
 *  persisted entries alone (src/runtime.ts stateFor), so those messages are dropped
 *  and the model replies to nothing (#471). Returns the trailing live-only messages
 *  to re-append after the rebuild (`tail`), or a null tail when the live array is not
 *  a clean structural extension of the persisted branch — then the caller leaves
 *  behaviour unchanged and logs `miss` (a #559 diagnostic) unless the arrays simply
 *  align with nothing to add. Recognised shapes: (1) new trailing message(s); (2) a
 *  text suffix appended INTO the final user message (returned as one fresh user msg). */
export function liveOnlyTail(entries: SessionEntry[], live: AgentMessage[]): LiveOnlyTailResult {
  const persisted = entries
    .filter((e) => e.type === "message" || e.type === "custom_message")
    .map((e) => entryAsLiveShape(e))
    .filter((shape): shape is Record<string, unknown> => shape !== undefined);

  const max = Math.min(persisted.length, live.length);
  let i = 0;
  while (i < max && weakMessageSig(persisted[i]) === weakMessageSig(live[i])) i++;

  if (i === max) {
    // Persisted is a prefix of live (or identical); the extension is the tail.
    const tail = live.slice(max);
    if (tail.length > 0 && tail.length <= MAX_LIVE_ONLY_TAIL) return { tail, miss: null };
    if (tail.length === 0) return { tail: null, miss: null }; // aligned, nothing to add: silent
    return { tail: null, miss: missDiag(persisted, live, i) }; // over-cap: surface it
  }

  // Diverged before the end: recover only the safe case — equal-length arrays, all
  // aligned except the final element, which is a user message whose text grew by a
  // strict suffix. Anything else (middle divergence, removals, rewrites) → miss.
  if (i === max - 1 && i === persisted.length - 1 && i === live.length - 1) {
    const liveMsg = live[i] as Record<string, unknown> | undefined;
    if (liveMsg && typeof liveMsg.role === "string" && liveMsg.role === "user") {
      const before = sigText((persisted[i] as Record<string, unknown> | undefined)?.content);
      const after = sigText(liveMsg.content);
      if (before && after && after.startsWith(before)) {
        const suffix = after.slice(before.length).trim();
        if (suffix.length > 0) {
          return { tail: [{ role: "user", content: [{ type: "text", text: suffix }], timestamp: Date.now() } as AgentMessage], miss: null };
        }
      }
    }
  }

  return { tail: null, miss: missDiag(persisted, live, i) };
}
