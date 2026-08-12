import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config, CoreMessage, CompressionState, NudgeDecision, CompressibleRange } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { debug, logInfo, logWarn } from "./log.js";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 3000;
const MAX_SLICE_CHARS = 150_000;
const MAX_MSG_CHARS = 4000;

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Model id configured via /acp-config, stored in ~/.<CONFIG_DIR_NAME>/acp.json as `provider:modelId`. */
export function readCompressModel(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), CONFIG_DIR_NAME, "acp.json"), "utf8")) as Record<string, unknown>;
    return typeof cfg.compressModel === "string" && cfg.compressModel.length > 0 ? cfg.compressModel : null;
  } catch {
    return null;
  }
}

/** Resolve the model to use for auto-compress: explicit compressModel wins,
 *  otherwise fall back to the current session model (so auto-compress works
 *  without any acp.json configuration). Returns null when neither is usable. */
export function resolveCompressModel<T extends { provider: string; id: string }>(
  registry: { find(provider: string, modelId: string): T | undefined },
  currentModel: T | undefined,
  configured: string | null,
): { model: T; label: string } | null {
  if (configured) {
    const sep = configured.indexOf(":");
    const provider = sep > 0 ? configured.slice(0, sep) : "openai";
    const modelId = sep > 0 ? configured.slice(sep + 1) : configured;
    const model = registry.find(provider, modelId);
    return model ? { model, label: configured } : null;
  }
  return currentModel ? { model: currentModel, label: `${currentModel.provider}:${currentModel.id}` } : null;
}

function refNum(ref: string): number {
  const m = /^m(\d+)$/.exec(ref);
  return m ? parseInt(m[1]!, 10) : -1;
}

export function sliceRange(messages: CoreMessage[], state: CompressionState, startRef: string, endRef: string): CoreMessage[] {
  const lo = refNum(startRef);
  const hi = refNum(endRef);
  return messages.filter((m) => {
    const ref = state.messageRefs.byRaw[m.id];
    if (!ref) return false;
    const n = refNum(ref);
    return n >= lo && n <= hi;
  });
}

/** Total text chars across the full span covered by all recommended ranges
 *  (including protected messages in between), matching how the kernel counts
 *  chars for minCompressRange — the model may extend a range across protected
 *  messages, so the guard must use the same widest-possible span. */
export function totalCompressibleChars(
  ranges: CompressibleRange[],
  messages: CoreMessage[],
  state: CompressionState,
): number {
  if (ranges.length === 0) return 0;
  const sorted = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef));
  return sliceRange(messages, state, sorted[0]!.startRef, sorted[sorted.length - 1]!.endRef).reduce(
    (n, m) => n + (m.text?.length ?? 0),
    0,
  );
}

/**
 * Pick the compressible span to compress. The kernel's recommended ranges are
 * small groups (split at user boundaries and protected gaps) that routinely
 * fall below `minCompressRange`, which makes the kernel reject them. Seed on
 * the largest range and expand to adjacent ranges until the span covers
 * enough message text (counting every message in the span, matching the
 * kernel's validation). Returns null when even the whole compressible set is
 * below the threshold.
 */
export function selectRangeSpan(
  ranges: CompressibleRange[],
  messages: CoreMessage[],
  state: CompressionState,
  minChars: number,
): { startRef: string; endRef: string; tokens: number } | null {
  const sorted = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef));
  if (sorted.length === 0) return null;
  let seed = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.tokens > sorted[seed]!.tokens) seed = i;
  }
  const charsOf = (startRef: string, endRef: string): number =>
    sliceRange(messages, state, startRef, endRef).reduce((n, m) => n + (m.text?.length ?? 0), 0);
  let lo = seed;
  let hi = seed;
  let startRef = sorted[lo]!.startRef;
  let endRef = sorted[hi]!.endRef;
  let chars = charsOf(startRef, endRef);
  while (chars < minChars && (lo > 0 || hi < sorted.length - 1)) {
    const leftGap = lo > 0 ? refNum(sorted[lo]!.startRef) - refNum(sorted[lo - 1]!.endRef) : Number.POSITIVE_INFINITY;
    const rightGap = hi < sorted.length - 1 ? refNum(sorted[hi + 1]!.startRef) - refNum(sorted[hi]!.endRef) : Number.POSITIVE_INFINITY;
    if (leftGap <= rightGap) lo--;
    else hi++;
    startRef = sorted[lo]!.startRef;
    endRef = sorted[hi]!.endRef;
    chars = charsOf(startRef, endRef);
  }
  if (chars < minChars) return null;
  return { startRef, endRef, tokens: Math.ceil(chars / 4) };
}

