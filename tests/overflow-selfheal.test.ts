import test from "node:test";
import assert from "node:assert/strict";

import { inspectOverflowMessage, OverflowEpisode, OVERFLOW_MARKER, reserveOutputHeadroom, shouldReserveOutputHeadroom } from "../src/overflow-selfheal.js";

test("inspectOverflowMessage: detects OpenAI context-overflow + parses window", () => {
  const info = inspectOverflowMessage(
    `This model's maximum context length is 128000 tokens. However, you requested 130000 output tokens and your prompt contains approximately 129000 tokens. Please reduce the length of the input prompt or the number of requested output tokens.`,
  );
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
});

test("inspectOverflowMessage: detects Anthropic overflow + parses '> N maximum' window", () => {
  const info = inspectOverflowMessage("prompt is too long: 130000 tokens > 128000 maximum");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
});

test("inspectOverflowMessage: comma-grouped window", () => {
  const info = inspectOverflowMessage("maximum context length is 128,000 tokens");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
});

test("inspectOverflowMessage: 'limit of N tokens' form", () => {
  const info = inspectOverflowMessage("input exceeds the model's limit of 64000 tokens");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 64000);
});

test("inspectOverflowMessage: OpenAI Responses 'maximum context size of N' phrasing", () => {
  // The newer Responses-API phrasing (the chat-completions one says
  // "maximum context LENGTH is") — must be detected AND parsed, or self-heal
  // learns no window for /responses relays.
  const info = inspectOverflowMessage(
    "This request's total token count is 130000, which exceeds the model's maximum context size of 128000 tokens.",
  );
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
  assert.equal(inspectOverflowMessage("maximum context size is 128,000").window, 128000);
});

test("inspectOverflowMessage: overflow without a stated window → window undefined", () => {
  const info = inspectOverflowMessage("prompt is too long, please shorten the conversation");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, undefined);
});

test("inspectOverflowMessage: bare markers without a number", () => {
  assert.equal(inspectOverflowMessage("error: context_length_exceeded").isOverflow, true);
  assert.equal(inspectOverflowMessage("request_too_large").isOverflow, true);
  assert.equal(inspectOverflowMessage("your prompt exceeds the context window").isOverflow, true);
  assert.equal(inspectOverflowMessage("exceeded model token limit").isOverflow, true);
});

test("inspectOverflowMessage: Bedrock throttle (429 'too many tokens') is NOT a context overflow", () => {
  const info = inspectOverflowMessage("429 rate limit: Too many tokens, please wait before trying again.");
  assert.equal(info.isOverflow, false);
});

test("inspectOverflowMessage: quota/billing errors are not context overflows", () => {
  assert.equal(inspectOverflowMessage("insufficient_quota: you have exceeded your quota").isOverflow, false);
  assert.equal(inspectOverflowMessage("out of budget for this billing period").isOverflow, false);
});

test("inspectOverflowMessage: normal assistant text / empty → not overflow", () => {
  assert.equal(inspectOverflowMessage("Here is the code you asked for.").isOverflow, false);
  assert.equal(inspectOverflowMessage("").isOverflow, false);
  assert.equal(inspectOverflowMessage(undefined).isOverflow, false);
});

test("inspectOverflowMessage: rejects a sub-1000 'window' (not a real context limit)", () => {
  // A tiny number in a marker-adjacent sentence must not be mistaken for a window.
  const info = inspectOverflowMessage("prompt is too long: 50 tokens > 30 maximum");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, undefined, "30 is below the 1000 floor → treated as unparseable");
});

test("OverflowEpisode: initial state + reset", () => {
  const ep = new OverflowEpisode();
  assert.equal(ep.learnedWindowFor("m1"), null);
  assert.equal(ep.armed, false);
  ep.setLearnedWindow("m1", 100000);
  ep.armed = true;
  assert.equal(ep.learnedWindowFor("m1"), 100000);
  assert.equal(ep.armed, true);
  ep.reset();
  assert.equal(ep.learnedWindowFor("m1"), null);
  assert.equal(ep.armed, false);
});

