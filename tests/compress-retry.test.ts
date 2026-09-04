import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createRuntime, MAX_COMPRESS_ATTEMPTS } from "../src/runtime.js";
import { isCompressSuccessText, isCompressNoopText } from "../src/compress-tool.js";

// Compress-failure handling (session 01a00a38 post-mortem + issue #223):
// the model's ONLY compress call in a 3-hour session was rejected by pi's
// typebox validation ("content.0: must be object" — vLLM non-strict tools
// stringified the array).
//
// Behavior under test:
//  1. compress-tool rejects non-array (JSON-string) content with a thrown
//     error — the JSON-encoded string form was removed per #273.
//  2. Argument errors THROW (pi only marks thrown tool errors isError:true —
//     a returned error string would be isError:false: not counted + counter
//     reset).
//  3. A failed compress toolResult persists in the session log (the model
//     sees the error and can self-correct) but NO transient retry prompt is
//     injected: per-LLM-call re-injection caused the #223 infinite-append
//     loop (~400 injections/hour when the model never retries).
//  4. Failed/no-op outcomes are counted per user turn to drive the nudge
//     circuit breaker (issue #6): once MAX_COMPRESS_ATTEMPTS attempts burn
//     in one turn, the emergency nudge stops re-injecting. Neutral outcomes
//     (non-error text that is not a success panel) neither reset nor advance
//     the counter; success resets it; a new user turn gets a fresh budget.

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function toolResultMsg(id: string, toolCallId: string, text: string, isError: boolean) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: {
      role: "toolResult", toolCallId, toolName: "compress",
      content: [{ type: "text", text }], isError, timestamp: Date.now(),
    },
  };
}

// Simulates pi's thrown-validation toolResult shape (what a failed compress
// call looks like in entries — whether thrown by pi-ai validation or by
// handleCompress's own argument checks).
const VALIDATION_ERR = 'Validation failed for tool "compress":\n  - content.0: must be object\n\nReceived arguments:\n{"content":"[{\\"topic\\":\\"x\\"}]"}';
const SUCCESS_PANEL = "▣ ACP | 58.5K → 5.7K tokens (~52.8K reclaimed, 4 blocks)";
const PARTIAL_PANEL = "▣ ACP | 58.5K → 30K tokens (~28.5K reclaimed, 3 blocks)\nErrors: range m00009..m00012: Summary too long";
const NOOP_PANEL = "▣ ACP | 58.5K → 58.5K tokens (~0 reclaimed, 0 blocks)\nErrors: range m00001..m00002: Requested range(s) already compressed; nothing to compress";
const NEUTRAL_TEXT = "No ranges provided.";

function fakeCtx(getEntries: () => any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => getEntries(),
      getSessionId: () => "retry-test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

const retryMsgs = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /compress call FAILED/.test(JSON.stringify(m.content)));

const ZH = "中".repeat(6000);

// ─── unit: runtime counter ──────────────────────────────────────────────────

test("noteCompressOutcomes: counts, caps, resets on success, resets per turn, neutral freezes", () => {
  const rt = createRuntime({});
  const fail = (id: string) => ({ toolCallId: id, isError: true, success: false });
  const success = (id: string) => ({ toolCallId: id, isError: false, success: true });
  const neutral = (id: string) => ({ toolCallId: id, isError: false, success: false });

  let r = rt.noteCompressOutcomes("u1", [fail("t0")]);
  assert.equal(r.count, 1);
  assert.equal(r.cappedNow, false);

  // idempotent re-fire (same toolCallIds): count frozen
  r = rt.noteCompressOutcomes("u1", [fail("t0")]);
  assert.equal(r.count, 1, "no double count on re-fire");

  // neutral outcome: no reset
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1")]);
  assert.equal(r.count, 1, "neutral does not reset the counter");

  // a NEW failure after a neutral one: attempt 2, not 1 — neutral cannot
  // bypass the cap by resetting between failures
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9")]);
  assert.equal(r.count, 2);

  // third distinct failure → cap, cappedNow fires once
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc")]);
  assert.equal(r.count, 3);
  assert.equal(r.cappedNow, true);
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc")]);
  assert.equal(r.cappedNow, false, "cap notification is one-shot");
  assert.equal(MAX_COMPRESS_ATTEMPTS, 3);

  // success resets the counter
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc"), success("ts")]);
  assert.equal(r.count, 0);

  // a NEW failure after success counts a fresh cycle
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc"), success("ts"), fail("td")]);
  assert.equal(r.count, 1);

  // new user turn → fresh counter even without a success in between
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc"), success("ts"), fail("td"), fail("te"), fail("tf")]);
  assert.equal(r.count, 3, "back at cap");
  r = rt.noteCompressOutcomes("u2", [fail("x0")]);
  assert.equal(r.count, 1);

  // a deduped stale failure must not count against a new turn
  r = rt.noteCompressOutcomes("u3", [fail("x0")]);
  assert.equal(r.count, 0, "stale id deduped, count stays 0 after turn change");
});