export function formatSlice(slice: CoreMessage[], state: CompressionState): string {
  let out = "";
  let skipped = 0;
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i]!;
    const ref = state.messageRefs.byRaw[m.id] ?? m.id;
    const role = m.role === "tool" ? "tool result" : m.role;
    const raw = m.text ?? "";
    const text = raw.slice(0, MAX_MSG_CHARS);
    const cut = text.length < raw.length;
    const line = `[${ref}] ${role}${m.toolName ? ` (${m.toolName})` : ""}: ${text}${cut ? " …[truncated]" : ""}\n`;
    if (out.length + line.length > MAX_SLICE_CHARS) {
      skipped = slice.length - i;
      break;
    }
    out += line;
  }
  if (skipped > 0) {
    out += `…[truncated: ${skipped} more message(s) in range not shown — cover them in the summary or split the range]\n`;
  }
  return out;
}

export function parseSummary(text: string): string | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const obj = JSON.parse(cleaned) as { summary?: unknown };
    if (typeof obj.summary === "string" && obj.summary.length > 0) return obj.summary;
  } catch {
    // fallthrough to null — never guess, fall back to nudge injection
  }
  return null;
}

export const SYSTEM_PROMPT =
  "You are a context-compression engine for an AI coding assistant. " +
  "Compress the given message range into ONE dense, self-contained technical summary. " +
  "Rules: preserve file paths with line numbers, exact signatures, error messages verbatim, " +
  "decisions with rationale, exact values, the user's goal and its evolution; " +
  "drop verbose logs, duplicate reads, and consumed exploration. " +
  "Output ONLY a JSON object: {\"summary\": \"...\"} with the summary as a single string.";

/**
 * Intercept a nudge: call the configured compression model to generate a
 * summary and apply it. Returns a result object indicating whether compression
 * was applied, and if not, whether the failure is fatal (config error) or
 * recoverable (parse failure, empty slice). Fatal failures should stop further
 * nudge attempts to avoid infinite loops.
 */
/**
 * Generate a summary for an arbitrary message range using the compression
 * model. Shared by autoCompress (nudge interception) and the /compact
 * handler (session_before_compact). Returns null when no model is usable,
 * the slice is empty, or the response is unparseable.
 */
