import test from "node:test";
import assert from "node:assert/strict";

import { inspectOverflowMessage, OverflowEpisode, OVERFLOW_MARKER, isNoBody4xxError, NO_BODY_ARM_RATIO, reserveOutputHeadroom, shouldReserveOutputHeadroom } from "../src/overflow-selfheal.js";

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
  ep.noteSentView(60_000, 100_000);
  assert.equal(ep.onNoBody4xx().arm, true);
  ep.noteSuccess();
  ep.noteSentView(10_000, 100_000);
  assert.equal(ep.onNoBody4xx().arm, false, "low ratio + first occurrence after reset");
  assert.equal(ep.learnedWindowFor("m1"), 100000);
  assert.equal(ep.armed, true);
  ep.reset();
  assert.equal(ep.learnedWindowFor("m1"), null);
  assert.equal(ep.armed, false);
  assert.equal(ep.onNoBody4xx().ratio, null, "reset clears the recorded sent view");
  assert.equal(ep.onNoBody4xx().consecutive, 2, "reset clears the consecutive count");
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

test("OVERFLOW_MARKER: case-insensitive and matches the shared guard patterns", () => {
  assert.ok(OVERFLOW_MARKER.test("PROMPT IS TOO LONG"));
  assert.ok(OVERFLOW_MARKER.test("Context Length Exceeded"));
  assert.ok(OVERFLOW_MARKER.test("context_length_exceeded"));
  assert.ok(!OVERFLOW_MARKER.test("too many tokens, please wait before trying again"));
});

// --- no-body 4xx (incident 2026-08-23): pi's ambiguous "4xx ... (no body)" ---
// pi surfaces a bodyless provider 4xx verbatim; pi-ai's own classifier
// treats the text as overflow (same anchored regex), but our marker set must
// NOT — the text also carries non-overflow 4xx. It is a possible-overflow
// signal armed only with corroboration (OverflowEpisode.onNoBody4xx).
test("isNoBody4xxError: matches pi's surfaced forms of the bodyless 4xx", () => {
  assert.equal(isNoBody4xxError("400 status code (no body)"), true, "the incident form");
  assert.equal(isNoBody4xxError("413 status code (no body)"), true);
  assert.equal(isNoBody4xxError("400 (no body)"), true);
  assert.equal(isNoBody4xxError("413(no body)"), true, "zero spaces allowed");
});

test("isNoBody4xxError: other statuses / texts / empty are not no-body 4xx", () => {
  assert.equal(isNoBody4xxError("429 status code (no body)"), false, "throttle stays on the throttle path");
  assert.equal(isNoBody4xxError("500 status code (no body)"), false);
  assert.equal(isNoBody4xxError("404 status code (no body)"), false);
  assert.equal(isNoBody4xxError("insufficient_quota"), false);
  assert.equal(isNoBody4xxError(""), false);
  assert.equal(isNoBody4xxError(undefined), false);
  assert.equal(isNoBody4xxError("Error: 400 status code (no body)"), false, "anchored like pi-ai's classifier — a prefix is not pi's surface form");
});

test("no-body 4xx stays OUT of the unconditional text-marker path", () => {
  assert.equal(inspectOverflowMessage("400 status code (no body)").isOverflow, false);
  assert.equal(inspectOverflowMessage("413 (no body)").isOverflow, false);
});

test("inspectOverflowMessage: classic 'maximum context length is 262144' still arms via the text-marker path (regression)", () => {
  const info = inspectOverflowMessage(
    "This model's maximum context length is 262144 tokens. However, you requested about 262200 tokens. Please reduce the length of the messages.",
  );
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 262144);
  assert.equal(isNoBody4xxError(info.message), false);
});

test("no-body guard: low estimate + first occurrence → NO arm (false-positive guard)", () => {
  // Incident scale: ~31.5k estimated on a 131,072 effective limit (~24%) —
  // the estimate under-reports vs sglang's input+max_tokens cap, so the
  // ratio guard alone cannot fire; a single hit must not arm either.
  const ep = new OverflowEpisode();
  ep.noteSentView(31_475, 131_072);
  const d = ep.onNoBody4xx();
  assert.equal(d.arm, false);
  assert.equal(d.consecutive, 1);
  assert.equal(d.ratio, 31_475 / 131_072);
});

test("no-body guard: estimate >= 50% of effective limit → arm on first occurrence", () => {
  const ep = new OverflowEpisode();
  ep.noteSentView(70_000, 131_072);
  assert.equal(ep.onNoBody4xx().arm, true);
});

test("no-body guard: exactly the threshold ratio arms (>= semantics)", () => {
  const ep = new OverflowEpisode();
  ep.noteSentView(65_536, 131_072);
  const d = ep.onNoBody4xx();
  assert.equal(d.ratio, NO_BODY_ARM_RATIO);
  assert.equal(d.arm, true, "ratio == threshold arms on the first occurrence");
});

test("no-body guard: second consecutive no-body at low estimate → arm (incident dead-loop)", () => {
  const ep = new OverflowEpisode();
  ep.noteSentView(31_475, 131_072);
  assert.equal(ep.onNoBody4xx().arm, false, "first: low ratio, first occurrence");
  const d = ep.onNoBody4xx();
  assert.equal(d.arm, true, "second consecutive since last success arms");
  assert.equal(d.consecutive, 2);
});

test("no-body guard: successful turn resets the consecutive count", () => {
  const ep = new OverflowEpisode();
  ep.noteSentView(31_475, 131_072);
  assert.equal(ep.onNoBody4xx().arm, false);
  ep.noteSuccess();
  assert.equal(ep.onNoBody4xx().arm, false, "after a success the count restarts — a lone no-body does not arm");
  assert.equal(ep.onNoBody4xx().arm, true, "the next consecutive pair still arms");
});

test("no-body guard: no recorded sent view (fresh episode) → first no-body does not arm", () => {
  // message_end can only see a sent view recorded by a context event; on a
  // mid-session extension reload the first error has no basis — only the
  // consecutive guard can fire (on the second hit).
  const ep = new OverflowEpisode();
  const d = ep.onNoBody4xx();
  assert.equal(d.arm, false);
  assert.equal(d.ratio, null);
  assert.equal(ep.onNoBody4xx().arm, true);
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
