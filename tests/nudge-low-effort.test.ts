import test from "node:test";
import assert from "node:assert/strict";
import { applyNudgeEffortClamp, nudgeLowEffortDecision } from "../src/nudge-low-effort.ts";
import { mergeCompress, resolveCompress } from "../src/config.ts";

test("anthropic: thinking.budget_tokens above floor clamps down to 1024", () => {
  const out = applyNudgeEffortClamp({ model: "m", thinking: { type: "enabled", budget_tokens: 16000 }, messages: [] }, "anthropic");
  assert.equal(out.changed, true);
  assert.deepEqual(out.body, { model: "m", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [] });
});

test("anthropic: budget at the floor is untouched", () => {
  const body = { model: "m", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [] };
  const out = applyNudgeEffortClamp(body, "anthropic");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("anthropic: budget below floor is never raised", () => {
  const out = applyNudgeEffortClamp({ model: "m", thinking: { type: "enabled", budget_tokens: 512 }, messages: [] }, "anthropic");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("openai: reasoning_effort high lowers to low", () => {
  const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: "high", messages: [] }, "openai");
  assert.equal(out.changed, true);
  assert.deepEqual(out.body, { model: "m", reasoning_effort: "low", messages: [] });
});

test("openai: reasoning_effort medium lowers to low", () => {
  const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: "medium", messages: [] }, "openai");
  assert.equal(out.changed, true);
  assert.deepEqual(out.body, { model: "m", reasoning_effort: "low", messages: [] });
});

test("openai: xhigh/max (qwen-style) lower to low", () => {
  for (const v of ["xhigh", "max"]) {
    const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: v, messages: [] }, "openai");
    assert.equal(out.changed, true);
    assert.deepEqual(out.body, { model: "m", reasoning_effort: "low", messages: [] });
  }
});

test("openai: reasoning_effort minimal is never raised", () => {
  const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: "minimal", messages: [] }, "openai");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("openai: no-reasoning value (none) is never raised to low", () => {
  const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: "none", messages: [] }, "openai");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("openai: unrecognized effort value is left untouched (never mangle)", () => {
  const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: "ultra", messages: [] }, "openai");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("openai: absent reasoning_effort is not injected", () => {
  const out = applyNudgeEffortClamp({ model: "m", messages: [] }, "openai");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("google: thinkingBudget above floor clamps to 128", () => {
  const out = applyNudgeEffortClamp({ model: "m", generationConfig: { thinkingConfig: { thinkingBudget: 8000 } }, contents: [] }, "google");
  assert.equal(out.changed, true);
  assert.deepEqual(out.body, { model: "m", generationConfig: { thinkingConfig: { thinkingBudget: 128 } }, contents: [] });
});

test("google: dynamic (-1) thinkingBudget is left untouched", () => {
  const out = applyNudgeEffortClamp({ model: "m", generationConfig: { thinkingConfig: { thinkingBudget: -1 } }, contents: [] }, "google");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("responses: reasoning.effort high lowers to low", () => {
  const out = applyNudgeEffortClamp({ model: "m", instructions: "x", input: [], reasoning: { effort: "high" } }, "responses");
  assert.equal(out.changed, true);
  assert.deepEqual(out.body, { model: "m", instructions: "x", input: [], reasoning: { effort: "low" } });
});

test("responses: absent reasoning is not injected", () => {
  const out = applyNudgeEffortClamp({ model: "m", instructions: "x", input: [] }, "responses");
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("idempotent: a second pass over an already-clamped body changes nothing", () => {
  const first = applyNudgeEffortClamp({ model: "m", thinking: { type: "enabled", budget_tokens: 16000 }, messages: [] }, "anthropic");
  assert.equal(first.changed, true);
  const second = applyNudgeEffortClamp(first.body, "anthropic");
  assert.equal(second.changed, false);
  assert.equal(second.body, undefined);
});

test("input is never mutated (clone-before-mutate protects the caller's payload)", () => {
  const body = { model: "m", reasoning_effort: "high", messages: [] };
  const out = applyNudgeEffortClamp(body, "openai");
  assert.equal(out.changed, true);
  assert.equal(body.reasoning_effort, "high");
});

test("safety: non-object bodies are returned unchanged", () => {
  assert.equal(applyNudgeEffortClamp("not an object", "anthropic").changed, false);
  assert.equal(applyNudgeEffortClamp(null, "openai").changed, false);
  assert.equal(applyNudgeEffortClamp([1, 2, 3], "openai").changed, false);
});

test("safety: null protocol is a no-op", () => {
  const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: "high", messages: [] }, null);
  assert.equal(out.changed, false);
  assert.equal(out.body, undefined);
});

test("classifier-independent: a plain user turn still clamps", () => {
  const out = applyNudgeEffortClamp({ model: "m", reasoning_effort: "high", messages: [{ role: "user", content: "please compress what you can" }] }, "openai");
  assert.equal(out.changed, true);
  assert.deepEqual(out.body, { model: "m", reasoning_effort: "low", messages: [{ role: "user", content: "please compress what you can" }] });
});

test("decision: fresh first nudge of an episode clamps once", () => {
  assert.deepEqual(nudgeLowEffortDecision(true, false, true), { clamp: true, nextPrev: true });
});

test("decision: a deferred nudge retried on the next turn does not re-clamp", () => {
  assert.deepEqual(nudgeLowEffortDecision(true, true, true), { clamp: false, nextPrev: true });
});

test("decision: disabled never clamps but still tracks the episode", () => {
  assert.deepEqual(nudgeLowEffortDecision(true, false, false), { clamp: false, nextPrev: true });
});

test("decision: a non-nudge turn does not clamp and resets the episode", () => {
  assert.deepEqual(nudgeLowEffortDecision(false, false, true), { clamp: false, nextPrev: false });
});

test("decision: full episode cycle — clamp, defer, recover, new-episode re-clamp", () => {
  let prev = false;
  const seq: boolean[] = [];
  for (const injected of [true, true, false, true]) {
    const d = nudgeLowEffortDecision(injected, prev, true);
    seq.push(d.clamp);
    prev = d.nextPrev;
  }
  assert.deepEqual(seq, [true, false, false, true]);
});

test("config: nudgeLowEffort resolves globally", () => {
  assert.equal(resolveCompress({ nudgeLowEffort: true }, undefined, undefined).nudgeLowEffort, true);
});

test("config: unset nudgeLowEffort stays off (default-off guarantee)", () => {
  assert.equal(resolveCompress({}, undefined, undefined).nudgeLowEffort, undefined);
  assert.equal(resolveCompress(undefined, undefined, undefined).nudgeLowEffort, undefined);
});

test("config: deepest level wins for nudgeLowEffort", () => {
  const compress = { nudgeLowEffort: true, providers: { openai: { models: { "qwen-max": { nudgeLowEffort: false } } } } };
  assert.equal(resolveCompress(compress, "openai", "qwen-max").nudgeLowEffort, false);
  assert.equal(resolveCompress(compress, "openai", "other-model").nudgeLowEffort, true);
});

test("config: mergeCompress carries nudgeLowEffort through each level", () => {
  assert.equal(mergeCompress({ nudgeLowEffort: true }).nudgeLowEffort, true);
  assert.equal(mergeCompress(undefined, { nudgeLowEffort: true }).nudgeLowEffort, true);
  assert.equal(mergeCompress({ nudgeLowEffort: true }, undefined, { nudgeLowEffort: false }).nudgeLowEffort, false);
});
