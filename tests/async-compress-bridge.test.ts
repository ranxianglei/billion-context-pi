import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, createEventBus } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "acp-kernel";
import { AsyncCompressor, BRIDGE_FORK_CHANNEL, ASYNC_FORK_DIRECTIVE, bridgeForkMessage, takeSnapshot } from "../src/async-compress.js";
import { createAcpExtension } from "../src/index.js";
import { setRunNpmForTest } from "../src/update.js";
import { ASYNC_CALL_ID_PREFIX, ASYNC_COMPRESS_CUSTOM_TYPE, ACP_NUDGE_CUSTOM_TYPE } from "../src/messages.js";

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_UPDATE_THROTTLE_FILE = join(tmpdir(), `acp-test-async-bridge-throttle-${process.pid}`);
const LOG_FILE = join(tmpdir(), `acp-test-async-bridge-${process.pid}.log`);
process.env.ACP_LOG_FILE = LOG_FILE;

const PI_AI = "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/";
const AGENT_CORE = "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";

function logged(sid: string, event: string): boolean {
  return existsSync(LOG_FILE) && readFileSync(LOG_FILE, "utf8").split("\n").some((l) => l.includes(`sid=${sid} event=${event} `));
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const MODEL = { api: "claude-bridge", provider: "claude-bridge", id: "claude-opus-5-5" } as unknown as NonNullable<ExtensionContext["model"]>;
const ARGS = { content: [{ startId: "m00001", endId: "m00002", summary: "greeting exchanged", topic: "greeting" }] };
const USAGE = { input: 1000, output: 20, cacheRead: 900, cacheWrite: 0 };

type Req = { version: number; piSessionId: string; prompt: string; captureTool: string; cutAfterToolResult?: string; signal: AbortSignal; accept(result: unknown): boolean };

function harness(sid: string, timeoutMs?: number) {
  const bus = createEventBus();
  const notes: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => sid },
    modelRegistry: { getProvider: () => { throw new Error("bridge forks never use the provider registry"); }, getProviderAuth: async () => { throw new Error("no auth lookup"); } },
  } as unknown as ExtensionContext;
  const pi = { appendEntry: () => {}, getThinkingLevel: () => "high", getActiveTools: () => [], getAllTools: () => [], events: bus } as unknown as ConstructorParameters<typeof AsyncCompressor>[0]["pi"];
  const c = new AsyncCompressor({ pi, ...(timeoutMs ? { timeoutMs } : {}) });
  c.start(sid, { nudgeText: "NUDGE", snapshot: takeSnapshot([], createInitialState()), model: MODEL, triggerCallId: "toolu_trigger" });
  return { bus, ctx, c, notes };
}

test("bridgeForkMessage: maps the bridge result onto a fork message and treats anything malformed as an error", () => {
  assert.deepEqual(bridgeForkMessage({ ok: true, args: ARGS, usage: USAGE }), { stopReason: "toolUse", usage: USAGE, content: [{ type: "toolCall", name: "compress", arguments: ARGS }] });
  assert.deepEqual(bridgeForkMessage({ ok: false, reason: "no-capture", usage: USAGE }), { stopReason: "stop", usage: USAGE, content: [] });
  assert.deepEqual(bridgeForkMessage({ ok: false, reason: "aborted" }), { stopReason: "aborted", content: [] });
  for (const bad of [undefined, null, "x", {}, { ok: true }, { ok: true, args: "x" }, { ok: true, args: [] }, { ok: false, reason: "no-capture-tool" }, { ok: false, reason: "error" }]) {
    assert.equal(bridgeForkMessage(bad).stopReason, "error", JSON.stringify(bad));
  }
  assert.equal(bridgeForkMessage({ ok: true, args: ARGS, usage: { input: "1" } }).usage, undefined, "malformed usage is dropped");
  for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(bridgeForkMessage({ ok: true, args: ARGS, usage: { ...USAGE, output: count } }).usage, undefined, `output ${count} is dropped`);
  }
});