export async function summarizeRange(
  ctx: ExtensionContext,
  messages: CoreMessage[],
  state: CompressionState,
  startRef: string,
  endRef: string,
  config: Config,
): Promise<{ summary: string; model: string } | null> {
  const configured = readCompressModel();
  const resolved = resolveCompressModel(ctx.modelRegistry, ctx.model, configured);
  if (!resolved) return null;
  const { model, label } = resolved;
  const slice = sliceRange(messages, state, startRef, endRef);
  if (slice.length === 0) return null;
  const tokens = Math.ceil(slice.reduce((n, m) => n + (m.text?.length ?? 0), 0) / 4);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    logWarn("summarize-range", { event: "auth-missing", model: label, error: auth.ok ? null : auth.error });
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const userText = `${SYSTEM_PROMPT}\n\nMessage range [${startRef}..${endRef}] (${tokens} tokens, ${slice.length} messages). Compress it:\n\n${formatSlice(slice, state)}`;
    const response = await complete(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: MAX_OUTPUT_TOKENS, signal: ac.signal },
    );
    const summary = parseSummary(
      response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
    );
    if (!summary) {
      logWarn("summarize-range", { event: "unparseable-summary", model: label, span: `${startRef}..${endRef}` });
      return null;
    }
    return { summary, model: label };
  } catch (e) {
    logWarn("summarize-range", { event: "failed", model: label, error: String(e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
export async function autoCompress(
  ctx: ExtensionContext,
  runtime: AcpRuntime,
  turn: { messages: CoreMessage[]; state: CompressionState; nudge?: NudgeDecision },
  config: Config,
): Promise<{ applied: boolean; fatal: boolean; error?: string }> {
  const configured = readCompressModel();
  const resolved = resolveCompressModel(ctx.modelRegistry, ctx.model, configured);
  if (!resolved) {
    if (configured) {
      const allModels = ctx.modelRegistry.getAll().map((m) => `${m.provider}/${m.id}`);
      logWarn("auto-compress", { event: "model-not-found", model: configured, available: allModels.slice(0, 10) });
      return { applied: false, fatal: true, error: `model-not-found: ${configured}` };
    }
    return { applied: false, fatal: false };
  }
  const { model, label: compressModel } = resolved;
  const ranges = (turn.nudge?.compressibleRanges ?? []).filter((r) => !r.dangerous);
  if (ranges.length === 0) return { applied: false, fatal: false };

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    logWarn("auto-compress", { event: "auth-missing", model: compressModel, error: auth.ok ? null : auth.error });
    return { applied: false, fatal: true, error: `auth-missing: ${compressModel}` };
  }
  const span = selectRangeSpan(ranges, turn.messages, turn.state, config.compress?.minCompressRange ?? 5000);
  if (!span) return { applied: false, fatal: false };
  const slice = sliceRange(turn.messages, turn.state, span.startRef, span.endRef);
  if (slice.length === 0) return { applied: false, fatal: false };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const userText = `${SYSTEM_PROMPT}\n\nMessage range [${span.startRef}..${span.endRef}] (${span.tokens} tokens, ${slice.length} messages). Compress it:\n\n${formatSlice(slice, turn.state)}`;
    const response = await complete(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: MAX_OUTPUT_TOKENS, signal: ac.signal },
    );
    const summary = parseSummary(
      response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
    );
    if (!summary) {
      logWarn("auto-compress", { event: "unparseable-summary", model: compressModel, span: `${span.startRef}..${span.endRef}` });
      return { applied: false, fatal: false, error: "unparseable-summary" };
    }

    const applied = runtime.core.applyCompression({
      ranges: [{ startRef: span.startRef, endRef: span.endRef, summary }],
      messages: turn.messages,
      state: turn.state,
      config,
    });
    const errors = applied.result.errors ?? [];
    if (errors.length > 0) {
      // Kernel rejected the span (summary too short/long, range empty) —
      // report it as a recoverable failure so the nudge falls back to injection
      // instead of being silently swallowed.
      logWarn("auto-compress", { sid: ctx.sessionManager.getSessionId(), event: "rejected", span: `${span.startRef}..${span.endRef}`, model: compressModel, errors });
      return { applied: false, fatal: false, error: errors.join("; ") };
    }
    await runtime.save(applied.state, ctx);
    logInfo("auto-compress", {
      sid: ctx.sessionManager.getSessionId(),
      event: "applied",
      span: `${span.startRef}..${span.endRef}`,
      tokens: span.tokens,
      model: compressModel,
      blocksCreated: applied.result.blocksCreated,
    });
    debug.event("auto-compress-applied", { sid: ctx.sessionManager.getSessionId(), span: `${span.startRef}..${span.endRef}`, tokens: span.tokens, model: compressModel, summaryLen: summary.length });
    return { applied: true, fatal: false };
  } catch (e) {
    logWarn("auto-compress", { event: "failed", model: compressModel, error: String(e) });
    return { applied: false, fatal: false, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
