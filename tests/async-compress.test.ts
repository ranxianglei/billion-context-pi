import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { setRunNpmForTest } from "../src/update.js";
import { ASYNC_CALL_ID_PREFIX, ASYNC_COMPRESS_CUSTOM_TYPE, ACP_NUDGE_CUSTOM_TYPE } from "../src/messages.js";
import { ASYNC_ALREADY_QUEUED_TEXT, ASYNC_FORK_DIRECTIVE, ASYNC_NOTHING_TEXT, ASYNC_NUDGE_HINT, ASYNC_QUEUED_TEXT, ASYNC_SYSTEM_HINT } from "../src/async-compress.js";
import { usageAnchorPredatesCompression } from "../src/floor-stale.js";

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_UPDATE_THROTTLE_FILE = join(tmpdir(), `acp-test-async-compress-throttle-${process.pid}`);

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
  handlers: Map<string, Handler[]>;
  appended: Array<{ customType: string; data?: unknown }>;
  emit(event: string, payload: unknown): Promise<unknown>;
  ctx: ReturnType<typeof makeCtx>;
  entries: unknown[];
  forkCalls: Array<{ model: unknown; context: unknown; options: Record<string, unknown> }>;
  appendThrows: boolean;
  forkReply: () => unknown;
  tools: Map<string, { execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
  lastTrigger?: string;
}

const MID = "lorem ipsum dolor sit amet ".repeat(400);

function roleMsg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: role === "assistant"
    ? { role, content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 }
    : { role, content: text, timestamp: 1 } };
}

function baseEntries(n: number): unknown[] {
  const out: unknown[] = [roleMsg("u0", "user", "start " + MID)];
  for (let i = 1; i < n; i++) out.push(roleMsg(`e${i}`, i % 2 ? "assistant" : "user", `turn ${i} ` + MID));
  return out;
}

function makeCtx(h: { entries: unknown[] }, sid: string, stateFile: string, provider: unknown) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: tmpdir(),
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model", api: "anthropic-messages", provider: "anthropic" },
    getContextUsage: () => null,
    modelRegistry: {
      getProvider: () => provider,
      getProviderAuth: async () => ({ auth: { apiKey: "k" }, env: {} }),
    },
    sessionManager: {
      buildContextEntries: () => h.entries,
      getSessionId: () => sid,
      getSessionFile: () => stateFile,
    },
  };
}