test("bridgeForkMessage: keeps the bridge's completeness flag and nothing else it does not know", () => {
  assert.deepEqual(bridgeForkMessage({ ok: true, args: ARGS, usage: { ...USAGE, complete: false } }).usage, { ...USAGE, complete: false });
  assert.deepEqual(bridgeForkMessage({ ok: false, reason: "aborted", usage: { ...USAGE, complete: true } }).usage, { ...USAGE, complete: true });
  assert.deepEqual(bridgeForkMessage({ ok: true, args: ARGS, usage: USAGE }).usage, USAGE, "an older bridge states no completeness, and none is guessed");
  assert.deepEqual(bridgeForkMessage({ ok: true, args: ARGS, usage: { ...USAGE, complete: "yes", extra: 1 } }).usage, USAGE);
  assert.equal("usage" in bridgeForkMessage({ ok: true, args: ARGS }), false, "a result without usage gets none");
});

test("claude-bridge: no provider capture; launches from stream start with the exact v1 request; result becomes ready", async () => {
  const { bus, ctx, c } = harness("bridge-ok");
  const seen: Req[] = [];
  const taken: boolean[] = [];
  bus.on(BRIDGE_FORK_CHANNEL, (data) => {
    const r = data as Req;
    seen.push(r);
    taken.push(r.accept(Promise.resolve({ ok: true, args: ARGS, usage: USAGE })));
    taken.push(r.accept(Promise.resolve({ ok: true, args: { content: [] }, usage: USAGE })));
  });
  c.onPayload("bridge-ok", { messages: [] }, ctx);
  c.onResponse("bridge-ok", 200, ctx);
  assert.equal(c.phase("bridge-ok"), "awaiting-request", "provider capture hooks are not the bridge's launch signal");
  assert.equal(seen.length, 0);
  c.onStreamStart("bridge-ok", ctx);
  assert.equal(seen.length, 1, "requested in the stream-start tick");
  const r = seen[0]!;
  assert.deepEqual({ version: r.version, piSessionId: r.piSessionId, prompt: r.prompt, captureTool: r.captureTool, cutAfterToolResult: r.cutAfterToolResult }, { version: 1, piSessionId: "bridge-ok", prompt: `${ASYNC_FORK_DIRECTIVE}\n\nNUDGE`, captureTool: "compress", cutAfterToolResult: "toolu_trigger" }, "the fork is cut after the trigger's result and told to compress only, ahead of the nudge");
  assert.ok(r.signal instanceof AbortSignal);
  await waitFor(() => c.phase("bridge-ok") === "ready");
  const ready = c.takeReady("bridge-ok")!;
  assert.deepEqual(ready.ranges.map((x) => x.startRef), ["m00001"], "only the first accept counts");
  assert.deepEqual(taken, [true, false], "a later acceptor learns it was not taken");
  assert.ok(logged("bridge-ok", "bridge-fork-extra-accept"));
});

