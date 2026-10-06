import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CompressionState, type CoreMessage } from "acp-kernel";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AsyncCompressor,
  applyAsyncRanges,
  asyncCarriers,
  asyncEnabledValue,
  forkPayload,
  rangesFromToolArgs,
  snapshotStaleReason,
  takeSnapshot,
  unsupportedPayloadReason,
} from "../src/async-compress.js";
import { coreOutToAgentMessages, entriesToCoreMessages, ASYNC_COMPRESS_CUSTOM_TYPE } from "../src/messages.js";
import { rebuildStateFromLog, hasCompressHistory } from "../src/state-rebuild.js";
import { sanitizeSummary } from "../src/summary-sanitize.js";

const TRIGGER_PAYLOAD = { messages: [
  { role: "user", content: "x" },
  { role: "assistant", content: [{ type: "tool_use", id: "trig", name: "compress", input: { content: [] } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "trig", content: "queued" }] },
] };

const TEXT = "lorem ipsum dolor sit amet ".repeat(200);
const SUMMARY = "older turns: repeated lorem ipsum exchanges between user and assistant, nothing decided";

function entry(id: string, role: string, text: string): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: 0 } } as unknown as SessionEntry;
}

function history(n: number, prefix = "e"): SessionEntry[] {
  return Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`, i % 2 ? "assistant" : "user", `${prefix}${i} ${TEXT}`));
}

const core = createCore();
const config = defaultConfig(200_000);

function turnOn(view: CoreMessage[], state: CompressionState) {
  return core.processTurn({ messages: view, state, config, tokenCount: 10_000 });
}

test("forkPayload appends exactly one native user turn per supported wire and never mutates the captured payload", () => {
  const anthropic = { messages: [{ role: "user", content: "a" }], system: [{ type: "text", text: "S" }] };
  const frozen = structuredClone(anthropic);
  assert.deepEqual(forkPayload("anthropic-messages", anthropic, "N"), { ...frozen, messages: [...frozen.messages, { role: "user", content: [{ type: "text", text: "N" }] }] });
  assert.deepEqual(anthropic, frozen);
  assert.deepEqual((forkPayload("openai-completions", { messages: [{ role: "user", content: "a" }] }, "N") as { messages: unknown[] }).messages[1], { role: "user", content: [{ type: "text", text: "N" }] });
  assert.deepEqual((forkPayload("openai-responses", { input: [{ role: "user", content: "a" }] }, "N") as { input: unknown[] }).input[1], { role: "user", content: [{ type: "input_text", text: "N" }] });
});

test("unsupportedPayloadReason: unsupported wires and server-side conversation state fail closed", () => {
  assert.equal(unsupportedPayloadReason("google-generative-ai", { contents: [] }), "unsupported-api:google-generative-ai");
  assert.equal(unsupportedPayloadReason("azure-openai-responses", { input: [1] }), "unsupported-api:azure-openai-responses");
  assert.equal(unsupportedPayloadReason("openai-codex-responses", { input: [1], store: false }), null);
  assert.equal(unsupportedPayloadReason("openai-codex-responses", { input: [1], previous_response_id: "r" }), "server-state:previous_response_id");
  assert.deepEqual((forkPayload("openai-codex-responses", { input: [{ role: "user", content: "a" }] }, "N") as { input: unknown[] }).input[1], { role: "user", content: [{ type: "input_text", text: "N" }] });
  assert.equal(unsupportedPayloadReason("openai-responses", { input: [1], previous_response_id: "r" }), "server-state:previous_response_id");
  assert.equal(unsupportedPayloadReason("openai-responses", { input: [1], conversation: "c" }), "server-state:conversation");
  assert.equal(unsupportedPayloadReason("anthropic-messages", { messages: [1], context_management: {} }), "server-state:context_management");
  assert.equal(unsupportedPayloadReason("anthropic-messages", { messages: [] }), "payload-shape");
  assert.equal(unsupportedPayloadReason("anthropic-messages", "raw"), "payload-not-object");
  assert.equal(unsupportedPayloadReason("openai-completions", { messages: [1] }), null);
  assert.throws(() => forkPayload("anthropic-messages", { messages: [] }, "N"), /payload-shape/);
});

test("rangesFromToolArgs: array + stringified content, sanitizes summaries, rejects garbage", () => {
  const raw = "caf\\u00e9 \\u00e9t\\u00e9 summary \\u4e2d\\u6587";
  const arr = rangesFromToolArgs({ topic: "T", content: [{ startId: "m00001", endId: "m00002", summary: raw }] });
  assert.deepEqual(arr, [{ startRef: "m00001", endRef: "m00002", summary: sanitizeSummary(raw).text, topic: "T" }]);
  const str = rangesFromToolArgs({ content: JSON.stringify([{ startId: "m00003", endId: "m00004", summary: "s" }]), summaryMaxChars: 9000 });
  assert.deepEqual(str, [{ startRef: "m00003", endRef: "m00004", summary: "s", summaryMaxChars: 9000 }]);
  assert.equal(typeof rangesFromToolArgs(null), "string");
  assert.equal(typeof rangesFromToolArgs({ content: 7 }), "string");
  assert.equal(typeof rangesFromToolArgs({ content: [] }), "string");
});

test("asyncEnabledValue: only literal true enables; non-boolean warns and stays off", () => {
  const warned: unknown[] = [];
  assert.equal(asyncEnabledValue(undefined, (v) => warned.push(v)), false);
  assert.equal(asyncEnabledValue(false, (v) => warned.push(v)), false);
  assert.equal(asyncEnabledValue(true, (v) => warned.push(v)), true);
  assert.equal(asyncEnabledValue("true", (v) => warned.push(v)), false);
  assert.deepEqual(warned, ["true"]);
});

function snapshotFixture() {
  const entries = history(30);
  const view = entriesToCoreMessages(entries);
  const first = turnOn(view, createInitialState());
  const snapshot = takeSnapshot(view, first.state);
  return { entries, view, state: first.state, snapshot };
}

test("snapshot validation: prefix, block set and ref bindings", () => {
  const { entries, view, state, snapshot } = snapshotFixture();
  const ranges = [{ startRef: "m00002", endRef: "m00008", summary: SUMMARY }];
  assert.equal(snapshotStaleReason(snapshot, view, state, ranges), null);
  const grown = entriesToCoreMessages([...entries, entry("x", "user", "more")]);
  assert.equal(snapshotStaleReason(snapshot, grown, state, ranges), null, "appended history keeps the snapshot valid");
  assert.equal(snapshotStaleReason(snapshot, view.slice(0, 10), state, ranges), "view-shrank");
  const branched = entriesToCoreMessages([...entries.slice(0, 5), ...history(25, "b")]);
  assert.equal(snapshotStaleReason(snapshot, branched, state, ranges), "view-prefix-changed");
  const rebound = structuredClone(state);
  rebound.messageRefs.byRef.m00002 = "other";
  assert.equal(snapshotStaleReason(snapshot, view, rebound, ranges), "ref-rebound:m00002");
  const withBlock = core.applyCompression({ ranges: [{ startRef: "m00010", endRef: "m00012", summary: SUMMARY }], messages: turnOn(view, state).messages, state, config }).state;
  assert.equal(snapshotStaleReason(snapshot, view, withBlock, ranges), "blocks-changed", "a compress that landed meanwhile invalidates the result");
});

test("applyAsyncRanges is all-or-nothing and never mutates the live state", () => {
  const { view, state, snapshot } = snapshotFixture();
  const frozen = structuredClone(state);
  const ok = applyAsyncRanges({ core, view, state, config, tokenCount: 10_000, snapshot, ranges: [{ startRef: "m00002", endRef: "m00008", summary: SUMMARY }], callId: "acp-bg-1" });
  assert.equal(ok.ok, true);
  assert.deepEqual(state, frozen, "success path does not mutate input");
  if (ok.ok) {
    assert.equal(ok.newBlocks.length, 1);
    assert.equal(ok.newBlocks[0]!.compressCallId, "acp-bg-1");
  }
  const partial = applyAsyncRanges({ core, view, state, config, tokenCount: 10_000, snapshot, ranges: [
    { startRef: "m00002", endRef: "m00004", summary: SUMMARY },
    { startRef: "m00028", endRef: "m00030", summary: SUMMARY },
  ], callId: "acp-bg-2" });
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.kind, "invalid");
  assert.deepEqual(state, frozen, "rejected batch leaves state untouched");
  const short = applyAsyncRanges({ core, view, state, config, tokenCount: 10_000, snapshot, ranges: [{ startRef: "m00002", endRef: "m00004", summary: "too short" }], callId: "acp-bg-3" });
  assert.equal(short.ok, false);
  assert.deepEqual(state, frozen);
});

test("carrier: only async blocks get a summary message; sync summaries stay skipped; refolded async block loses its carrier", () => {
  const { entries, view, state, snapshot } = snapshotFixture();
  const applied = applyAsyncRanges({ core, view, state, config, tokenCount: 10_000, snapshot, ranges: [{ startRef: "m00002", endRef: "m00008", summary: SUMMARY, topic: "old" }], callId: "acp-bg-1" });
  assert.ok(applied.ok);
  if (!applied.ok) return;
  const turn = turnOn(view, applied.state);
  const originals = new Map(entries.map((e) => [e.id, (e as { message: never }).message]));
  const carriers = asyncCarriers(turn.state);
  assert.equal(carriers.size, 1);
  const out = coreOutToAgentMessages(turn.messages, originals, carriers);
  const carrierMsgs = out.filter((m) => JSON.stringify((m as { content: unknown }).content).includes("[ACP async compression:"));
  assert.equal(carrierMsgs.length, 1);
  assert.match(JSON.stringify((carrierMsgs[0] as { content: unknown }).content), /\[Compressed conversation section\] — old\\nolder turns/);
  assert.equal(coreOutToAgentMessages(turn.messages, originals).filter((m) => JSON.stringify((m as { content: unknown }).content).includes("Compressed conversation section")).length, 0, "without carriers (sync blocks) summaries stay skipped");

  const refold = core.applyCompression({ ranges: [{ startRef: "b1", endRef: "b1", summary: `${SUMMARY} (refolded)` }], messages: turn.messages, state: turn.state, config });
  const after = turnOn(view, refold.state);
  assert.deepEqual(refold.result.errors, []);
  assert.equal(refold.result.blocksCreated, 1, "a sync compress can refold the async block by its block id");
  assert.ok(refold.state.blocks.filter((b) => b.active).every((b) => b.blockId !== "b1"), "b1 is inactive after the refold");
  assert.equal(asyncCarriers(after.state).size, 0, "refolded (sync) parent carries the summary via its compress call; no async carrier remains");
});

test("replay: async records and sync compress calls interleave in log order", () => {
  const msgs = history(40);
  const view30 = entriesToCoreMessages(msgs.slice(0, 30));
  const first = turnOn(view30, createInitialState());
  const asyncRanges = [{ startRef: "m00002", endRef: "m00006", summary: SUMMARY, topic: "async" }];
  const asyncRecord = { type: "custom", id: "c1", parentId: null, timestamp: "", customType: ASYNC_COMPRESS_CUSTOM_TYPE, data: { version: 1, callId: "acp-bg-x", ranges: asyncRanges, text: "t" } } as unknown as SessionEntry;
  const syncCall = { type: "message", id: "a1", parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", name: "compress", id: "call-sync", arguments: { content: [{ startId: "m00010", endId: "m00014", summary: SUMMARY }] } }], timestamp: 0 } } as unknown as SessionEntry;
  const syncResult = { type: "message", id: "r1", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "compress", toolCallId: "call-sync", content: "▣ ACP | ok", isError: false, timestamp: 0 } } as unknown as SessionEntry;
  const log = [...msgs.slice(0, 30), asyncRecord, ...msgs.slice(30, 35), syncCall, syncResult, ...msgs.slice(35)];
  assert.equal(hasCompressHistory([...msgs, asyncRecord]), true, "an async record alone marks compress history");
  const rebuilt = rebuildStateFromLog({ entries: log, state: createInitialState(), config, core });
  assert.equal(rebuilt.report.callsApplied, 2);
  const [b1, b2] = rebuilt.state.blocks;
  assert.equal(b1!.compressCallId, "acp-bg-x", "async record replayed first (log order)");
  assert.equal(b2!.compressCallId, "call-sync");
  const live = core.applyCompression({ ranges: asyncRanges.map((r) => ({ ...r, compressCallId: "acp-bg-x" })), messages: first.messages, state: first.state, config });
  assert.deepEqual(b1!.directMessageIds, live.state.blocks[0]!.directMessageIds, "replay folds the same messages as the live apply");
  assert.equal(b1!.summary, live.state.blocks[0]!.summary);
});

test("AsyncCompressor: 5-minute style hard timeout aborts the fork and falls back to sync", async () => {
  let aborted = false;
  const provider = {
    streamSimple: (_m: unknown, _c: unknown, o: { signal: AbortSignal }) => ({
      result: () => new Promise((resolve) => {
        o.signal.addEventListener("abort", () => { aborted = true; resolve({ role: "assistant", content: [], stopReason: "aborted" }); });
      }),
    }),
  };
  const notes: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => "timeout" },
    modelRegistry: { getProvider: () => provider, getProviderAuth: async () => undefined },
  } as unknown as ExtensionContext;
  const pi = { appendEntry: () => {}, getThinkingLevel: () => "high", getActiveTools: () => [], getAllTools: () => [] } as unknown as ConstructorParameters<typeof AsyncCompressor>[0]["pi"];
  const c = new AsyncCompressor({ pi, timeoutMs: 30 });
  c.start("timeout", { nudgeText: "n", snapshot: takeSnapshot([], createInitialState()), model: { api: "anthropic-messages", provider: "anthropic", id: "m" } as unknown as NonNullable<ExtensionContext["model"]>, triggerCallId: "trig" });
  c.onPayload("timeout", TRIGGER_PAYLOAD, ctx);
  c.onResponse("timeout", 200, ctx);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(aborted, true);
  assert.equal(c.isActive("timeout"), false);
  assert.equal(c.fallbackReason("timeout"), "fork-timeout");
  assert.equal(notes.length, 1, "one notify per session");
});

test("host floor: an async record after the usage anchor marks it stale and credits the reclaimed tokens", async () => {
  const { compressionAnchorStaleness } = await import("../src/floor-stale.js");
  const anchor = { type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 90_000, output: 100 } } };
  const record = { type: "custom", customType: ASYNC_COMPRESS_CUSTOM_TYPE, data: { callId: "acp-bg-z" } };
  const block = { blockId: "b1", runId: "r", tier: 1, summary: "s", directMessageIds: [], effectiveMessageIds: ["x"], directBlockIds: [], compressedTokens: 20_000, createdAt: 0, survivedCount: 0, generation: "young", active: true, compressCallId: "acp-bg-z" } as const;
  const before = compressionAnchorStaleness([anchor], [block], (t) => t.length);
  assert.equal(before.predates, false);
  assert.equal(before.netReclaimed, 0);
  const after = compressionAnchorStaleness([anchor, record], [block], (t) => t.length);
  assert.equal(after.predates, true);
  assert.equal(after.netReclaimed, 19_999);
});

async function readyCompressor(sid: string, ranges: unknown, snapshot: ReturnType<typeof takeSnapshot>) {
  const provider = { streamSimple: () => ({ result: async () => ({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "compress", arguments: { content: ranges } }], stopReason: "toolUse" }) }) };
  const ctx = {
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => sid },
    modelRegistry: { getProvider: () => provider, getProviderAuth: async () => undefined },
    model: { api: "anthropic-messages", provider: "anthropic", id: "m" },
  } as unknown as ExtensionContext;
  const pi = { appendEntry: () => {}, getThinkingLevel: () => "off", getActiveTools: () => [], getAllTools: () => [] } as unknown as ConstructorParameters<typeof AsyncCompressor>[0]["pi"];
  const c = new AsyncCompressor({ pi });
  c.start(sid, { nudgeText: "n", snapshot, model: ctx.model!, triggerCallId: "trig" });
  c.onPayload(sid, TRIGGER_PAYLOAD, ctx);
  c.onResponse(sid, 200, ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.phase(sid), "ready");
  return { c, ctx };
}

test("apply ordering: record append → sidecar save → adopt; append failure never saves, save failure surfaces after the record exists", async () => {
  const { applyReadyAsyncResult } = await import("../src/async-compress.js");
  const { entries, view, state, snapshot } = snapshotFixture();
  const ranges = [{ startId: "m00002", endId: "m00008", summary: SUMMARY }];

  const ok = await readyCompressor("order-ok", ranges, snapshot);
  const calls: string[] = [];
  const applied = await applyReadyAsyncResult({
    compressor: ok.c, ctx: ok.ctx, enabled: true, core, config, view, state, entries: entries as never,
    pi: { appendEntry: () => { calls.push("append"); } } as never,
    save: async () => { calls.push("save"); },
  });
  assert.ok(applied);
  assert.deepEqual(calls, ["append", "save"]);

  const appendFail = await readyCompressor("order-append-fail", ranges, snapshot);
  const calls2: string[] = [];
  const none = await applyReadyAsyncResult({
    compressor: appendFail.c, ctx: appendFail.ctx, enabled: true, core, config, view, state, entries: entries as never,
    pi: { appendEntry: () => { throw new Error("disk full"); } } as never,
    save: async () => { calls2.push("save"); },
  });
  assert.equal(none, undefined, "result discarded");
  assert.deepEqual(calls2, [], "state never persisted without its record");
  assert.equal(appendFail.c.fallbackReason("order-append-fail"), "record-append-failed");

  const saveFail = await readyCompressor("order-save-fail", ranges, snapshot);
  const calls3: string[] = [];
  await assert.rejects(applyReadyAsyncResult({
    compressor: saveFail.c, ctx: saveFail.ctx, enabled: true, core, config, view, state, entries: entries as never,
    pi: { appendEntry: () => { calls3.push("append"); } } as never,
    save: async () => { throw new Error("EACCES"); },
  }), /EACCES/, "a throwing save surfaces instead of being swallowed");
  assert.deepEqual(calls3, ["append"], "the durable record already exists; recoverPendingAsyncRecords restores the block on the next stateFor");
});

function bareCtx(sid: string, registry: Record<string, unknown>): ExtensionContext {
  return {
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => sid },
    modelRegistry: registry,
  } as unknown as ExtensionContext;
}

const barePi = { appendEntry: () => {}, getThinkingLevel: () => "off", getActiveTools: () => [], getAllTools: () => [] } as unknown as ConstructorParameters<typeof AsyncCompressor>[0]["pi"];
const anthropicModel = { api: "anthropic-messages", provider: "anthropic", id: "m" } as unknown as NonNullable<ExtensionContext["model"]>;

test("deadline settles the coordinator even when auth/provider never settle and ignore abort", async () => {
  const never = new Promise<never>(() => {});
  const ctx = bareCtx("never", { getProvider: () => ({ streamSimple: () => ({ result: () => never }) }), getProviderAuth: () => never });
  const c = new AsyncCompressor({ pi: barePi, timeoutMs: 25 });
  c.start("never", { nudgeText: "n", snapshot: takeSnapshot([], createInitialState()), model: anthropicModel, triggerCallId: "trig" });
  c.onPayload("never", TRIGGER_PAYLOAD, ctx);
  c.onResponse("never", 200, ctx);
  assert.equal(c.phase("never"), "running");
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(c.isActive("never"), false, "job cleared from the coordinator");
  assert.equal(c.fallbackReason("never"), "fork-timeout");
});

test("fork errors are logged without their message (provider text can carry credentials)", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "acp-async-redact-"));
  const prev = process.env.ACP_LOG_FILE;
  process.env.ACP_LOG_FILE = join(dir, "acp.log");
  try {
    const secret = "sk-live-SECRET-123 x-api-key: hunter2";
    const ctx = bareCtx("redact", { getProvider: () => ({ streamSimple: () => ({ result: async () => { throw new Error(`401 Unauthorized ${secret}`); } }) }), getProviderAuth: async () => ({ auth: { apiKey: "sk-live-SECRET-123" } }) });
    const c = new AsyncCompressor({ pi: barePi });
    c.start("redact", { nudgeText: "n", snapshot: takeSnapshot([], createInitialState()), model: anthropicModel, triggerCallId: "trig" });
    c.onPayload("redact", TRIGGER_PAYLOAD, ctx);
    c.onResponse("redact", 200, ctx);
    await new Promise((r) => setTimeout(r, 20));
    const log = await readFile(join(dir, "acp.log"), "utf8");
    assert.match(log, /event=fork-threw .*errorKind=Error/);
    assert.ok(!log.includes("SECRET") && !log.includes("hunter2"), "no provider error text in the log");
    assert.equal(c.fallbackReason("redact"), "fork-error");
  } finally {
    if (prev === undefined) delete process.env.ACP_LOG_FILE;
    else process.env.ACP_LOG_FILE = prev;
  }
});

test("model and tool definitions are frozen when the job starts", async () => {
  let seen: { model?: { id: string }; tools?: Array<{ name: string }> } = {};
  const provider = { streamSimple: (m: { id: string }, c: { tools: Array<{ name: string }> }) => { seen = { model: m, tools: c.tools }; return { result: async () => ({ role: "assistant", content: [], stopReason: "stop" }) }; } };
  const ctx = bareCtx("frozen", { getProvider: () => provider, getProviderAuth: async () => undefined });
  let active = ["compress"];
  const pi = { appendEntry: () => {}, getThinkingLevel: () => "off", getActiveTools: () => active, getAllTools: () => [{ name: "compress", description: "c", parameters: {} }, { name: "bash", description: "b", parameters: {} }] } as unknown as ConstructorParameters<typeof AsyncCompressor>[0]["pi"];
  const model = { api: "anthropic-messages", provider: "anthropic", id: "m-original" };
  const c = new AsyncCompressor({ pi });
  c.start("frozen", { nudgeText: "n", snapshot: takeSnapshot([], createInitialState()), model: model as unknown as NonNullable<ExtensionContext["model"]>, triggerCallId: "trig" });
  model.id = "m-mutated";
  active = ["bash"];
  c.onPayload("frozen", TRIGGER_PAYLOAD, ctx);
  c.onResponse("frozen", 200, ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.model?.id, "m-original");
  assert.deepEqual(seen.tools?.map((t) => t.name), ["compress"]);
});

test("recoverPendingAsyncRecords: re-applies a record missing from a non-empty state, once per process", async () => {
  const { recoverPendingAsyncRecords } = await import("../src/state-rebuild.js");
  const { entries, view, state } = snapshotFixture();
  const existing = core.applyCompression({ ranges: [{ startRef: "m00002", endRef: "m00004", summary: SUMMARY, compressCallId: "acp-bg-a" }], messages: turnOn(view, state).messages, state, config }).state;
  const record = (callId: string, startRef: string, endRef: string) => ({ type: "custom", id: callId, parentId: null, timestamp: "", customType: ASYNC_COMPRESS_CUSTOM_TYPE, data: { version: 1, callId, ranges: [{ startRef, endRef, summary: SUMMARY }], text: "t" } }) as unknown as SessionEntry;
  const log = [...entries, record("acp-bg-a", "m00002", "m00004"), record("acp-bg-b", "m00010", "m00014")];
  const attempted = new Set<string>();
  const out = recoverPendingAsyncRecords({ entries: log, view, state: existing, config, core, attempted });
  assert.ok(out);
  assert.equal(out.report.callsApplied, 1, "only the record whose block is missing");
  assert.deepEqual(out.state.blocks.map((b) => b.compressCallId), ["acp-bg-a", "acp-bg-b"]);
  assert.equal(recoverPendingAsyncRecords({ entries: log, view, state: existing, config, core, attempted }), null, "not retried in the same process");
  const bad = [...entries, record("acp-bg-c", "m00028", "m00030")];
  const skipped = recoverPendingAsyncRecords({ entries: bad, view, state: existing, config, core, attempted: new Set() });
  assert.equal(skipped?.report.callsApplied, 0);
  assert.equal(skipped?.state, existing, "unappliable record leaves state untouched");
});

test("in-place refolds of inline-restored blocks are rejected all-or-nothing (sync- and async-origin, mixed batch)", () => {
  for (const origin of ["call-sync", "acp-bg-old"]) {
    const { view, state } = snapshotFixture();
    const folded = core.applyCompression({ ranges: [{ startRef: "m00002", endRef: "m00006", summary: SUMMARY, compressCallId: origin }], messages: turnOn(view, state).messages, state, config }).state;
    folded.blocks[0]!.restoredInline = true;
    const snapshot = takeSnapshot(view, folded);
    const frozen = structuredClone(folded);
    const refoldOnly = applyAsyncRanges({ core, view, state: folded, config, tokenCount: 10_000, snapshot, ranges: [{ startRef: "m00002", endRef: "m00006", summary: `${SUMMARY} (refined)` }], callId: "acp-bg-new" });
    assert.equal(refoldOnly.ok, false, `${origin}: refold rejected`);
    if (!refoldOnly.ok) assert.equal(refoldOnly.kind, "refold");
    const mixed = applyAsyncRanges({ core, view, state: folded, config, tokenCount: 10_000, snapshot, ranges: [
      { startRef: "m00010", endRef: "m00014", summary: SUMMARY },
      { startRef: "m00002", endRef: "m00006", summary: `${SUMMARY} (refined)` },
    ], callId: "acp-bg-new" });
    assert.equal(mixed.ok, false, `${origin}: mixed batch rejected as a whole`);
    if (!mixed.ok) assert.equal(mixed.kind, "refold");
    assert.deepEqual(folded, frozen, "state untouched");
    // Control: the kernel really would refold in place keeping the OLD callId.
    const direct = core.applyCompression({ ranges: [{ startRef: "m00002", endRef: "m00006", summary: `${SUMMARY} (refined)`, compressCallId: "acp-bg-new" }], messages: turnOn(view, folded).messages, state: folded, config }).state;
    assert.equal(direct.blocks[0]!.blockId, "b1");
    assert.equal(direct.blocks[0]!.compressCallId, origin, "kernel keeps the original callId on an in-place refold");
  }
});

test("recovery never overwrites a newer covering block: blocked overlap and in-place-refold overlap are both skipped with state deep-equal to input", async () => {
  const { recoverPendingAsyncRecords } = await import("../src/state-rebuild.js");
  const { entries, view, state } = snapshotFixture();
  const newer = core.applyCompression({ ranges: [{ startRef: "m00002", endRef: "m00008", summary: `${SUMMARY} — NEWER`, compressCallId: "call-newer" }], messages: turnOn(view, state).messages, state, config }).state;
  const record = { type: "custom", id: "rec", parentId: null, timestamp: "", customType: ASYNC_COMPRESS_CUSTOM_TYPE, data: { version: 1, callId: "acp-bg-old", ranges: [{ startRef: "m00002", endRef: "m00008", summary: `${SUMMARY} — OLD` }], text: "t" } } as unknown as SessionEntry;
  for (const restoredInline of [false, true]) {
    const current = structuredClone(newer);
    current.blocks[0]!.restoredInline = restoredInline;
    const frozen = structuredClone(current);
    const out = recoverPendingAsyncRecords({ entries: [...entries, record], view, state: current, config, core, attempted: new Set() });
    assert.ok(out, `restoredInline=${restoredInline}: record considered`);
    assert.equal(out.report.callsApplied, 0, `restoredInline=${restoredInline}: skipped`);
    assert.deepEqual(out.state, frozen, "returned state deep-equals the input");
    assert.deepEqual(current, frozen, "input not mutated");
    assert.match(out.state.blocks[0]!.summary, /NEWER/);
    if (restoredInline) assert.ok(out.report.errors.includes("in-place refold"), "skipped by the refold guard, not by luck");
  }
});

test("live apply of a refold result: nothing recorded or saved, next nudge goes sync, async stays enabled", async () => {
  const { applyReadyAsyncResult } = await import("../src/async-compress.js");
  const { entries, view, state } = snapshotFixture();
  const folded = core.applyCompression({ ranges: [{ startRef: "m00002", endRef: "m00006", summary: SUMMARY, compressCallId: "call-sync" }], messages: turnOn(view, state).messages, state, config }).state;
  folded.blocks[0]!.restoredInline = true;
  const { c, ctx } = await readyCompressor("refold-live", [{ startId: "m00002", endId: "m00006", summary: `${SUMMARY} (refined)` }], takeSnapshot(view, folded));
  const calls: string[] = [];
  const out = await applyReadyAsyncResult({
    compressor: c, ctx, core, config, view, state: folded, entries: entries as never, enabled: true,
    pi: { appendEntry: () => { calls.push("append"); } } as never,
    save: async () => { calls.push("save"); },
  });
  assert.equal(out, undefined);
  assert.deepEqual(calls, []);
  assert.equal(c.takeSyncRetry("refold-live"), true, "next nudge handed to the sync path");
  assert.equal(c.fallbackReason("refold-live"), undefined, "no session-wide fallback");
});

test("malformed or unknown-version async records are ignored everywhere without throwing", async () => {
  const { recoverPendingAsyncRecords } = await import("../src/state-rebuild.js");
  const { entries, view, state } = snapshotFixture();
  const good = { startRef: "m00002", endRef: "m00008", summary: SUMMARY };
  const bad = [null, "x", {}, { version: 2, callId: "acp-bg-v2", ranges: [good] }, { callId: "acp-bg-nov", ranges: [good] }, { version: 1, callId: "acp-bg-null", ranges: [null] }, { version: 1, callId: "acp-bg-str", ranges: ["m00002"] }, { version: 1, callId: "not-bg", ranges: [good] }, { version: 1, callId: "acp-bg-empty", ranges: [] }]
    .map((data, i) => ({ type: "custom", id: `bad${i}`, parentId: null, timestamp: "", customType: ASYNC_COMPRESS_CUSTOM_TYPE, data }) as unknown as SessionEntry);
  const log = [...entries, ...bad];
  assert.equal(hasCompressHistory(log), false, "malformed records alone are not compress history");
  const rebuilt = rebuildStateFromLog({ entries: log, state: createInitialState(), config, core });
  assert.equal(rebuilt.report.callsApplied, 0);
  assert.equal(rebuilt.state.blocks.length, 0);
  const withBlock = core.applyCompression({ ranges: [{ startRef: "m00012", endRef: "m00014", summary: SUMMARY, compressCallId: "call-x" }], messages: turnOn(view, state).messages, state, config }).state;
  assert.equal(recoverPendingAsyncRecords({ entries: log, view, state: withBlock, config, core, attempted: new Set() }), null);
});

test("auth resolving after cancellation never starts the transport", async () => {
  let resolveAuth!: (v: unknown) => void;
  let transportStarted = false;
  const ctx = bareCtx("late-auth", {
    getProvider: () => ({ streamSimple: () => { transportStarted = true; return { result: async () => ({ role: "assistant", content: [], stopReason: "stop" }) }; } }),
    getProviderAuth: () => new Promise((r) => { resolveAuth = r; }),
  });
  const c = new AsyncCompressor({ pi: barePi });
  c.start("late-auth", { nudgeText: "n", snapshot: takeSnapshot([], createInitialState()), model: anthropicModel, triggerCallId: "trig" });
  c.onPayload("late-auth", TRIGGER_PAYLOAD, ctx);
  c.onResponse("late-auth", 200, ctx);
  await new Promise((r) => setTimeout(r, 5));
  c.cancel("late-auth", "session-switch");
  resolveAuth({ auth: { apiKey: "k" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(transportStarted, false);

  let resolveAuth2!: (v: unknown) => void;
  let started2 = false;
  const ctx2 = bareCtx("late-auth-timeout", {
    getProvider: () => ({ streamSimple: () => { started2 = true; return { result: async () => ({ role: "assistant", content: [], stopReason: "stop" }) }; } }),
    getProviderAuth: () => new Promise((r) => { resolveAuth2 = r; }),
  });
  const c2 = new AsyncCompressor({ pi: barePi, timeoutMs: 15 });
  c2.start("late-auth-timeout", { nudgeText: "n", snapshot: takeSnapshot([], createInitialState()), model: anthropicModel, triggerCallId: "trig" });
  c2.onPayload("late-auth-timeout", TRIGGER_PAYLOAD, ctx2);
  c2.onResponse("late-auth-timeout", 200, ctx2);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c2.fallbackReason("late-auth-timeout"), "fork-timeout");
  resolveAuth2({ auth: { apiKey: "k" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(started2, false, "late auth after the deadline does not start the transport");
});

// The main agent was told "queued": every way a job ends without applying owes
// exactly one sync nudge, with the reason; only a sync fold, a replacing job or
// a session reset owe none.
test("every exit of an accepted job that does not apply owes one sync retry with its reason", async () => {
  const forkReply = (reply: () => Promise<unknown>) => ({ getProvider: () => ({ streamSimple: () => ({ result: reply }) }), getProviderAuth: async () => undefined });
  const never = new Promise<never>(() => {});
  async function exit(name: string, registry: Record<string, unknown>, drive: (c: AsyncCompressor, ctx: ExtensionContext) => void | Promise<void>, timeoutMs = 1_000) {
    const ctx = bareCtx(name, registry);
    const c = new AsyncCompressor({ pi: barePi, timeoutMs });
    c.start(name, { nudgeText: "n", snapshot: takeSnapshot([], createInitialState()), model: anthropicModel, triggerCallId: "trig" });
    await drive(c, ctx);
    await new Promise((r) => setTimeout(r, 40));
    const out = { active: c.isActive(name), retry: c.takeSyncRetry(name), reason: c.takeRetryReason(name), again: c.takeSyncRetry(name) };
    c.resetSession(name);
    return out;
  }
  const launched = (c: AsyncCompressor, ctx: ExtensionContext) => { c.onPayload(ctx.sessionManager.getSessionId(), TRIGGER_PAYLOAD, ctx); c.onResponse(ctx.sessionManager.getSessionId(), 200, ctx); };
  const cases: Array<[string, Record<string, unknown>, (c: AsyncCompressor, ctx: ExtensionContext) => void | Promise<void>, string, number?]> = [
    ["timeout", forkReply(() => never), launched, "fork-timeout", 15],
    ["threw", forkReply(async () => { throw new Error("boom"); }), launched, "fork-threw"],
    ["error", forkReply(async () => ({ role: "assistant", content: [], stopReason: "error" })), launched, "fork-error"],
    ["invalid-args", forkReply(async () => ({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "compress", arguments: { content: "garbage" } }], stopReason: "toolUse" })), launched, "fork-invalid-args"],
    ["no-call", forkReply(async () => ({ role: "assistant", content: [{ type: "text", text: "no" }], stopReason: "stop" })), launched, "fork-no-compress-call"],
    ["unsupported-capture", forkReply(() => never), (c, ctx) => c.onPayload("unsupported-capture", { ...TRIGGER_PAYLOAD, context_management: {} }, ctx), "capture:"],
    ["trigger-missing", forkReply(() => never), (c, ctx) => c.onPayload("trigger-missing", { messages: [{ role: "user", content: "x" }] }, ctx), "capture:trigger-missing"],
    ["main-429", forkReply(() => never), (c, ctx) => { c.onPayload("main-429", TRIGGER_PAYLOAD, ctx); c.onResponse("main-429", 429, ctx); }, "main-request-status:429"],
    ["main-aborted-running", forkReply(() => never), (c, ctx) => { launched(c, ctx); c.onMainFailed("main-aborted-running", "main-aborted", true); }, "main-aborted"],
    ["model-select", forkReply(() => never), (c) => c.cancel("model-select", "model-select"), "model-select"],
  ];
  for (const [name, registry, drive, reason, timeoutMs] of cases) {
    const out = await exit(name, registry, drive, timeoutMs);
    assert.equal(out.active, false, name);
    assert.equal(out.retry, true, `${name} owes a sync retry`);
    assert.ok(out.reason?.startsWith(reason), `${name}: reason ${out.reason}`);
    assert.equal(out.again, false, `${name}: owed once`);
  }
  for (const reason of ["superseded-by-sync-compress", "session-reset"]) {
    const out = await exit(`no-retry-${reason}`, forkReply(() => never), (c) => c.cancel(`no-retry-${reason}`, reason));
    assert.equal(out.retry, false, `${reason} owes nothing`);
  }
  const pending = new AsyncCompressor({ pi: barePi });
  pending.trigger("trigger-only", "trig");
  pending.cancel("trigger-only", "session-tree");
  assert.equal(pending.takeSyncRetry("trigger-only"), true, "a trigger cancelled before its job started owes the retry too");
});

test("apply-time failures owe one sync retry: invalid result and record append failure", async () => {
  const { applyReadyAsyncResult } = await import("../src/async-compress.js");
  const { entries, view, state, snapshot } = snapshotFixture();
  const bad = await readyCompressor("apply-invalid", [{ startId: "m00028", endId: "m00030", summary: SUMMARY }], snapshot);
  await applyReadyAsyncResult({ compressor: bad.c, ctx: bad.ctx, core, config, view, state, entries: entries as never, enabled: true, pi: { appendEntry: () => {} } as never, save: async () => {} });
  assert.equal(bad.c.takeSyncRetry("apply-invalid"), true);
  assert.equal(bad.c.takeRetryReason("apply-invalid"), "result-invalid");
  const lost = await readyCompressor("apply-append", [{ startId: "m00002", endId: "m00006", summary: SUMMARY }], snapshot);
  await applyReadyAsyncResult({ compressor: lost.c, ctx: lost.ctx, core, config, view, state, entries: entries as never, enabled: true, pi: { appendEntry: () => { throw new Error("disk full"); } } as never, save: async () => {} });
  assert.equal(lost.c.takeSyncRetry("apply-append"), true);
  assert.equal(lost.c.takeRetryReason("apply-append"), "record-append-failed");
});