test("OverflowEpisode: learned windows are per-model (no cross-model crosstalk)", () => {
  // The footgun this PR fixes, in the reverse direction: an overflow on a
  // SMALL model must not keep capping a BIGGER model the user switches to
  // mid-session (the bands would sit far below the new model's real window).
  const ep = new OverflowEpisode();
  ep.setLearnedWindow("small-model", 100000);
  assert.equal(ep.learnedWindowFor("small-model"), 100000);
  assert.equal(ep.learnedWindowFor("big-model"), null, "other models unaffected");
  ep.setLearnedWindow("big-model", 200000);
  assert.equal(ep.learnedWindowFor("small-model"), 100000, "first model kept");
  assert.equal(ep.learnedWindowFor("big-model"), 200000);
  ep.setLearnedWindow("small-model", 90000);
  assert.equal(ep.learnedWindowFor("small-model"), 90000, "re-learned window overwrites");
});

test("reserveOutputHeadroom: reserves the output budget from the window", () => {
  assert.equal(reserveOutputHeadroom(100_000, 16_384), 83_616);
  assert.equal(reserveOutputHeadroom(128_000, 1), 127_999);
});

test("reserveOutputHeadroom: no-op for unusable maxOutput", () => {
  assert.equal(reserveOutputHeadroom(100_000, 0), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, -5), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, Number.NaN), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, Number.POSITIVE_INFINITY), 100_000);
});

test("reserveOutputHeadroom: no-op when maxOutput >= window (degenerate request)", () => {
  assert.equal(reserveOutputHeadroom(100_000, 100_000), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, 200_000), 100_000);
});

test("reserveOutputHeadroom: no-op for unusable window", () => {
  assert.equal(reserveOutputHeadroom(0, 10_000), 0);
  assert.equal(reserveOutputHeadroom(-1, 10_000), -1);
  assert.equal(reserveOutputHeadroom(Number.NaN, 10_000), Number.NaN);
});

test("reserveOutputHeadroom: capPct bounds the reservation at capPct * window (issue #207)", () => {
  // qwen3.8-27b scenario: 262144 window, 131072 registered maxTokens. Legacy
  // full reservation halved the budget; the 25% default cap keeps 196608.
  assert.equal(reserveOutputHeadroom(262_144, 131_072, 0.25), 196_608);
  // A small maxOutput below the cap is reserved in full (unchanged behavior).
  assert.equal(reserveOutputHeadroom(262_144, 32_768, 0.25), 229_376);
  assert.equal(reserveOutputHeadroom(100_000, 16_384, 0.25), 83_616);
});

test("reserveOutputHeadroom: capPct edge semantics", () => {
  assert.equal(reserveOutputHeadroom(100_000, 50_000, 0), 100_000, "0 disables the reservation");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, -1), 100_000, "negative clamps to 0 → disabled");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, 1), 50_000, "1 = legacy full reservation");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, 2), 50_000, ">= 1 clamps to legacy");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, Number.NaN), 50_000, "non-finite = not provided → legacy");
  assert.equal(reserveOutputHeadroom(100_000, 50_000), 50_000, "default arg preserves pre-cap behavior");
});

test("reserveOutputHeadroom: cap does not resurrect no-op cases", () => {
  assert.equal(reserveOutputHeadroom(100_000, 0, 0.25), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, 100_000, 0.25), 100_000, "maxOutput >= window still degenerate");
  assert.equal(reserveOutputHeadroom(0, 10_000, 0.25), 0);
});

