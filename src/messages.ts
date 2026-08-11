import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CoreMessage } from "acp-kernel";

type AgentMessage = SessionMessageEntry["message"];

type AnyMessage = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  command?: string;
  output?: unknown;
  summary?: string;
};

const REF_TAG = new RegExp("^(?:\x3cacp\\s[^>]*\x3em\\d{5}\x3c/acp\x3e|\\[m\\d{1,5}\\])\\s?\\n?");

export function entriesToCoreMessages(entries: SessionEntry[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      // custom_message participates in LLM context per Pi native semantics
      // (session-manager.d.ts) — project it as a user message.
      if (entry.type === "custom_message") {
        const text = extractText(entry.content);
        if (text.length > 0) {
          out.push({ id: entry.id, role: "user", contentType: "text", text });
        }
      }
      continue;
    }
    const cores = projectMessage(entry.message, entry.id);
    out.push(...cores);
  }
  return out;
}

function projectMessage(message: AgentMessage, id: string): CoreMessage[] {
  const msg = message as AnyMessage;
  const role = msg.role;
  if (role === "user") {
    return [{ id, role: "user", contentType: "text", text: extractText(msg.content) }];
  }
  if (role === "toolResult") {
    return [{
      id,
      role: "tool",
      contentType: "tool-result",
      toolName: msg.toolName,
      toolCallId: msg.toolCallId,
      text: extractText(msg.content),
    }];
  }
  if (role === "assistant") {
    const calls = allToolCalls(msg.content);
    if (calls.length > 0) {
      const textParts = extractText(msg.content);
      if (calls.length === 1) {
        const call = calls[0]!;
        const argStr = stringifyArgs(call.arguments);
        const text = argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts;
        return [{ id, role: "assistant", contentType: "tool-call", toolName: call.name, toolCallId: call.id, text }];
      }
      return calls.map((call, i) => {
        const argStr = stringifyArgs(call.arguments);
        // First split carries the assistant's explanatory text (like the
        // single-call branch); the rest carry only their arguments.
        const text = i === 0 && argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts;
        return {
          id: `${id}#${call.id}`,
          role: "assistant" as const,
          contentType: "tool-call" as const,
          toolName: call.name,
          toolCallId: call.id,
          text,
        };
      });
    }
    const text = extractText(msg.content);
    // Drop thinking-only turns: empty assistant text makes OpenAI-compatible
    // providers (e.g. GLM) return 400 (no body), which Pi misreads as overflow.
    if (!text.trim()) return [];
    return [{ id, role: "assistant", contentType: "text", text }];
  }
  const customText = extractText(msg.content) || fallbackText(msg);
  return customText.length > 0
    ? [{ id, role: "user", contentType: "text", text: customText }]
    : [];
}

function fallbackText(msg: AnyMessage): string {
  const parts: string[] = [];
  if (msg.command) parts.push(`$ ${msg.command}`);
  const out = extractText(msg.output);
  if (out) parts.push(out);
  if (msg.summary) parts.push(msg.summary);
  return parts.join("\n").trim();
}

function stringifyArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  return safeStringify(args);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.replace(REF_TAG, "");
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text.replace(REF_TAG, ""));
    }
  }
  return parts.join("\n");
}