test("claude-bridge: a listener throwing after the accept keeps the fork; rejected duplicates are observed", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { bus, ctx, c } = harness("bridge-throw");
    bus.on(BRIDGE_FORK_CHANNEL, (data) => {
      const r = data as Req;
      r.accept(Promise.resolve({ ok: true, args: ARGS, usage: USAGE }));
      r.accept(Promise.reject(new Error("duplicate failed")));
    });
    bus.on(BRIDGE_FORK_CHANNEL, () => { throw new Error("other extension bug"); });
    c.onStreamStart("bridge-throw", ctx);
    assert.equal(c.fallbackReason("bridge-throw"), undefined, "the accepted fork survives a throwing listener on the real bus");
    await waitFor(() => c.phase("bridge-throw") === "ready");

    const sync = harness("bridge-throw-sync");
    (sync.c as unknown as { deps: { pi: { events: unknown } } }).deps.pi.events = {
      emit: (_channel: string, data: unknown) => {
        (data as Req).accept(Promise.resolve({ ok: true, args: ARGS, usage: USAGE }));
        throw new Error("emitter propagates listener errors");
      },
      on: () => () => {},
    };
    sync.c.onStreamStart("bridge-throw-sync", sync.ctx);
    assert.equal(sync.c.fallbackReason("bridge-throw-sync"), undefined, "an accept before the throw is kept");
    await waitFor(() => sync.c.phase("bridge-throw-sync") === "ready");
    assert.ok(logged("bridge-throw-sync", "bridge-fork-listener-threw"));

    const first = harness("bridge-reject-first");
    first.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept(Promise.reject(new Error("boom sk-ant-secret"))));
    first.c.onStreamStart("bridge-reject-first", first.ctx);
    await waitFor(() => !first.c.isActive("bridge-reject-first"));
    assert.equal(first.c.fallbackReason("bridge-reject-first"), "fork-error");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
    assert.ok(!readFileSync(LOG_FILE, "utf8").includes("sk-ant-secret"));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("claude-bridge: the bridge's failure reason is logged only when it is a plain enum word", async () => {
  const plain = harness("bridge-reason");
  plain.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept(Promise.resolve({ ok: false, reason: "unsafe-config" })));
  plain.c.onStreamStart("bridge-reason", plain.ctx);
  await waitFor(() => !plain.c.isActive("bridge-reason"));
  const odd = harness("bridge-reason-odd");
  odd.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept(Promise.resolve({ ok: false, reason: "Bearer sk-ant-xyz" })));
  odd.c.onStreamStart("bridge-reason-odd", odd.ctx);
  await waitFor(() => !odd.c.isActive("bridge-reason-odd"));
  const log = readFileSync(LOG_FILE, "utf8");
  assert.match(log, /sid=bridge-reason event=bridge-fork-declined .*reason=unsafe-config/);
  assert.match(log, /sid=bridge-reason-odd event=bridge-fork-declined .*reason=malformed/);
  assert.ok(!log.includes("sk-ant-xyz"));
});

test("claude-bridge: no bridge listener (or a non-promise accept) fails closed to synchronous nudges", () => {
  const none = harness("bridge-none");
  none.c.onStreamStart("bridge-none", none.ctx);
  assert.equal(none.c.isActive("bridge-none"), false);
  assert.equal(none.c.fallbackReason("bridge-none"), "bridge-fork-unavailable");
  assert.equal(none.c.takeSyncRetry("bridge-none"), true, "this turn's nudge is retried synchronously");
  assert.equal(none.notes.length, 1);

  const bogus = harness("bridge-bogus");
  bogus.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept({ ok: true, args: ARGS }));
  bogus.c.onStreamStart("bridge-bogus", bogus.ctx);
  assert.equal(bogus.c.fallbackReason("bridge-bogus"), "bridge-fork-unavailable");
});

test("claude-bridge: no-capture is discarded like a fork without a compress call and owes main the sync nudge; a malformed result falls back", async () => {
  const quiet = harness("bridge-quiet");
  quiet.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept(Promise.resolve({ ok: false, reason: "no-capture", usage: USAGE })));
  quiet.c.onStreamStart("bridge-quiet", quiet.ctx);
  await waitFor(() => !quiet.c.isActive("bridge-quiet"));
  assert.equal(quiet.c.fallbackReason("bridge-quiet"), undefined);
  assert.equal(quiet.c.takeSyncRetry("bridge-quiet"), true, "main asked for compression, so the nudge comes back synchronously");

  const bad = harness("bridge-bad");
  bad.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept(Promise.resolve({ ok: true, args: "not-an-object" })));
  bad.c.onStreamStart("bridge-bad", bad.ctx);
  await waitFor(() => !bad.c.isActive("bridge-bad"));
  assert.equal(bad.c.fallbackReason("bridge-bad"), "fork-error");
});