async function harness(name: string, adapter: Record<string, unknown> = { compress: { async: true } }): Promise<Harness> {
  const stateFile = join(tmpdir(), `pai-acp-async-${name}-${process.pid}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });
  const handlers = new Map<string, Handler[]>();
  const h = { entries: baseEntries(40) } as Harness;
  h.appended = [];
  h.forkCalls = [];
  h.appendThrows = false;
  h.tools = new Map();
  h.forkReply = () => ({
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: "compress", arguments: { content: [{ startId: "m00002", endId: "m00010", summary: "early turns: repeated lorem ipsum exchanges between user and assistant, no decisions", topic: "early" }] } }],
    stopReason: "toolUse",
    usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 0 },
  });
  const provider = {
    streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => {
      h.forkCalls.push({ model, context, options });
      return { result: async () => h.forkReply() };
    },
  };
  const api = {
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool(tool: { name: string }) { h.tools.set(tool.name, tool as never); },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry(customType: string, data?: unknown) {
      if (h.appendThrows && customType === ASYNC_COMPRESS_CUSTOM_TYPE) throw new Error("disk full");
      h.appended.push({ customType, data });
      h.entries = [...h.entries, { type: "custom", id: `c${h.entries.length}`, parentId: null, timestamp: "", customType, data }];
    },
    getThinkingLevel: () => "off",
    getActiveTools: () => ["compress"],
    getAllTools: () => [{ name: "compress", description: "c", parameters: { type: "object", properties: {} } }],
  };
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false, ...adapter })(api as never);
  h.handlers = handlers;
  h.ctx = makeCtx(h, `async-${name}`, stateFile, provider);
  h.emit = async (event: string, payload: unknown) => {
    let last: unknown;
    for (const fn of handlers.get(event) ?? []) last = await fn({ type: event, ...(payload as object) }, h.ctx);
    return last;
  };
  return h;
}

function hasNudge(result: unknown): boolean {
  const msgs = (result as { messages?: Array<{ role: string; content: unknown }> })?.messages ?? [];
  return msgs.some((m) => m.role === "user" && /compress/i.test(JSON.stringify(m.content)) && /Compression|compress\(/.test(JSON.stringify(m.content)));
}

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// The request after compress({content: []}): history, the call, its "queued" result.
function triggerPayload(id: string) {
  return { model: "test-model", system: [{ type: "text", text: "SYS" }], messages: [
    { role: "user", content: "history" },
    { role: "assistant", content: [{ type: "tool_use", id, name: "compress", input: { content: [] } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "queued" }] },
  ] };
}

let triggerSeq = 0;

async function runCompress(h: Harness, id: string, params: unknown): Promise<string> {
  const result = await h.tools.get("compress")!.execute(id, params, undefined, undefined, h.ctx);
  return result.content[0]!.text;
}

// The main agent calls compress({content: []}); pi records the call and its result.
async function queue(h: Harness): Promise<{ id: string; text: string }> {
  const id = `trig${++triggerSeq}`;
  const text = await runCompress(h, id, { content: [] });
  h.entries = [...h.entries,
    { type: "message", id: `a-${id}`, parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id, name: "compress", arguments: { content: [] } }], api: "anthropic-messages", provider: "anthropic", model: "test-model", usage: USAGE, stopReason: "toolUse", timestamp: 1 } },
    { type: "message", id: `r-${id}`, parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: id, toolName: "compress", content: [{ type: "text", text }], isError: false, timestamp: 1 } }];
  h.lastTrigger = id;
  return { id, text };
}

// Queue, then the next request's context event starts the job.
async function startJob(h: Harness): Promise<unknown> {
  const q = await queue(h);
  assert.equal(q.text, ASYNC_QUEUED_TEXT);
  return h.emit("context", { messages: [] });
}

function grow(h: Harness, n = 20): void {
  const start = h.entries.length;
  for (let i = 0; i < n; i++) h.entries = [...h.entries, roleMsg(`g${start + i}`, i % 2 ? "assistant" : "user", `growth ${start + i} ` + MID)];
}

function endsWithNudge(result: unknown): boolean {
  const text = lastText(result);
  return /compress/i.test(text) && !/lorem ipsum/.test(text);
}

function messagesOf(result: unknown): Array<{ role: string; content: unknown }> {
  return (result as { messages: Array<{ role: string; content: unknown }> }).messages;
}

function lastText(result: unknown): string {
  const msgs = messagesOf(result);
  return JSON.stringify(msgs[msgs.length - 1]!.content);
}

const flush = () => new Promise((r) => setTimeout(r, 20));

async function sendMainRequest(h: Harness, status = 200): Promise<void> {
  await h.emit("before_provider_headers", { headers: { "x-session": "abc" } });
  await h.emit("before_provider_request", { payload: triggerPayload(h.lastTrigger ?? "none") });
  await h.emit("after_provider_response", { status, headers: {} });
  await flush();
}

test("default off: nudge stays in context, no fork, no async record (byte-identical sync path)", async () => {
  const h = await harness("off", {});
  const r = await h.emit("context", { messages: [] });
  assert.match(lastText(r), /efficiency nudge/);
  assert.ok(!lastText(r).includes("Background compression"), "no async hint");
  assert.equal(await runCompress(h, "off-empty", { content: [] }), "No ranges provided.", "empty compress keeps its sync reply");
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 0);
  assert.deepEqual(h.appended.map((a) => a.customType), [ACP_NUDGE_CUSTOM_TYPE]);
});

// Live o2-live-1: Sonnet over claude-bridge sent content as the JSON string "[]" (the schema's string form).
test("JSON-encoded empty content is the same empty call: sync reply when off, queued when on; malformed JSON still errors", async () => {
  const off = await harness("json-empty-off", {});
  await off.emit("context", { messages: [] });
  assert.equal(await runCompress(off, "off-json", { content: "[]" }), "No ranges provided.");
  assert.equal(await runCompress(off, "off-json2", { content: JSON.stringify("[ ]") }), "No ranges provided.", "double-encoded");
  await assert.rejects(runCompress(off, "off-bad", { content: "[" }), /Invalid compress content/);
  const on = await harness("json-empty-on");
  await on.emit("context", { messages: [] });
  assert.equal(await runCompress(on, "on-json", { content: "[]" }), ASYNC_QUEUED_TEXT);
});

test("async on: main sees the nudge, compress([]) queues, the fork replays the request carrying the queued result + directive + nudge, result applied at next request boundary with carrier", async () => {
  const h = await harness("apply");
  const r1 = await h.emit("context", { messages: [] });
  assert.match(lastText(r1), /efficiency nudge/, "main sees the nudge");
  assert.ok(lastText(r1).includes(ASYNC_NUDGE_HINT.slice(0, 40)), "with the async hint");
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 0, "nothing forks until main asks");

  const q = await queue(h);
  assert.equal(q.text, ASYNC_QUEUED_TEXT, "compress([]) returns at once");
  const rq = await h.emit("context", { messages: [] });
  assert.doesNotMatch(lastText(rq), /efficiency nudge/, "no nudge while the job is queued");
  assert.equal(await runCompress(h, "again", { content: [] }), ASYNC_ALREADY_QUEUED_TEXT, "a second trigger joins the queued job");

  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 1, "fork launched once after the main response arrived");
  const call = h.forkCalls[0]!;
  const forkBody = (call.options.onPayload as () => { messages: unknown[] })();
  assert.deepEqual(forkBody.messages.slice(0, -1), triggerPayload(q.id).messages, "fork prefix = captured main payload, queued result included");
  const prompt = (forkBody.messages[forkBody.messages.length - 1] as { role: string; content: Array<{ text: string }> });
  assert.equal(prompt.role, "user");
  assert.ok(prompt.content[0]!.text.startsWith(`${ASYNC_FORK_DIRECTIVE}\n\n`), "directive first");
  assert.match(prompt.content[0]!.text, /efficiency nudge/, "then the nudge");
  assert.ok(!prompt.content[0]!.text.includes(ASYNC_NUDGE_HINT), "the fork is not told to queue again");
  assert.deepEqual(call.options.headers, { "x-session": "abc" });
  assert.equal(call.options.sessionId, "async-apply");
  assert.ok(!("reasoning" in call.options), "thinking off → no reasoning option");
  assert.deepEqual((call.context as { tools: Array<{ name: string }> }).tools.map((t) => t.name), ["compress"]);

  const before = messagesOf(rq).length;
  const r2 = await h.emit("context", { messages: [] });
  const record = h.appended.find((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE);
  assert.ok(record, "durable replay record appended");
  const data = record.data as { callId: string; ranges: unknown[]; text: string; version: number };
  assert.ok(data.callId.startsWith(ASYNC_CALL_ID_PREFIX));
  assert.equal(data.version, 1);
  assert.deepEqual(data.ranges, [{ startRef: "m00002", endRef: "m00010", summary: "early turns: repeated lorem ipsum exchanges between user and assistant, no decisions", topic: "early" }]);
  assert.match(data.text, /^▣ ACP async compress \| blocks: b1=m00002–m00010$/);
  const msgs2 = messagesOf(r2);
  const carrier = msgs2.filter((m) => JSON.stringify(m.content).includes("[ACP async compression: b1=m00002–m00010]"));
  assert.equal(carrier.length, 1, "exactly one summary carrier");
  assert.equal(carrier[0]!.role, "user");
  assert.match(JSON.stringify(carrier[0]!.content), /\[Compressed conversation section\] — early\\nearly turns: repeated lorem ipsum exchanges/);
  assert.ok(msgs2.length < before, "compressed range left the sent view");

  const r3 = await h.emit("context", { messages: [] });
  const carrier3 = messagesOf(r3).filter((m) => JSON.stringify(m.content).includes("[ACP async compression:"));
  assert.deepEqual(carrier3, carrier, "carrier is byte-stable across requests (prefix cache)");
  assert.equal(h.appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE).length, 1, "applied once");
  assert.equal(h.forkCalls.length, 1, "no recursive/duplicate fork");
});

test("job in flight suppresses further non-emergency nudges (no duplicate compression)", async () => {
  const h = await harness("inflight");
  await startJob(h);
  h.entries = [...h.entries, roleMsg("x1", "user", "more " + MID)];
  const r2 = await h.emit("context", { messages: [] });
  assert.doesNotMatch(lastText(r2), /efficiency nudge/);
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 1);
});

test("record append failure discards the result: no block without its durable replay record, live state untouched", async () => {
  const h = await harness("append-fail");
  await startJob(h);
  await sendMainRequest(h);
  h.appendThrows = true;
  const r2 = await h.emit("context", { messages: [] });
  assert.ok(!JSON.stringify(messagesOf(r2)).includes("[ACP async compression:"), "nothing applied");
  const { readFile } = await import("node:fs/promises");
  const sidecar = JSON.parse(await readFile(`${join(tmpdir(), `pai-acp-async-append-fail-${process.pid}.session.json`)}.acp.json`, "utf8")) as { blocks: unknown[] };
  assert.equal(sidecar.blocks.length, 0, "persisted state has no orphan block");
});

test("stale result (history prefix changed) is discarded, nothing applied", async () => {
  const h = await harness("stale");
  await startJob(h);
  await sendMainRequest(h);
  // Branch navigation: the history from e3 on, queued call included, is a different branch.
  h.entries = h.entries.map((e) => {
    const id = (e as { id?: string }).id ?? "";
    if (/^e\d+$/.test(id)) return Number(id.slice(1)) >= 3 ? roleMsg(`${id}-b`, Number(id.slice(1)) % 2 ? "assistant" : "user", "branch " + MID) : e;
    return id === "u0" ? e : { ...(e as object), id: `${id}-b` };
  });
  const r2 = await h.emit("context", { messages: [] });
  assert.ok(!h.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE));
  assert.ok(!JSON.stringify(messagesOf(r2)).includes("[ACP async compression:"));
});

test("main request failing before launch drops the job and hands the nudge back to the sync path", async () => {
  const h = await harness("main-fail");
  await startJob(h);
  await h.emit("before_provider_request", { payload: triggerPayload(h.lastTrigger!) });
  await h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [], errorMessage: "boom" } });
  grow(h);
  const r2 = await h.emit("context", { messages: [] });
  assert.ok(endsWithNudge(r2), "next nudge goes out synchronously");
  assert.match(lastText(r2), /Background compression did not run \(main-error\)/, "and says why");
  assert.ok(!lastText(r2).includes(ASYNC_NUDGE_HINT.slice(0, 40)), "without offering the queue again");
  await h.emit("after_provider_response", { status: 200, headers: {} });
  await flush();
  assert.equal(h.forkCalls.length, 0);
});

test("non-2xx main response drops the job before launch", async () => {
  const h = await harness("main-429");
  await startJob(h);
  await sendMainRequest(h, 429);
  assert.equal(h.forkCalls.length, 0);
  grow(h);
  assert.ok(endsWithNudge(await h.emit("context", { messages: [] })), "next nudge goes out synchronously");
});

test("session switch aborts an in-flight fork and its result is never applied", async () => {
  const h = await harness("cancel");
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  h.forkReply = () => ({ role: "assistant", content: [], stopReason: "aborted" });
  const provider = h.ctx.modelRegistry.getProvider() as { streamSimple: (m: unknown, c: unknown, o: Record<string, unknown>) => unknown };
  provider.streamSimple = (_m, _c, o) => {
    signal = o.signal as AbortSignal;
    h.forkCalls.push({ model: _m, context: _c, options: o });
    return { result: async () => { await gate; return h.forkReply(); } };
  };
  await startJob(h);
  await sendMainRequest(h);
  assert.equal(signal?.aborted, false);
  await h.emit("session_before_switch", { reason: "new" });
  assert.equal(signal?.aborted, true, "fork aborted");
  release();
  await flush();
  await h.emit("context", { messages: [] });
  assert.ok(!h.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE));
});

test("emergency nudges stay synchronous even with compress.async", async () => {
  const h = await harness("emergency");
  h.entries = baseEntries(80);
  const r = await h.emit("context", { messages: [] });
  assert.match(lastText(r), /Context limit reached|EMERGENCY|context/i);
  assert.ok(!lastText(r).includes(ASYNC_NUDGE_HINT.slice(0, 40)), "no async hint in an emergency");
  assert.match(await runCompress(h, "emergency-empty", { content: [] }), /not available while the context is nearly full/, "and no queue");
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 0);
});

test("Codex stream-start launch: assistant message_start launches once; user/error/aborted starts do not", async () => {
  const h = await harness("stream-start");
  (h.ctx.model as { api: string }).api = "openai-codex-responses";
  await startJob(h);
  const id = h.lastTrigger!;
  await h.emit("before_provider_headers", { headers: { "x-session": "abc" } });
  await h.emit("before_provider_request", { payload: { model: "test-model", store: false, input: [{ role: "user", content: "history" }, { type: "function_call", call_id: id, name: "compress", arguments: "{\"content\":[]}" }, { type: "function_call_output", call_id: id, output: "queued" }] } });
  await h.emit("message_start", { message: { role: "user", content: "hi", timestamp: 1 } });
  await h.emit("message_start", { message: { role: "assistant", content: [], stopReason: "error", timestamp: 1 } });
  await h.emit("message_start", { message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 1 } });
  await flush();
  assert.equal(h.forkCalls.length, 0, "no launch before a successful stream start");
  await h.emit("message_start", { message: { role: "assistant", content: [], stopReason: "stop", timestamp: 1 } });
  await h.emit("after_provider_response", { status: 200, headers: {} });
  await h.emit("message_start", { message: { role: "assistant", content: [], stopReason: "stop", timestamp: 1 } });
  await flush();
  assert.equal(h.forkCalls.length, 1, "launched exactly once");
});

test("non-Codex wires launch only from after_provider_response, never from message_start", async () => {
  const h = await harness("http-then-start");
  await startJob(h);
  await h.emit("before_provider_headers", { headers: { "x-session": "abc" } });
  await h.emit("before_provider_request", { payload: triggerPayload(h.lastTrigger!) });
  await h.emit("message_start", { message: { role: "assistant", content: [], stopReason: "stop", timestamp: 1 } });
  await flush();
  assert.equal(h.forkCalls.length, 0);
  await h.emit("after_provider_response", { status: 200, headers: {} });
  await flush();
  assert.equal(h.forkCalls.length, 1);
});

test("unsupported api falls back to sync nudges", async () => {
  const h = await harness("unsupported-api");
  (h.ctx.model as { api: string }).api = "google-generative-ai";
  const r = await h.emit("context", { messages: [] });
  assert.match(lastText(r), /efficiency nudge/);
  assert.ok(!lastText(r).includes(ASYNC_NUDGE_HINT.slice(0, 40)), "no async hint on an unsupported wire");
  assert.match(await runCompress(h, "unsupported-empty", { content: [] }), /not available in this session \(unsupported-api:google-generative-ai\)/);
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 0);
});

test("unsupported payload shape at capture falls back to sync without a network call", async () => {
  const h = await harness("bad-payload");
  await startJob(h);
  await h.emit("before_provider_request", { payload: { ...triggerPayload(h.lastTrigger!), previous_response_id: "resp_1" } });
  await h.emit("after_provider_response", { status: 200, headers: {} });
  await flush();
  assert.equal(h.forkCalls.length, 0);
  grow(h);
  assert.ok(endsWithNudge(await h.emit("context", { messages: [] })), "session fell back to sync");
});

test("fork without a compress call applies nothing; invalid ranges are rejected all-or-nothing", async () => {
  const h = await harness("no-call");
  h.forkReply = () => ({ role: "assistant", content: [{ type: "text", text: "nothing to do" }], stopReason: "stop" });
  await startJob(h);
  await sendMainRequest(h);
  await h.emit("context", { messages: [] });
  assert.ok(!h.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE));

  const g = await harness("bad-ranges");
  g.forkReply = () => ({
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: "compress", arguments: { content: [
      { startId: "m00002", endId: "m00004", summary: "valid part: repeated lorem ipsum exchanges between user and assistant" },
      { startId: "m00038", endId: "m00040", summary: "protected recent zone: this range must be rejected by the kernel validation" },
    ] } }],
    stopReason: "toolUse",
  });
  await startJob(g);
  await sendMainRequest(g);
  const r = await g.emit("context", { messages: [] });
  assert.ok(!g.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE), "partial batch never applied");
  assert.ok(!JSON.stringify(messagesOf(r)).includes("[ACP async compression:"));
});

test("restart without sidecar: async block is rebuilt from the durable record and the carrier re-renders identically", async () => {
  const h = await harness("replay");
  await startJob(h);
  await sendMainRequest(h);
  const r2 = await h.emit("context", { messages: [] });
  const carrier = messagesOf(r2).filter((m) => JSON.stringify(m.content).includes("[ACP async compression:"));
  assert.equal(carrier.length, 1);

  const stateFile = join(tmpdir(), `pai-acp-async-replay-${process.pid}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });
  const fresh = await harness("replay-restart");
  fresh.entries = h.entries;
  fresh.ctx.sessionManager.getSessionFile = () => stateFile;
  const r3 = await fresh.emit("context", { messages: [] });
  const carrier3 = messagesOf(r3).filter((m) => JSON.stringify(m.content).includes("[ACP async compression:"));
  const wire = (ms: Array<{ role: string; content: unknown }>) => ms.map((m) => ({ role: m.role, content: m.content }));
  assert.deepEqual(wire(carrier3), wire(carrier), "replayed block renders the same carrier bytes");
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("declared fork host (getBranch-only, PI_ACP_FORK_HOST=1): async stays off, nudge goes out synchronously", async () => {
  const prev = process.env.PI_ACP_FORK_HOST;
  process.env.PI_ACP_FORK_HOST = "1";
  try {
    const h = await harness("fork-host");
    const sm = h.ctx.sessionManager as { buildContextEntries?: unknown; getBranch?: () => unknown[] };
    delete sm.buildContextEntries;
    sm.getBranch = () => h.entries;
    await h.emit("session_start", { reason: "startup" });
    const r = await h.emit("context", { messages: h.entries.map((e) => (e as { message: unknown }).message) });
    assert.ok(endsWithNudge(r), "sync nudge on fork hosts");
    await sendMainRequest(h);
    assert.equal(h.forkCalls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.PI_ACP_FORK_HOST;
    else process.env.PI_ACP_FORK_HOST = prev;
  }
});

test("proxy stand-down: with BILLION_CONTEXT_NATIVE set the async machinery stays inert", async () => {
  const prev = process.env.BILLION_CONTEXT_NATIVE;
  process.env.BILLION_CONTEXT_NATIVE = "test-native";
  try {
    const h = await harness("standdown");
    const r = await h.emit("context", { messages: [] });
    assert.equal(r, undefined, "context untouched");
    await sendMainRequest(h);
    assert.equal(h.forkCalls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.BILLION_CONTEXT_NATIVE;
    else process.env.BILLION_CONTEXT_NATIVE = prev;
  }
});

function gatedProvider(h: Harness): { signal: () => AbortSignal | undefined; release: () => void } {
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const provider = h.ctx.modelRegistry.getProvider() as { streamSimple: (m: unknown, c: unknown, o: Record<string, unknown>) => unknown };
  provider.streamSimple = (m, c, o) => {
    signal = o.signal as AbortSignal;
    h.forkCalls.push({ model: m, context: c, options: o });
    return { result: async () => { await gate; return h.forkReply(); } };
  };
  return { signal: () => signal, release };
}

test("compaction proceeding (refused-host path) aborts an in-flight fork", async () => {
  const h = await harness("compact-cancel");
  const g = gatedProvider(h);
  await startJob(h);
  await sendMainRequest(h);
  assert.equal(g.signal()?.aborted, false);
  for (const fn of h.handlers.get("session_before_compact") ?? []) await fn({ type: "session_before_compact" }, h.ctx);
  assert.equal(g.signal()?.aborted, true);
  g.release();
  await flush();
  await h.emit("context", { messages: [] });
  assert.ok(!h.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE));
});

test("user abort of the main request after launch cancels the fork; a plain main error after launch does not", async () => {
  const h = await harness("abort-after-launch");
  const g = gatedProvider(h);
  await startJob(h);
  await sendMainRequest(h);
  await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted", content: [] } });
  assert.equal(g.signal()?.aborted, true, "Esc on the main request aborts the fork");
  g.release();

  const e = await harness("error-after-launch");
  const ge = gatedProvider(e);
  await startJob(e);
  await sendMainRequest(e);
  await e.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [], errorMessage: "stream reset" } });
  assert.equal(ge.signal()?.aborted, false, "a transient main error leaves the fork running");
  ge.release();
  await flush();
  await e.emit("context", { messages: [] });
  assert.ok(e.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE), "its result still applies after validation");
});