// ─── unit: normalizeRanges via the tool ─────────────────────────────────────

test("compress tool THROWS on non-array (JSON-string) content (isError:true → counted by the outcome tracker)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-str2.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  // pi-agent-core marks only THROWN tool errors isError:true; returning the
  // error string would be isError:false (not counted as a failure + counter
  // reset), so the tool must reject. The JSON-string form was removed per
  // #273, so any non-array content (a JSON-encoded array string included) is
  // rejected with a clear "must be an ARRAY" error.
  await assert.rejects(
    () => compressTool.execute("tc1", { content: JSON.stringify([{ startId: "m00001", endId: "m00001", summary: "s" }]) }, undefined, undefined, ctx),
    /Invalid compress content[\s\S]*ARRAY/,
  );
  await rm(`${stateFile}.acp.json`, { force: true });
});

// ─── integration: no transient retry prompt (#223) ──────────────────────────

test("failed compress toolResults never inject a transient retry prompt; the error itself persists in context (#223)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-it1.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  const r0 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r0).length, 0, "no failures yet → no retry prompt");

  entries = [...entries, toolResultMsg("e2", "call_1", VALIDATION_ERR, true)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 0, "failure → NO transient retry prompt");
  assert.ok(
    JSON.stringify(r1.messages).includes("must be object"),
    "the failed toolResult itself flows to the model (self-correction signal)",
  );

  // re-fire (streaming/tool loop fires context repeatedly): still nothing —
  // the pre-#223 fix re-injected on every fire (~400/hour when never retried)
  const r2 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r2).length, 0, "re-fire injects nothing");

  // second and third failures → cap burned for the nudge breaker, still no prompt
  entries = [...entries, toolResultMsg("e3", "call_2", VALIDATION_ERR, true)];
  const r3 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r3).length, 0);
  entries = [...entries, toolResultMsg("e4", "call_3", VALIDATION_ERR, true)];
  const r4 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r4).length, 0, "cap reached → still no prompt ever");

  // later turns: a stale failure and a fresh one both stay silent
  entries = [...entries, userMsg("e5", "next question")];
  for (let i = 0; i < 3; i++) {
    const r = await fire(handlers, ctx);
    assert.equal(retryMsgs(r).length, 0, `new turn fire ${i + 1}: nothing`);
  }
  entries = [...entries, toolResultMsg("e6", "call_9", VALIDATION_ERR, true)];
  const r6 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r6).length, 0, "fresh failure in a new turn → no prompt");
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("neutral and no-op outcomes inject nothing; only the counter state changes", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-noop.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  entries = [...entries, toolResultMsg("e2", "call_1", NOOP_PANEL, false)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 0, "no-op → no prompt");

  entries = [...entries, toolResultMsg("e3", "call_2", NEUTRAL_TEXT, false)];
  const r2 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r2).length, 0, "neutral → no prompt");

  entries = [...entries, toolResultMsg("e4", "call_3", NOOP_PANEL, false)];
  const r3 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r3).length, 0, "third no-op → capped breaker, no prompt");

  entries = [...entries, toolResultMsg("e5", "call_4", SUCCESS_PANEL, false)];
  const r4 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r4).length, 0, "success → no prompt");
  await rm(`${stateFile}.acp.json`, { force: true });
});