test("claude-bridge: a transient decline retries this nudge synchronously and keeps async, until it keeps declining", async () => {
  const sid = "bridge-transient";
  const h = harness(sid);
  let reply: unknown = { ok: false, reason: "stale-context" };
  h.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept(Promise.resolve(reply)));
  const round = async () => {
    h.c.onStreamStart(sid, h.ctx);
    await waitFor(() => !h.c.isActive(sid) || h.c.phase(sid) === "ready");
  };
  const restart = () => h.c.start(sid, { nudgeText: "NUDGE", snapshot: takeSnapshot([], createInitialState()), model: MODEL, triggerCallId: "toolu_trigger" });

  await round();
  assert.equal(h.c.fallbackReason(sid), undefined, "one decline does not turn async off");
  assert.equal(h.c.takeSyncRetry(sid), true, "the nudge held back for this fork is shown on the next request");
  assert.equal(h.notes.length, 0);

  reply = { ok: false, reason: "unsupported-context" };
  restart();
  await round();
  assert.equal(h.c.fallbackReason(sid), undefined);
  assert.equal(h.c.takeSyncRetry(sid), true);

  reply = { ok: true, args: ARGS, usage: USAGE };
  restart();
  await round();
  assert.ok(h.c.takeReady(sid));
  reply = { ok: false, reason: "cut-timeout" };
  restart();
  await round();
  assert.equal(h.c.fallbackReason(sid), undefined, "a cut that never reached the transcript in time is transient too");
  assert.equal(h.c.takeSyncRetry(sid), true);
  assert.equal(h.c.takeRetryReason(sid), "bridge-declined:cut-timeout");

  reply = { ok: true, args: ARGS, usage: USAGE };
  restart();
  await round();
  assert.ok(h.c.takeReady(sid), "a capture is ready and resets the count");

  reply = { ok: false, reason: "stale-context" };
  for (let i = 0; i < 2; i++) {
    restart();
    await round();
    assert.equal(h.c.fallbackReason(sid), undefined, `decline ${i + 1} after a success`);
    assert.equal(h.c.takeSyncRetry(sid), true);
  }
  restart();
  await round();
  assert.equal(h.c.fallbackReason(sid), "bridge-fork-declined", "three in a row fall back to synchronous nudges");
  assert.equal(h.c.takeSyncRetry(sid), true);
  assert.equal(h.notes.length, 1);
});

test("claude-bridge: a permanent decline falls back, and still retries the held-back nudge synchronously", async () => {
  for (const reason of ["unsafe-config", "error", "no-capture-tool"]) {
    const sid = `bridge-permanent-${reason}`;
    const h = harness(sid);
    h.bus.on(BRIDGE_FORK_CHANNEL, (data) => (data as Req).accept(Promise.resolve({ ok: false, reason })));
    h.c.onStreamStart(sid, h.ctx);
    await waitFor(() => !h.c.isActive(sid));
    assert.equal(h.c.fallbackReason(sid), "fork-error", reason);
    assert.equal(h.c.takeSyncRetry(sid), true, reason);
  }
});

test("claude-bridge: cancel and the fork deadline abort the signal the bridge holds", async () => {
  const cancelled = harness("bridge-cancel");
  let held: AbortSignal | undefined;
  cancelled.bus.on(BRIDGE_FORK_CHANNEL, (data) => { held = (data as Req).signal; (data as Req).accept(new Promise(() => {})); });
  cancelled.c.onStreamStart("bridge-cancel", cancelled.ctx);
  assert.equal(held!.aborted, false);
  cancelled.c.cancel("bridge-cancel", "opt-out");
  assert.equal(held!.aborted, true);

  const slow = harness("bridge-slow", 25);
  let slowSignal: AbortSignal | undefined;
  slow.bus.on(BRIDGE_FORK_CHANNEL, (data) => { slowSignal = (data as Req).signal; (data as Req).accept(new Promise(() => {})); });
  slow.c.onStreamStart("bridge-slow", slow.ctx);
  await waitFor(() => !slow.c.isActive("bridge-slow"));
  assert.equal(slowSignal!.aborted, true);
  assert.equal(slow.c.fallbackReason("bridge-slow"), "fork-timeout");
});