test("turning compress.async off while a result is pending discards it", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "acp-async-optout-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "acp.json"), JSON.stringify({ compress: { async: true } }));
  const h = await harness("opt-out", {});
  (h.ctx as { cwd: string }).cwd = cwd;
  assert.match(lastText(await h.emit("context", { messages: [] })), /efficiency nudge/, "config read from the project acp.json");
  await startJob(h);
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 1);
  await writeFile(join(cwd, ".pi", "acp.json"), JSON.stringify({ compress: { async: false } }));
  const r2 = await h.emit("context", { messages: [] });
  assert.ok(!h.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE), "pending result discarded after opt-out");
  assert.ok(!JSON.stringify(messagesOf(r2)).includes("[ACP async compression:"));
  await rm(cwd, { recursive: true, force: true });
});

test("record written but sidecar save lost with an EXISTING non-empty sidecar: restart recovers the block from the record", async () => {
  const { mkdir, mkdtemp, readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "acp-async-recover-"));
  const stateFile = join(dir, "session.jsonl");
  const h = await harness("recover-1");
  h.ctx.sessionManager.getSessionFile = () => stateFile;
  // First async cycle lands normally → sidecar on disk has b1.
  await startJob(h);
  await sendMainRequest(h);
  await h.emit("context", { messages: [] });
  const sidecar1 = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8")) as { blocks: Array<{ compressCallId?: string }> };
  assert.equal(sidecar1.blocks.length, 1);

  // Second cycle: a directory occupies the sidecar's temp path, so the record
  // reaches the log but store.save's write fails and the on-disk sidecar stays at b1.
  grow(h, 20);
  h.forkReply = () => ({
    role: "assistant",
    content: [{ type: "toolCall", id: "t2", name: "compress", arguments: { content: [{ startId: "m00012", endId: "m00020", summary: "middle turns: more repeated lorem ipsum exchanges, still nothing decided", topic: "middle" }] } }],
    stopReason: "toolUse",
  });
  await startJob(h);
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 2, "second fork launched");
  const tmpPath = join(dir, `.acp-tmp-${basename(stateFile)}.acp.json`);
  await mkdir(tmpPath);
  try {
    await h.emit("context", { messages: [] });
  } finally {
    await rm(tmpPath, { recursive: true, force: true });
  }
  const records = h.appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE);
  assert.equal(records.length, 2, "second record reached the log");
  const onDisk = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8")) as { blocks: Array<{ compressCallId?: string }> };
  assert.equal(onDisk.blocks.length, 1, "sidecar on disk is missing the second block");

  // Restart: fresh runtime, same log, stale non-empty sidecar.
  const fresh = await harness("recover-2");
  fresh.entries = h.entries;
  fresh.ctx.sessionManager.getSessionFile = () => stateFile;
  const r2 = await fresh.emit("context", { messages: [] });
  const carriers = messagesOf(r2).filter((m) => JSON.stringify(m.content).includes("[ACP async compression:"));
  assert.equal(carriers.length, 2, "both async blocks render after recovery");
  assert.match(JSON.stringify(carriers[1]!.content), /middle turns/);
  const recovered = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8")) as { blocks: Array<{ compressCallId?: string }> };
  assert.equal(recovered.blocks.length, 2, "recovered block persisted");
  assert.equal(recovered.blocks[1]!.compressCallId, (records[1]!.data as { callId: string }).callId);
  await rm(dir, { recursive: true, force: true });
});