test("OVERFLOW_MARKER: case-insensitive and matches the shared guard patterns", () => {
  assert.ok(OVERFLOW_MARKER.test("PROMPT IS TOO LONG"));
  assert.ok(OVERFLOW_MARKER.test("Context Length Exceeded"));
  assert.ok(OVERFLOW_MARKER.test("context_length_exceeded"));
  assert.ok(!OVERFLOW_MARKER.test("too many tokens, please wait before trying again"));
});

// Provider phrasings the shorter marker set missed — mirrored from pi-ai's
// own OVERFLOW_PATTERNS (pi-stable-ai/dist/utils/overflow.js). Without them
// the self-heal never fires for a DIRECT connection to these providers (no
// relay to normalize the text): pi's native overflow/compaction still copes,
// but no window is learned and no emergency is armed.
test("inspectOverflowMessage: provider-specific overflow phrasings", () => {
  assert.equal(inspectOverflowMessage("Input is too long for requested model").isOverflow, true, "Bedrock");
  assert.equal(inspectOverflowMessage("This model's maximum prompt length is 131072 but the request contains 537812 tokens").isOverflow, true, "xAI");
  assert.equal(inspectOverflowMessage("Input length 200000 exceeds the maximum allowed input length of 131072 tokens.").isOverflow, true, "OpenRouter/Poolside");
  assert.equal(inspectOverflowMessage("The input (200000 tokens) is longer than the model's context length (131072 tokens)").isOverflow, true, "Together AI");
  assert.equal(inspectOverflowMessage("the request exceeds the available context size, try increasing it").isOverflow, true, "llama.cpp");
  assert.equal(inspectOverflowMessage("tokens to keep from the initial prompt is greater than the context length").isOverflow, true, "LM Studio");
  assert.equal(inspectOverflowMessage("invalid params, context window exceeds limit").isOverflow, true, "MiniMax");
  assert.equal(inspectOverflowMessage("Prompt contains 200000 tokens which is too large for model with 131072 maximum context length").isOverflow, true, "Mistral");
  assert.equal(inspectOverflowMessage("Prompt has 200000 tokens, but the configured context size is 131072 tokens").isOverflow, true, "DS4");
  assert.equal(inspectOverflowMessage("model_context_window_exceeded").isOverflow, true, "z.ai");
  assert.equal(inspectOverflowMessage("prompt too long; exceeded max context length by 12345 tokens").isOverflow, true, "Ollama");
  assert.equal(inspectOverflowMessage("Range of input length should be [1, 131072]").isOverflow, true, "DashScope/Qwen");
});

test("inspectOverflowMessage: throttle/throttling phrases are still NOT overflows after the marker extension", () => {
  assert.equal(inspectOverflowMessage("ThrottlingException: Too many tokens, please wait before trying again.").isOverflow, false);
  assert.equal(inspectOverflowMessage("Throttling: request rate increased too quickly.").isOverflow, false);
  assert.equal(inspectOverflowMessage("429 rate limit: Too many tokens, please wait before trying again.").isOverflow, false, "the rewritten retryable form (throttle-retry) stays off the overflow path");
});

// Anthropic enforces the input limit independently of max_tokens (separate
// output budget) — reserving the model's output capability would shift every
// nudge/truncate band down by maxTokens on every session for no safety gain.
// Other APIs count output against the window — reserve there.
test("shouldReserveOutputHeadroom: anthropic-messages exempt, other APIs reserve", () => {
  assert.equal(shouldReserveOutputHeadroom("anthropic-messages"), false);
  assert.equal(shouldReserveOutputHeadroom("openai-chat"), true);
  assert.equal(shouldReserveOutputHeadroom("openai-responses"), true);
  assert.equal(shouldReserveOutputHeadroom("openai-completions"), true);
  assert.equal(shouldReserveOutputHeadroom("google"), true);
  assert.equal(shouldReserveOutputHeadroom("bedrock-converse-stream"), true, "conservative for uncertain APIs");
  assert.equal(shouldReserveOutputHeadroom(undefined), true, "unknown api → conservative (reserve)");
});
