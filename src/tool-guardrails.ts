import {
  isToolCallEventType,
  type ExtensionAPI,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOL_BASH_TIMEOUT, DEFAULT_TOOL_OUTPUT_MAX_BYTES } from "./config.js";
import { debug, logInfo, logWarn } from "./log.js";
import type { AcpRuntime } from "./runtime.js";

// Vendored locally rather than imported: pi exports isBashToolResult, but omp's
// compat bundle does not, and a missing named export fails the whole module at
// load time under omp. The body is just e.toolName === "bash".
export type BashToolResultEvent = Extract<ToolResultEvent, { toolName: "bash" }>;
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
  return e.toolName === "bash";
}

type ContentPart = ToolResultEvent["content"][number];

export function resolveBashTimeout(
  input: { timeout?: number },
  defaultTimeout: number | undefined,
): number | undefined {
  if (input.timeout !== undefined) return undefined;
  const d = defaultTimeout ?? DEFAULT_TOOL_BASH_TIMEOUT;
  if (!Number.isFinite(d) || d <= 0) return undefined;
  return d;
}

export function capToolOutput(
  content: ToolResultEvent["content"],
  maxBytes: number | undefined,
  fullPath?: string,
): ToolResultEvent["content"] | undefined {
  const max = maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  if (!Number.isFinite(max) || max <= 0) return undefined;
  let combined = "";
  for (const c of content) {
    if (c.type === "text") combined += (combined ? "\n" : "") + (c as { text: string }).text;
  }
  if (combined === "") return undefined;
  const total = Buffer.byteLength(combined, "utf8");
  if (total <= max) return undefined;
  const head = keepHead(combined, max);
  const dropped = total - Buffer.byteLength(head, "utf8");
  // Replace the FIRST text block in place with the truncated content and drop
  // the remaining text blocks — non-text parts keep their original order.
  const replacement = { type: "text", text: head + buildCapNotice(dropped, max, fullPath) } as ContentPart;
  const out: ContentPart[] = [];
  let textPlaced = false;
  for (const c of content) {
    if (c.type === "text") {
      if (!textPlaced) {
        out.push(replacement);
        textPlaced = true;
      }
    } else {
      out.push(c);
    }
  }
  return out;
}

const TIMEOUT_RE = /Command timed out after (\d+) seconds/;

export function detectBashTimeout(content: ToolResultEvent["content"]): number | undefined {
  for (const c of content) {
    if (c.type !== "text") continue;
    const m = (c as { text: string }).text.match(TIMEOUT_RE);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export function appendTimeoutNotice(
  content: ToolResultEvent["content"],
  secs: number,
): ToolResultEvent["content"] {
  const notice = buildTimeoutNotice(secs);
  const next = [...content];
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i];
    if (part && part.type === "text") {
      next[i] = { type: "text", text: (part as { text: string }).text + notice } as ContentPart;
      return next;
    }
  }
  next.push({ type: "text", text: notice } as ContentPart);
  return next;
}

function keepHead(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end--;
  }
  let head = buf.subarray(0, end).toString("utf8");
  const nl = head.lastIndexOf("\n");
  if (nl >= Math.floor(maxBytes / 2)) head = head.slice(0, nl);
  return head;
}

function buildCapNotice(dropped: number, maxBytes: number, fullPath?: string): string {
  const where = fullPath
    ? `Full output saved to: ${fullPath} — read it to see everything.`
    : "To see more, narrow the query or redirect output to a file and read the relevant slice.";
  return `\n\n[ACP guardrail: output capped at ${formatBytes(maxBytes)} (~${formatBytes(dropped)} dropped). ${where}]`;
}

function buildTimeoutNotice(secs: number): string {
  const suggested = Math.min(Math.max(Math.ceil(secs * 2), 120), 3600);
  return `\n\n[ACP guardrail: command killed after ${secs}s. To give it more time, re-run the bash tool with a larger \`timeout\` argument (e.g. \`"timeout": ${suggested}\`).]`;
}

function formatBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

export function wireToolGuardrails(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const t = resolveBashTimeout(event.input, runtime.adapter.toolBashDefaultTimeout);
    if (t !== undefined) {
      event.input.timeout = t;
      debug.event("guardrail-bash-timeout", { applied: t });
    }
  });

  pi.on("tool_result", (event) => {
    const isBash = isBashToolResult(event);
    const fullPath = isBash ? event.details?.fullOutputPath : undefined;
    const timeoutSecs =
      isBash && event.isError ? detectBashTimeout(event.content) : undefined;

    let modified: ToolResultEvent["content"] | undefined;
    const max = runtime.adapter.toolOutputMaxBytes;
    if (max !== undefined && max > 0) {
      const next = capToolOutput(event.content, max, fullPath);
      if (next) {
        modified = next;
        debug.event("guardrail-output-cap", { max, hadPath: !!fullPath });
        logWarn("guardrail", { event: "output-cap", max, hadPath: !!fullPath });
      }
    }

    if (timeoutSecs !== undefined) {
      modified = appendTimeoutNotice(modified ?? event.content, timeoutSecs);
      debug.event("guardrail-bash-timeout-notice", { secs: timeoutSecs });
      logInfo("guardrail", { event: "bash-timeout-notice", secs: timeoutSecs });
    }

    if (modified) return { content: modified };
  });
}