test("claude-bridge: aborting the main request after launch aborts the bridge fork", () => {
  const h = harness("bridge-main-abort");
  let held: AbortSignal | undefined;
  h.bus.on(BRIDGE_FORK_CHANNEL, (data) => { held = (data as Req).signal; (data as Req).accept(new Promise(() => {})); });
  h.c.onStreamStart("bridge-main-abort", h.ctx);
  h.c.onMainFailed("bridge-main-abort", "main-aborted", true);
  assert.equal(held!.aborted, true);
  assert.equal(h.c.isActive("bridge-main-abort"), false);
});

const MID = "lorem ipsum dolor sit amet ".repeat(400);
const USAGE0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Handler = (event: unknown, ctx: unknown) => unknown;

function entry(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: role === "assistant"
    ? { role, content: [{ type: "text", text }], api: "claude-bridge", provider: "claude-bridge", model: "claude-opus-5-5", usage: USAGE0, stopReason: "stop", timestamp: 1 }
    : { role, content: text, timestamp: 1 } };
}

test("claude-bridge main: real Agent turn queues with compress([]); the bridge is asked to fork the next served request after the queued result; result applies at the next boundary", async () => {
  const { Agent } = (await import(AGENT_CORE)) as { Agent: new (opts: Record<string, unknown>) => { prompt(text: string): Promise<void>; subscribe(fn: (e: { type: string }) => unknown): () => void } };
  const { createAssistantMessageEventStream } = (await import(PI_AI + "utils/event-stream.js")) as { createAssistantMessageEventStream(): { push(e: unknown): void; end(): void } };
  const sid = "bridge-agent";
  await rm(LOG_FILE, { force: true });
  const stateFile = join(tmpdir(), `pai-acp-async-bridge-${process.pid}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });
  const bus = createEventBus();
  const forkArgs = { content: [{ startId: "m00002", endId: "m00010", summary: "early turns: repeated lorem ipsum exchanges between user and assistant, no decisions", topic: "early" }] };
  let lastServed: { messages: unknown[] } | undefined;
  const servedAtAccept: unknown[] = [];
  const requests: Req[] = [];
  bus.on(BRIDGE_FORK_CHANNEL, (data) => {
    const r = data as Req;
    requests.push(r);
    if (r.piSessionId !== sid || !lastServed) return;
    servedAtAccept.push(lastServed);
    r.accept(Promise.resolve({ ok: true, args: forkArgs, usage: USAGE }));
  });
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { name: string; label: string; description: string; parameters: unknown; execute: (...a: unknown[]) => Promise<unknown> }>();
  const appended: Array<{ customType: string; data?: unknown }> = [];
  let entries: unknown[] = [entry("u0", "user", "start " + MID)];
  for (let i = 1; i < 40; i++) entries.push(entry(`e${i}`, i % 2 ? "assistant" : "user", `turn ${i} ` + MID));
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool(tool: never) { tools.set((tool as { name: string }).name, tool); },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry(customType: string, data?: unknown) {
      appended.push({ customType, data });
      entries = [...entries, { type: "custom", id: `c${entries.length}`, parentId: null, timestamp: "", customType, data }];
    },
    getThinkingLevel: () => "off",
    getActiveTools: () => ["compress"],
    getAllTools: () => [{ name: "compress", description: "Compress ranges", parameters: { type: "object", properties: {} } }],
    events: bus,
  };
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false, compress: { async: true, asyncClaudeBridge: true } })(pi as never);
  const model = { ...MODEL, contextWindow: 200_000, maxTokens: 8000, input: ["text"], reasoning: false, baseUrl: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: tmpdir(),
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model,
    getContextUsage: () => null,
    modelRegistry: { getProvider: () => ({}), getProviderAuth: async () => undefined },
    sessionManager: { buildContextEntries: () => entries, getSessionId: () => sid, getSessionFile: () => stateFile },
  };
  const emit = async (event: string, payload: object) => {
    let last: unknown;
    for (const fn of handlers.get(event) ?? []) last = await fn({ type: event, ...payload }, ctx);
    return last;
  };
  const nudges = () => appended.filter((a) => a.customType === ACP_NUDGE_CUSTOM_TYPE).length;
  for (let i = 0; i < 3 && nudges() === 0; i++) await emit("context", { messages: [] });
  assert.equal(nudges(), 1, "nudge decided");

  const compress = tools.get("compress")!;
  const agentTool = { name: compress.name, label: compress.label, description: compress.description, parameters: compress.parameters, execute: (id: unknown, params: unknown, signal: unknown, onUpdate: unknown) => compress.execute(id, params, signal, onUpdate, ctx) };
  const TRIGGER = "toolu_trigger";
  let calls = 0;
  const agent = new Agent({
    initialState: { systemPrompt: "SYS", model, thinkingLevel: "off", tools: [agentTool] },
    convertToLlm,
    sessionId: sid,
    transformContext: async (messages: unknown[]) => ((await emit("context", { messages })) as { messages?: unknown[] } | undefined)?.messages ?? messages,
    streamFn: (_m: unknown, context: { messages: unknown[] }) => {
      lastServed = { messages: [...context.messages] };
      const first = calls++ === 0;
      const stream = createAssistantMessageEventStream();
      const partial = { role: "assistant", content: [], api: "claude-bridge", provider: "claude-bridge", model: "claude-opus-5-5", usage: USAGE0, stopReason: first ? "toolUse" : "stop", timestamp: Date.now() };
      setTimeout(() => {
        stream.push({ type: "start", partial });
        const message = { ...partial, content: first ? [{ type: "toolCall", id: TRIGGER, name: "compress", arguments: { content: [] } }] : [{ type: "text", text: "ok" }] };
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
        stream.end();
      }, 5);
      return stream;
    },
  });
  // pi persists each finished message before the next request is built.
  agent.subscribe(async (e) => {
    if (e.type === "message_end") entries = [...entries, { type: "message", id: `p${entries.length}`, parentId: null, timestamp: "", message: (e as unknown as { message: unknown }).message }];
    if (["message_start", "message_end", "agent_end"].includes(e.type)) await emit(e.type, e);
  });
  await agent.prompt("go");

  assert.equal(calls, 2, "main asked once, got the queued result, and answered");
  assert.equal(requests.length, 1, "one fork request, for the request after the trigger");
  assert.equal(servedAtAccept[0], lastServed, "accepted while the bridge's last served request was the turn being streamed");
  const served = lastServed!.messages as Array<{ role: string; toolCallId?: string; content: unknown }>;
  const result = served[served.length - 1]!;
  assert.equal(result.role, "toolResult");
  assert.equal(result.toolCallId, TRIGGER);
  assert.match(JSON.stringify(result.content), /Background compression queued/, "the served request carries the queued result");
  assert.equal(requests[0]!.cutAfterToolResult, TRIGGER, "the bridge cuts right after it");
  assert.ok(requests[0]!.prompt.startsWith(`${ASYNC_FORK_DIRECTIVE}\n\n`));
  assert.ok(requests[0]!.prompt.length > ASYNC_FORK_DIRECTIVE.length + 2, "the nudge follows the directive");
  await waitFor(() => logged(sid, "result-ready"));

  const r = (await emit("context", { messages: [] })) as { messages: Array<{ role: string; content: unknown }> };
  const records = appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE);
  assert.equal(records.length, 1, "async result applied at the next boundary");
  assert.ok(String((records[0]!.data as { callId: string }).callId).startsWith(ASYNC_CALL_ID_PREFIX));
  assert.ok(r.messages.some((m) => JSON.stringify(m.content).includes("[ACP async compression:")), "summary carrier rendered");
  await rm(`${stateFile}.acp.json`, { force: true });
});