function allToolCalls(content: unknown): { name: string; id: string; arguments?: unknown }[] {
  if (!Array.isArray(content)) return [];
  const calls: { name: string; id: string; arguments?: unknown }[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
    if (b.type === "toolCall" && b.name) calls.push({ name: b.name, id: b.id ?? "", arguments: b.arguments });
  }
  return calls;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function coreOutToAgentMessages(
  coreOut: CoreMessage[],
  originalById: Map<string, AgentMessage>,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  const emittedSplit = new Set<string>();

  for (const core of coreOut) {
    if (core.id.startsWith("acp_summary_")) {
      // Kernel replaced compressed messages with a system-role summary. Pi's
      // convertToLlm drops unknown roles (system is not one of them), so
      // surface it as a user message — otherwise compression silently deletes
      // the knowledge from the model's view.
      out.push({
        role: "user",
        content: [{ type: "text", text: core.text ?? "" }],
        timestamp: Date.now(),
      } as AgentMessage);
      continue;
    }

    const hashIdx = core.id.indexOf("#");
    if (hashIdx < 0) {
      const original = originalById.get(core.id);
      if (original) out.push(patchRefTag(original, core));
      continue;
    }

    const baseId = core.id.substring(0, hashIdx);
    if (emittedSplit.has(baseId)) continue;
    emittedSplit.add(baseId);

    const original = originalById.get(baseId);
    if (!original) continue;

    const survivingCallIds = new Set(
      coreOut
        .filter((c) => c.id.startsWith(`${baseId}#`) && !c.id.startsWith("acp_summary_"))
        .map((c) => c.toolCallId)
        .filter((id): id is string => !!id),
    );

    out.push(reconstructToolCallMessage(original, core, survivingCallIds));
  }

  return out;
}

function reconstructToolCallMessage(
  original: AgentMessage,
  firstCore: CoreMessage,
  survivingCallIds: Set<string>,
): AgentMessage {
  const base = original as AnyMessage;
  const match = firstCore.text ? firstCore.text.match(REF_TAG) : null;
  const tag = match ? match[0] : null;

  if (base.role === "assistant" || !tag) {
    const rawBlocks2 = asBlocks(base.content);
    const filtered2 = rawBlocks2.filter((block) => {
      const b = block as { type?: string; id?: string };
      if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
      return true;
    });
    const peeled2 = peelRefTagBlocks(filtered2);
    return { ...(original as object), content: peeled2 } as AgentMessage;
  }

  const rawBlocks = asBlocks(base.content);

  const filtered = rawBlocks.filter((block) => {
    const b = block as { type?: string; id?: string };
    if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
    return true;
  });

  const peeled = peelRefTagBlocks(filtered);
  const lastTextIdx = [...peeled].reverse().findIndex((b) => (b as { type?: string }).type === "text");
  if (lastTextIdx >= 0) {
    const idx = peeled.length - 1 - lastTextIdx;
    const lastBlock = peeled[idx] as { type: string; text: string };
    const baseText = lastBlock.text ?? "";
    peeled[idx] = { ...lastBlock, text: baseText.length > 0 ? `${baseText}\n\n${tag}` : tag };
    return { ...(original as object), content: peeled } as AgentMessage;
  }
  return { ...(original as object), content: [{ type: "text", text: tag }, ...peeled] } as AgentMessage;
}

function patchRefTag(original: AgentMessage, core: CoreMessage): AgentMessage {
  const match = core.text ? core.text.match(REF_TAG) : null;
  const tag = match ? match[0] : null;
  if (!tag) return original;
  const base = original as AnyMessage;
  // Skip tag injection for assistant messages — the model sees tags on its own
  // previous responses and echoes them, causing visible tag fragments in the terminal.
  // The model can still reference assistant messages by inferring refs from context.
  if (base.role === "assistant") return original;
  // Honor kernel body mutations (emergency truncation of large tool-results,
  // future rewrites): if core.text's body differs from the original text,
  // rebuild from the kernel body — otherwise truncation never reaches the model.
  const tagCore = tag.replace(/\s+$/, "");
  let bodyStart = tagCore.length;
  if (core.text && core.text.charAt(bodyStart) === "\n") bodyStart += 1;
  const coreBody = core.text ? core.text.slice(bodyStart) : "";
  const originalBody = extractText(base.content);
  const trimEnd = (s: string): string => s.replace(/\s+$/, "");
  if (coreBody && trimEnd(coreBody) !== trimEnd(originalBody)) {
    return rebuildBodyFromCore(original, coreBody, tag);
  }
  const rawBlocks = asBlocks(base.content);
  const peeled = peelRefTagBlocks(rawBlocks);

  const newBlocks = [...peeled];
  let injected = false;
  for (let i = newBlocks.length - 1; i >= 0; i--) {
    const b = newBlocks[i] as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      const baseText = b.text.replace(/\n*$/, "");
      newBlocks[i] = { ...b, text: baseText.length > 0 ? `${baseText}\n\n${tag}` : tag };
      injected = true;
      break;
    }
  }
  if (injected) {
    return { ...(original as object), content: newBlocks } as AgentMessage;
  }

  return {
    ...(original as object),
    content: [...peeled, { type: "text" as const, text: tag }],
  } as AgentMessage;
}

/** Normalize a message's `content` field (block array | string | absent)
 *  into a block array. Shared by all ref-tag patch paths. */
function asBlocks(content: unknown): Array<{ type?: string; text?: string; id?: string }> {
  return Array.isArray(content)
    ? (content as Array<{ type?: string; text?: string; id?: string }>)
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
}

function rebuildBodyFromCore(
  original: AgentMessage,
  coreBody: string,
  tag: string,
): AgentMessage {
  const base = original as AnyMessage;
  const text = `${coreBody.replace(/\s+$/, "")}\n\n${tag}`;
  if (typeof base.content === "string") {
    return { ...(original as object), content: text } as AgentMessage;
  }
  if (Array.isArray(base.content)) {
    const nonText = base.content.filter((b) => (b as { type?: string }).type !== "text");
    return {
      ...(original as object),
      content: [...nonText, { type: "text" as const, text }],
    } as AgentMessage;
  }
  return { ...(original as object), content: [{ type: "text" as const, text }] } as AgentMessage;
}
function peelRefTagBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      const stripped = b.text.replace(REF_TAG, "");
      if (stripped.length > 0) out.push({ ...b, text: stripped });
    } else {
      out.push(block);
    }
  }
  return out;
}
