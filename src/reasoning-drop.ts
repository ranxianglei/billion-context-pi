import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { logWarn } from "./log.js";

type AgentMessage = SessionMessageEntry["message"];

/** [#336] Config for dropping oversized reasoning (thinking) parts from
 *  historical `compress` tool calls — exact alignment with opencode-acp #377.
 *  `compress` calls are hard-exempt from compression (their tool results are
 *  the anchors that keep block summaries addressable), so their thinking
 *  rides along every request as an unreclaimable context floor. This pass
 *  removes `thinking` parts at request time (persisted history is never
 *  modified) from closed-round compress messages whose total reasoning length
 *  exceeds `threshold`. A round is closed on ROUND EVIDENCE, not on user
 *  messages: the compress tool result must have arrived and at least one
 *  message must exist after it. The in-flight round (result still missing or
 *  still the last message) is never touched [#348]. */
export interface CompressReasoningConfig {
  /** Master switch. Default: true. `drop: false` disables the pass entirely
   *  (kill-switch; also the recipe for providers whose thinking items are
   *  opaque and must round-trip unmodified, e.g. set it per-provider under
   *  `compress.providers.<name>`). */
  drop?: boolean;
  /** Single-thinking size gate (chars): a closed-turn compress message's
   *  total reasoning length (summed across parts of that message) must
   *  STRICTLY EXCEED this to be dropped. Small thinkings are kept; lengths
   *  are NOT accumulated across messages. Default: 2048. `0` drops any
   *  non-empty reasoning (only zero-length reasoning survives). */
  threshold?: number;
}

export const DEFAULT_COMPRESS_REASONING: Required<CompressReasoningConfig> = { drop: true, threshold: 2048 };

export function resolveReasoningDrop(cfg?: CompressReasoningConfig): Required<CompressReasoningConfig> {
  let threshold = DEFAULT_COMPRESS_REASONING.threshold;
  if (cfg?.threshold !== undefined) {
    const t = cfg.threshold;
    if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
      threshold = Math.floor(t);
    } else {
      logWarn("config", { event: "compress-reasoning-invalid", field: "threshold", value: t, fallback: DEFAULT_COMPRESS_REASONING.threshold });
    }
  }
  return { drop: cfg?.drop !== false, threshold };
}

function isThinking(part: unknown): part is { type: "thinking"; thinking: string } {
  const p = part as { type?: string; thinking?: unknown };
  return p?.type === "thinking" && typeof p.thinking === "string";
}

function hasCompressCall(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((p) => {
    const b = p as { type?: string; name?: string };
    return b?.type === "toolCall" && b.name === "compress";
  });
}

function compressCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => {
      const b = p as { type?: string; name?: string };
      return b?.type === "toolCall" && b.name === "compress";
    })
    .map((p) => (p as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
}

/** toolCallId -> index of the message carrying its tool result. Pi gives
 *  tool results their own `toolResult` role with a top-level `toolCallId`. */
function resultIndexByCallId(messages: AgentMessage[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: string; toolCallId?: unknown };
    if (msg?.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
    if (!map.has(msg.toolCallId)) map.set(msg.toolCallId, i);
  }
  return map;
}

function reasoningLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, p) => (isThinking(p) ? n + p.thinking.length : n), 0);
}

export function countThinkingChars(messages: AgentMessage[]): number {
  return messages.reduce((n, m) => n + reasoningLength((m as { content?: unknown }).content), 0);
}

/** Request-time pass aligned with opencode-acp #377: remove `thinking` parts
 *  from a message only when ALL gates hold —
 *  1. closed round [#348]: EVERY `compress` toolCall in the message has its
 *     tool-result message (role `toolResult`, matching `toolCallId`) at a
 *     later index, and at least one message exists after that result (the
 *     round has demonstrably moved on). A compress call without a result, or
 *     whose result is still the last message, is in flight and never touched
 *     — no user message is required, so long agentic sessions do close
 *     rounds; a synthetic nudge pushed later cannot retroactively close one;
 *  2. selector: the message carries a `toolCall` part with name "compress"
 *     (only compress; other protected tools would need their own explicit
 *     config);
 *  3. size: the message's total reasoning length strictly exceeds
 *     `threshold` chars (summed across parts, never across messages).
 *  Pure: never mutates the input; idempotent; fail-safe (any error returns
 *  the input unchanged). */
export function dropCompressReasoning(messages: AgentMessage[], cfg?: CompressReasoningConfig): AgentMessage[] {
  const { drop, threshold } = resolveReasoningDrop(cfg);
  if (!drop || messages.length === 0) return messages;
  try {
    const last = messages.length - 1;
    const resultAt = resultIndexByCallId(messages);
    let changed = false;
    const out = messages.slice();
    for (let i = 0; i <= last; i++) {
      const msg = messages[i] as { role?: string; content?: unknown };
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      if (!hasCompressCall(msg.content)) continue;
      const ids = compressCallIds(msg.content);
      const closed = ids.length > 0 && ids.every((id) => {
        const ri = resultAt.get(id);
        return ri !== undefined && ri > i && ri < last;
      });
      if (!closed) continue;
      if (reasoningLength(msg.content) <= threshold) continue;
      out[i] = {
        ...(msg as object),
        content: (msg.content as unknown[]).filter((p) => !isThinking(p)),
      } as AgentMessage;
      changed = true;
    }
    return changed ? (out as AgentMessage[]) : messages;
  } catch {
    return messages;
  }
}
