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

// An aborted/errored turn can persist a message with NO content blocks (content: []).
// Some hosts (pi-web's auto-name route) prune such messages from the context array
// before sending, while entryAsLiveShape keeps them verbatim — so a single dropped
// entry shifts persisted/live out of alignment by one forever and the prefix walk
// never reaches the extension. Dropping these empty shapes from BOTH sides before
// walking is symmetric (restores alignment whether or not the host pruned) and cannot
// mask a real divergence, since an empty message carries no text to differ on.
function isIgnorableEmpty(message: unknown): boolean {
  const content = (message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) return content.length === 0;
  if (typeof content === "string") return content.trim().length === 0;
  return false;
}

/** Messages a host put in the live array WITHOUT writing a session entry. pi-web's
 *  "Generate title" copies session state into a fresh Agent and appends its
 *  instruction to `event.messages` only; on a Pi host ACP rebuilds the request from
 *  persisted entries alone (src/runtime.ts stateFor), so those messages are dropped
 *  and the model replies to nothing (#471). Returns the trailing live-only messages
 *  to re-append after the rebuild, or null when the live array is not a clean
 *  structural extension of the persisted branch — then the caller leaves behaviour
 *  unchanged. Empty-content entries (aborted turns) are ignored on both sides so a
 *  host that prunes them stays aligned. Recognised shapes: (1) new trailing
 *  message(s); (2) a text suffix appended INTO the final user message (returned as
 *  one fresh user message). */
export function liveOnlyTail(entries: SessionEntry[], live: AgentMessage[]): AgentMessage[] | null {
  const persisted = entries
    .filter((e) => e.type === "message" || e.type === "custom_message")
    .map((e) => entryAsLiveShape(e))
    .filter((shape): shape is Record<string, unknown> => shape !== undefined)
    .filter((shape) => !isIgnorableEmpty(shape));

  const seq = live.filter((m) => !isIgnorableEmpty(m));

  const max = Math.min(persisted.length, seq.length);
  let i = 0;
  while (i < max && weakMessageSig(persisted[i]) === weakMessageSig(seq[i])) i++;

  if (i === max) {
    // Persisted is a prefix of live (or identical); the extension is the tail.
    const tail = seq.slice(max);
    return tail.length > 0 && tail.length <= MAX_LIVE_ONLY_TAIL ? tail : null;
  }

  // Diverged before the end: recover only the safe case — equal-length arrays, all
  // aligned except the final element, which is a user message whose text grew by a
  // strict suffix. Anything else (middle divergence, removals, rewrites) → null.
  if (i === max - 1 && i === persisted.length - 1 && i === seq.length - 1) {
    const liveMsg = seq[i] as Record<string, unknown> | undefined;
    if (liveMsg && typeof liveMsg.role === "string" && liveMsg.role === "user") {
      const before = sigText((persisted[i] as Record<string, unknown> | undefined)?.content);
      const after = sigText(liveMsg.content);
      if (before && after && after.startsWith(before)) {
        const suffix = after.slice(before.length).trim();
        if (suffix.length > 0) {
          return [{ role: "user", content: [{ type: "text", text: suffix }], timestamp: Date.now() } as AgentMessage];
        }
      }
    }
  }

  return null;
}