test("malformed async records in the session log do not break context handling", async () => {
  const h = await harness("malformed-records");
  h.entries = [...h.entries, ...[null, { version: 9, callId: "acp-bg-x", ranges: [] }, { version: 1, callId: "acp-bg-y", ranges: [null] }]
    .map((data, i) => ({ type: "custom", id: `m${i}`, parentId: null, timestamp: "", customType: ASYNC_COMPRESS_CUSTOM_TYPE, data }))];
  const r = await h.emit("context", { messages: [] });
  assert.ok(messagesOf(r).length > 0);
});

test("compress([]) with nothing viable to compress is not queued", async () => {
  const h = await harness("nothing", { compress: { async: true } });
  h.entries = baseEntries(2);
  await h.emit("context", { messages: [] });
  assert.equal(await runCompress(h, "nothing-empty", { content: [] }), ASYNC_NOTHING_TEXT);
  await h.emit("context", { messages: [] });
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 0);
});

test("a successful sync compress cancels a queued job; an invalid one leaves it running", async () => {
  const h = await harness("sync-cancels");
  await h.emit("context", { messages: [] });
  await queue(h);
  await assert.rejects(runCompress(h, "bad-sync", { content: "not json" }), "malformed sync call throws");
  await h.emit("context", { messages: [] });
  await sendMainRequest(h);
  assert.equal(h.forkCalls.length, 1, "the queued job survived the malformed call");

  const g = await harness("sync-cancels-2");
  await g.emit("context", { messages: [] });
  await queue(g);
  const folded = await runCompress(g, "good-sync", { content: [{ startId: "m00002", endId: "m00010", summary: "early turns: repeated lorem ipsum exchanges, no decisions" }] });
  assert.match(folded, /^▣ ACP \|/, "sync fold succeeded");
  await g.emit("context", { messages: [] });
  await sendMainRequest(g);
  assert.equal(g.forkCalls.length, 0, "the queued job was cancelled: its snapshot predates the fold");
});

