// Context-overflow self-heal (extension side).
//
// When the model API rejects a request because the context is too large (a
// context-overflow 400), the extension reacts on the NEXT turn:
//   1. LEARN the real window: many providers state it in the error body
//      ("prompt is too long: ... > 128000 maximum", "maximum context length is
//      128000 tokens"). We persist it per-session and re-center the kernel's
//      nudge/truncate bands on it — below the real limit, not above it (the
//      fallback 150k puts those bands ABOVE a smaller real window, so nothing
//      fires before the overflow).
//   2. ARM an emergency: we force the next context event's usage to >=95% so
//      the kernel's emergency nudge + tool-result truncate fire immediately,
//      even if the estimate under-reports the sent view.
//
// This is the extension-side mirror of the proxy's overflow self-heal
// (billion-context PR #172). Unlike throttle-retry we do NOT rewrite the error
// or ask pi to retry: the overflow is real, and re-sending the same context
// would overflow again. The error surfaces; the next turn recovers.
//
// NOTE: the OVERFLOW_MARKER below is deliberately a superset of the
// OVERFLOW_GUARD in src/throttle-retry.ts (which uses it to AVOID treating an
// overflow as a throttle). Keep the two in sync when either changes.

// Detect a context-overflow error. Deliberately does NOT match Bedrock's
// "too many tokens" throttle (a 429, handled by throttle-retry) — only
// genuine context-length errors. The extra phrasings mirror pi-ai's own
// OVERFLOW_PATTERNS (pi-stable-ai/dist/utils/overflow.js) for providers whose
// error text the shorter set missed (Bedrock direct, xAI, Ollama, DashScope,
// llama.cpp, LM Studio, MiniMax, Mistral, Together, Poolside, z.ai) — without
// them the self-heal silently never fires for a direct connection to those
// providers (pi's native overflow/compaction handling still copes, but no
// window is learned and no emergency is armed).
export const OVERFLOW_MARKER =
  /prompt is too long|prompt_too_long|prompt_is_too_long|prompt too long; exceeded (?:max )?context length|request_too_large|exceeds the context window|exceeds the (maximum |model['’]s )?limit|maximum context length|maximum context size|max context length|context length exceeded|context[_ ]length[_ ]exceeded|exceeded model token limit|input token count.*exceeds|reduce the length of the messages|token limit exceeded|input is too long for requested model|maximum prompt length is|exceeds the maximum allowed input length|is longer than the model['’]?s context length|exceeds the available context size|greater than the context length|context window exceeds limit|too large for model with \d+ maximum context length|but the configured context size is|model_context_window_exceeded|range of input length should be/i;

export interface OverflowInfo {
  isOverflow: boolean;
  /** The real context window, when the provider stated it in the error. */
  window?: number;
  message: string;
}

// Pure: detect a context-overflow error from an error haystack (the
// errorMessage plus any error content) and parse the real window when the
// provider states it.
export function inspectOverflowMessage(haystack: string | undefined | null): OverflowInfo {
  const body = (haystack ?? "").trim();
  if (!body || !OVERFLOW_MARKER.test(body)) return { isOverflow: false, message: body };
  return { isOverflow: true, window: parseOverflowWindow(body), message: body };
}

function parseOverflowWindow(text: string): number | undefined {
  // Anthropic: "prompt is too long: 130000 tokens > 128000 maximum" -> 128000
  let m = />\s*(\d[\d,]*)\s*(?:tokens?)?\s*maximum/i.exec(text);
  if (m) return toTokenNumber(m[1]);
  // OpenAI: "maximum context length is 128000 tokens"
  m = /maximum context length is (\d[\d,]*)/i.exec(text);
  if (m) return toTokenNumber(m[1]);
  // OpenAI Responses (newer phrasing): "exceeds the model's maximum context
  // size of 128000 tokens" — must be parsed too, or the learned window stays
  // unknown for /responses relays.
  m = /maximum context size (?:is|of) (\d[\d,]*)/i.exec(text);
  if (m) return toTokenNumber(m[1]);
  // "...exceeds the model's maximum of N tokens" / "limit of N tokens"
  m = /(?:maximum|limit) of (\d[\d,]*)\s*(?:input\s+)?tokens/i.exec(text);
  if (m) return toTokenNumber(m[1]);
  return undefined;
}

function toTokenNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 1000 ? n : undefined;
}