// ─── issue #6: no-op compress runs must not bypass the nudge cap ────────────
//
// handleCompress returns a "▣ ACP | …" panel even when blocksCreated === 0
// (every range skipped: already compressed / below min). The old
// isCompressSuccessText matched ANY panel prefix → no-op runs counted as
// success → counter reset → the (dedup-exempt) emergency nudge re-fired on
// every LLM call → unbounded emergency-nudge ↔ no-op-compress ping-pong.

test("classification: 0-block panels are no-ops, not successes; >=1 block is success", () => {
  assert.equal(isCompressSuccessText(SUCCESS_PANEL), true);
  assert.equal(isCompressSuccessText(PARTIAL_PANEL), true, "partial errors with progress still count as success");
  assert.equal(isCompressSuccessText(NOOP_PANEL), false, "0-block panel must NOT be success (the issue #6 bug)");
  assert.equal(isCompressSuccessText(NEUTRAL_TEXT), false);
  assert.equal(isCompressSuccessText("Validation failed"), false);
  assert.equal(isCompressNoopText(NOOP_PANEL), true);
  assert.equal(isCompressNoopText(SUCCESS_PANEL), false);
  assert.equal(isCompressNoopText(PARTIAL_PANEL), false);
  assert.equal(isCompressNoopText(NEUTRAL_TEXT), false, "non-panels stay neutral");
});

test("noteCompressOutcomes: no-op panels advance the counter toward the cap", () => {
  const rt = createRuntime({});
  const noop = (id: string) => ({ toolCallId: id, isError: false, success: false, noop: true });

  let r = rt.noteCompressOutcomes("u1", [noop("t0")]);
  assert.equal(r.count, 1);

  r = rt.noteCompressOutcomes("u1", [noop("t0"), noop("t1")]);
  assert.equal(r.count, 2);

  r = rt.noteCompressOutcomes("u1", [noop("t0"), noop("t1"), noop("t2")]);
  assert.equal(r.count, 3);
  assert.equal(r.cappedNow, true);
  assert.equal(rt.compressRetryCappedFor("u1"), true, "capped state is queryable per turn");
  assert.equal(rt.compressRetryCappedFor("u2"), false, "other turns are unaffected");

  const success = (id: string) => ({ toolCallId: id, isError: false, success: true, noop: false });
  r = rt.noteCompressOutcomes("u1", [noop("t0"), noop("t1"), noop("t2"), success("ts")]);
  assert.equal(r.count, 0, "genuine success lifts the cap");
  assert.equal(rt.compressRetryCappedFor("u1"), false);
});

test("emergency nudge stops re-injecting once the turn's cap is burned (issue #6 loop breaker)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-emerg.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  // ~270K tokens of sent view vs a 180K window → kernel goes EMERGENCY and
  // the nudge re-injects on every context fire (dedup bypass).
  const MID = "lorem ".repeat(3000);
  const roleMsg = (id: string, role: string, text: string) => ({
    type: "message", id, parentId: null, timestamp: "",
    message: { role, content: text, timestamp: Date.now() },
  });
  let entries: any[] = [roleMsg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 59; i++) entries.push(roleMsg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const ctx = fakeCtx(() => entries, stateFile);
  const nudgeCount = (r: any) =>
    (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached/.test(JSON.stringify(m.content))).length;

  const r0 = await fire(handlers, ctx);
  assert.ok(nudgeCount(r0) >= 1, "emergency nudge fires on real overflow");
  assert.equal(retryMsgs(r0).length, 0);

  // model "answers" each emergency nudge with a no-op compress (stale refs)
  for (let i = 1; i <= 3; i++) {
    entries = [...entries, toolResultMsg(`ec${i}`, `call_${i}`, NOOP_PANEL, false)];
    await fire(handlers, ctx);
  }
  const rCapped = await fire(handlers, ctx);
  assert.equal(nudgeCount(rCapped), 0, "cap burned → emergency nudge no longer re-injects");
  assert.equal(retryMsgs(rCapped).length, 0, "no retry prompt either");

  // a genuine success lifts the cap → emergency guidance resumes
  entries = [...entries, toolResultMsg("ec4", "call_4", SUCCESS_PANEL, false)];
  const rRe = await fire(handlers, ctx);
  assert.ok(nudgeCount(rRe) >= 1, "after a successful compress the emergency nudge may resume");
  await rm(`${stateFile}.acp.json`, { force: true });
});