test("the queued result is never a compression landmark, replay source or block, live or after restart", async () => {
  const h = await harness("queued-landmark");
  await h.emit("context", { messages: [] });
  await queue(h);
  assert.equal(usageAnchorPredatesCompression(h.entries as never), false, "floor-stale ignores the queued result");
  await h.emit("session_shutdown", {});

  const stateFile = join(tmpdir(), `pai-acp-async-queued-restart-${process.pid}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });
  const fresh = await harness("queued-restart");
  fresh.entries = h.entries;
  fresh.ctx.sessionManager.getSessionFile = () => stateFile;
  const r = await fresh.emit("context", { messages: [] });
  assert.ok(!JSON.stringify(messagesOf(r)).includes("[ACP async compression:"), "nothing replayed as applied");
  assert.match(lastText(r), /efficiency nudge/, "the nudge is not suppressed by a pending job or a false landmark");
  await sendMainRequest(fresh);
  assert.equal(fresh.forkCalls.length, 0, "a trigger from before the restart never forks");
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("a fork that makes no compress call, or a main run ending before the next request, owes main a sync nudge with the reason", async () => {
  const h = await harness("owed-no-call");
  h.forkReply = () => ({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "compress", arguments: { content: [] } }], stopReason: "toolUse" });
  await startJob(h);
  await sendMainRequest(h);
  grow(h, 2);
  const r = await h.emit("context", { messages: [] });
  assert.match(lastText(r), /Background compression did not run \(fork-no-compress-call\)/);
  assert.ok(!lastText(r).includes(ASYNC_NUDGE_HINT.slice(0, 40)), "the owed nudge is synchronous");

  const g = await harness("owed-agent-end");
  await g.emit("context", { messages: [] });
  await queue(g);
  await g.emit("agent_end", { messages: [] });
  grow(g, 2);
  const r2 = await g.emit("context", { messages: [] });
  assert.match(lastText(r2), /Background compression did not run \(agent-end-before-launch\)/);
  await sendMainRequest(g);
  assert.equal(g.forkCalls.length, 0);
});

test("the system prompt explains the trigger only while async compression is available", async () => {
  const prompt = async (h: Harness) => ((await h.emit("before_agent_start", { systemPrompt: "BASE", prompt: "hi" })) as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
  assert.ok((await prompt(await harness("sys-on"))).includes(ASYNC_SYSTEM_HINT));
  assert.ok(!(await prompt(await harness("sys-off", {}))).includes("BACKGROUND COMPRESSION"));
  const u = await harness("sys-unsupported");
  (u.ctx.model as { api: string }).api = "google-generative-ai";
  assert.ok(!(await prompt(u)).includes("BACKGROUND COMPRESSION"));
});

test("a fork that times out, throws or returns invalid ranges owes main one sync nudge with the reason, through the real hooks", async () => {
  const owed = async (name: string, reply: () => unknown, reason: RegExp, driveTimeout = false) => {
    const h = await harness(name);
    h.forkReply = reply;
    await startJob(h);
    if (driveTimeout) {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await h.emit("before_provider_headers", { headers: {} });
        await h.emit("before_provider_request", { payload: triggerPayload(h.lastTrigger!) });
        await h.emit("after_provider_response", { status: 200, headers: {} });
        mock.timers.tick(5 * 60_000 + 1);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      } finally {
        mock.timers.reset();
      }
    } else {
      await sendMainRequest(h);
    }
    grow(h, 2);
    const r = await h.emit("context", { messages: [] });
    assert.match(lastText(r), reason, `${name}: owed nudge says why`);
    assert.ok(!h.appended.some((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE), `${name}: nothing applied`);
    const again = await h.emit("context", { messages: [] });
    assert.doesNotMatch(lastText(again), /Background compression did not run/, `${name}: owed once`);
  };
  await owed("owed-timeout", () => new Promise(() => {}), /Background compression did not run \(fork-timeout\)/, true);
  await owed("owed-threw", () => { throw new Error("boom"); }, /Background compression did not run \(fork-threw\)/);
  await owed("owed-invalid-args", () => ({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "compress", arguments: { content: "garbage" } }], stopReason: "toolUse" }), /Background compression did not run \(fork-invalid-args\)/);
  await owed("owed-invalid-result", () => ({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "compress", arguments: { content: [{ startId: "m09000", endId: "m09002", summary: "refs this session never had: rejected at the next request boundary" }] } }], stopReason: "toolUse" }), /Background compression did not run \(result-(invalid|stale)\)/);
});

test("compress([]) queues nothing when cancelled, aborted or the session changes while its decision is computed", async () => {
  for (const [name, interrupt] of [
    ["race-abort", (_h: Harness, c: AbortController) => c.abort()],
    ["race-switch", (h: Harness) => h.emit("session_before_switch", { reason: "new" })],
    ["race-model", (h: Harness) => h.emit("model_select", {})],
    // A reset with no abort signal, same session id and model: only the epoch can tell.
    // Handlers are started together (their synchronous parts, incl. the reset, run now) so the reset lands while the decision is pending.
    ["race-reset", (h: Harness) => Promise.all((h.handlers.get("session_start") ?? []).map((fn) => fn({ type: "session_start", reason: "new" }, h.ctx)))],
  ] as const) {
    const h = await harness(name);
    await h.emit("context", { messages: [] });
    const controller = new AbortController();
    // The decision reads session state asynchronously; the interrupt lands while it is pending.
    let decided = false;
    const pending = h.tools.get("compress")!.execute("race-trig", { content: [] }, controller.signal, undefined, h.ctx).then((r) => r.content[0]!.text, (e: Error) => `threw:${e.message}`);
    void pending.then(() => { decided = true; });
    const interrupted = interrupt(h, controller);
    const settledFirst = decided;
    await interrupted;
    assert.equal(settledFirst, false, `${name}: interrupted before the decision settled`);
    const text = await pending;
    assert.notEqual(text, ASYNC_QUEUED_TEXT, `${name}: not queued (${text})`);
    grow(h, 2);
    const next = lastText(await h.emit("context", { messages: [] }));
    assert.doesNotMatch(next, /Background compression did not run/, `${name}: no orphan trigger was recorded`);
    await sendMainRequest(h);
    assert.equal(h.forkCalls.length, 0, `${name}: no orphan job`);
  }
  const control = await harness("race-control");
  await control.emit("context", { messages: [] });
  assert.equal(await runCompress(control, "race-control-trig", { content: [] }), ASYNC_QUEUED_TEXT, "uninterrupted, the same call queues");
});

test("compress([]) in an emergency gets sync guidance even while a job is active", async () => {
  const h = await harness("emergency-active");
  await h.emit("context", { messages: [] });
  await startJob(h);
  h.entries = [...h.entries, ...baseEntries(60).slice(1)];
  assert.match(await runCompress(h, "emergency-again", { content: [] }), /not available while the context is nearly full/);
});