/**
 * Reserve the model's output budget from the context window, so the kernel's
 * nudge/truncate bands sit below (window - maxOutput) and the context always
 * leaves room for the model's reply. This prevents the "context + output >
 * window" overflow on a small window (agents routinely set a large max output).
 * Returns the window unchanged when maxOutput is not usable (non-positive,
 * non-finite, or >= window — a maxOutput >= window request is degenerate and is
 * left to the overflow self-heal).
 */
export function reserveOutputHeadroom(window: number, maxOutput: number): number {
  if (
    Number.isFinite(window) &&
    window > 0 &&
    Number.isFinite(maxOutput) &&
    maxOutput > 0 &&
    maxOutput < window
  ) {
    return window - maxOutput;
  }
  return window;
}

/**
 * Whether the OUTPUT budget should be reserved from the context window at
 * all. Anthropic's Messages API enforces the input limit INDEPENDENTLY of
 * max_tokens (the output budget is separate — input up to the window works
 * with any max_tokens), so reserving the model's output capability would
 * shift the nudge/truncate bands down by maxTokens on every session with no
 * safety gain (e.g. a 200k model with a 64k output budget would start
 * compressing around 136k). The OpenAI-family APIs count output against the
 * window, so the reservation is only needed there. Unknown APIs reserve
 * (conservative — a missed reservation at worst overflows once and the
 * self-heal corrects it).
 */
export function shouldReserveOutputHeadroom(api: string | undefined): boolean {
  return api !== "anthropic-messages";
}

/**
 * Apply the output-headroom reservation to a resolved config's modelContextLimit
 * (see reserveOutputHeadroom / shouldReserveOutputHeadroom). Returns a NEW config
 * (never mutates the input) so the shared resolved config stays untouched. Used
 * by BOTH the live context transform and the read-only panel surfaces (/acp,
 * acp_status) so every percentage is measured against the SAME real request
 * limit — otherwise the panel reports against the full window while the nudge
 * bands run against (window − maxOutput) (issue #267).
 */
export function applyOutputHeadroom<T extends { modelContextLimit: number }>(
  config: T,
  model: { maxTokens?: number; api?: string } | undefined,
): T {
  const maxOutput = model?.maxTokens ?? 0;
  if (shouldReserveOutputHeadroom(model?.api)) {
    const reserved = reserveOutputHeadroom(config.modelContextLimit, maxOutput);
    if (reserved !== config.modelContextLimit) return { ...config, modelContextLimit: reserved };
  }
  return config;
}

// Per-session overflow self-heal state. Keyed by session id so concurrent
// sessions in one extension instance cannot share a learned window or an
// armed emergency (same rationale as the throttle episode).
export class OverflowEpisode {
  /** Real windows learned from overflow errors, keyed by model id. A learned
   *  window is model-specific: switching to a bigger model mid-session must
   *  not inherit the smaller model's learned limit (that would re-center the
   *  bands below the new model's real window → premature compression). */
  private learned = new Map<string, number>();
  learnedWindowFor(modelId: string): number | null {
    return this.learned.get(modelId) ?? null;
  }
  setLearnedWindow(modelId: string, window: number): void {
    this.learned.set(modelId, window);
  }
  /** When true, the next context event forces usage >=95% (emergency). Kept
   *  session-scoped (not per-model): the context did not shrink, so the next
   *  turn needs the emergency regardless of which model answers it. */
  armed = false;
  reset(): void {
    this.learned.clear();
    this.armed = false;
  }
}
