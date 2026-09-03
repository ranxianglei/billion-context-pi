import type { ExtensionAPI, ToolResultEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { debug, logWarn } from "./log.js";

// Generic same-arguments tool-call loop breaker, complementary to the
// compress-specific breaker in the kernel nudge path: small local models can
// get stuck emitting the exact same call forever (e.g. rewriting the same
// debug script), so after THRESHOLD identical successes the next identical
// call is blocked with an actionable reason. MAX_CONSECUTIVE_BLOCKS ignored
// blocks terminate the turn — measured on qwen3.8-27b: it ignores the reason
// and loops verbatim, so termination is the only token-burn stopper.
/** Identical successes allowed before blocking (block #THRESHOLD+1). */
const THRESHOLD = 3;
/** Consecutive blocks after which the turn is terminated. */
const MAX_CONSECUTIVE_BLOCKS = 5;
/** Gap larger than this starts a fresh streak (new round, not a loop). */
const STALE_MS = 5 * 60 * 1000;
/** Last-result excerpt carried in the block reason. */
const RESULT_EXCERPT_MAX = 400;
/** Excluded: the compress breaker manages its own retry semantics. */
const EXCLUDED_TOOLS = new Set(["compress"]);

export interface LoopState {
  key: string;
  streak: number;
  lastTime: number;
  lastResult: string;
}

export function freshLoopState(): LoopState {
  return { key: "", streak: 0, lastTime: 0, lastResult: "" };
}

export type ToolCallDecision =
  | { block: true; terminate: boolean; reason: string }
  | undefined;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = canonicalize(obj[key]);
    return sorted;
  }
  return value;
}

function callKey(toolName: string, input: unknown): string {
  return toolName + "::" + JSON.stringify(canonicalize(input));
}

function excerpt(text: string | undefined): string {
  if (!text) return "(no output)";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > RESULT_EXCERPT_MAX
    ? clean.slice(0, RESULT_EXCERPT_MAX) + "…"
    : clean;
}

function resultText(content: ToolResultEvent["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => (c.type === "text" ? (c as { text?: string }).text ?? "" : ""))
    .join("\n");
}

export function blockReason(
  toolName: string,
  blockedCount: number,
  lastResult: string,
  terminate: boolean,
): string {
  return (
    `BLOCKED: This exact tool call (${toolName}) has already succeeded ` +
    `${THRESHOLD} consecutive times with identical arguments, and your retry ` +
    `attempts have been blocked ${blockedCount} time(s). ` +
    `Executing it again is pointless.\n\n` +
    `Last result was:\n"${lastResult}"\n\n` +
    `You are stuck in a repetition loop. STOP repeating this call. Instead:\n` +
    `1. Analyze why the previous results did not advance your goal.\n` +
    `2. Choose a DIFFERENT action (e.g. run the script instead of rewriting it, ` +
    `inspect different state, or report the result to the user).\n` +
    `3. If repetition is truly required, change the arguments.\n` +
    (terminate
      ? `4. This turn is now TERMINATED because the loop did not stop after ` +
        `${blockedCount} blocks. When a new message arrives, reflect on what ` +
        `differs this time before calling any tool.\n`
      : "")
  );
}

/** Advance the streak for an incoming call; returns the block decision. */
export function evaluateCall(
  state: LoopState,
  toolName: string,
  input: unknown,
  now: number,
): ToolCallDecision {
  if (EXCLUDED_TOOLS.has(toolName)) return undefined;
  const key = callKey(toolName, input);
  if (key !== state.key || now - state.lastTime > STALE_MS) {
    state.key = key;
    state.streak = 1;
    state.lastTime = now;
    state.lastResult = "";
    return undefined;
  }
  state.streak += 1;
  state.lastTime = now;
  if (state.streak <= THRESHOLD) return undefined;
  const blockedCount = state.streak - THRESHOLD;
  const terminate = blockedCount >= MAX_CONSECUTIVE_BLOCKS;
  return {
    block: true,
    terminate,
    reason: blockReason(toolName, blockedCount, state.lastResult || "(no output)", terminate),
  };
}

/** Track the latest successful result for the current streak key. */
export function noteResult(
  state: LoopState,
  toolName: string,
  input: unknown,
  content: ToolResultEvent["content"],
  isError: boolean,
): void {
  if (EXCLUDED_TOOLS.has(toolName)) return;
  const key = callKey(toolName, input);
  if (key === state.key && !isError) state.lastResult = excerpt(resultText(content));
}

export function wireToolLoopGuard(pi: ExtensionAPI): void {
  const state = freshLoopState();
  pi.on("tool_result", (event) => {
    noteResult(state, event.toolName, event.input, event.content, event.isError);
  });
  pi.on("tool_call", (event) => {
    if (!isToolCallEvent(event)) return;
    const decision = evaluateCall(state, event.toolName, event.input, Date.now());
    if (!decision) return;
    debug.event("tool-loop-guard", { tool: event.toolName, terminate: decision.terminate });
    logWarn("tool-loop-guard", { tool: event.toolName, terminate: decision.terminate });
    return { block: true, terminate: decision.terminate, reason: decision.reason };
  });
}

// The tool_call overload carries input; narrow without importing runtime types.
function isToolCallEvent(event: unknown): event is ToolCallEvent {
  return typeof event === "object" && event !== null && "toolName" in event;
}
