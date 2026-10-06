import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "acp-kernel";
import { AsyncCompressor, ASYNC_FORK_DIRECTIVE, forkPayload, takeSnapshot } from "../src/async-compress.js";
import { createAcpExtension } from "../src/index.js";
import { setRunNpmForTest } from "../src/update.js";
import { ASYNC_CALL_ID_PREFIX, ASYNC_COMPRESS_CUSTOM_TYPE, ACP_NUDGE_CUSTOM_TYPE } from "../src/messages.js";

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_UPDATE_THROTTLE_FILE = join(tmpdir(), `acp-test-async-codex-throttle-${process.pid}`);
const LOG_FILE = join(tmpdir(), `acp-test-async-codex-${process.pid}.log`);
process.env.ACP_LOG_FILE = LOG_FILE;

function logged(sid: string, event: string): boolean {
  return existsSync(LOG_FILE) && readFileSync(LOG_FILE, "utf8").split("\n").some((l) => l.includes(`sid=${sid} event=${event} `));
}

// Real installed Codex adapter and agent loop over a fake WebSocket and a stubbed SSE fetch.
const PI_AI = "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/";
const AGENT_CORE = "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";

type CodexProvider = {
  getModels(): Array<Record<string, unknown> & { api: string; id: string; provider: string }>;
  streamSimple(model: unknown, context: unknown, options?: Record<string, unknown>): AsyncIterable<{ type: string }> & { result(): Promise<unknown> };
};
type DebugStats = Record<string, unknown> | undefined;
type CodexApiModule = { getOpenAICodexWebSocketDebugStats(sid: string): DebugStats; closeOpenAICodexWebSocketSessions(sid?: string): void; resetOpenAICodexWebSocketDebugStats(sid?: string): void };

async function codex(): Promise<{ provider: CodexProvider; model: Record<string, unknown> & { api: string }; api: CodexApiModule }> {
  const mod = (await import(PI_AI + "providers/openai-codex.js")) as { openaiCodexProvider(): CodexProvider };
  const provider = mod.openaiCodexProvider();
  const model = provider.getModels().find((m) => m.api === "openai-codex-responses")!;
  const api = (await import(PI_AI + "api/openai-codex-responses.js")) as CodexApiModule;
  return { provider, model, api };
}

function jwt(accountId: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

const NUDGE = "Context is growing — compress m00001..m00002 now.";
const FORK_PROMPT = `${ASYNC_FORK_DIRECTIVE}\n\n${NUDGE}`;
const TRIGGER = "call_trig|fc_trig";
const ARGS_JSON = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "greeting exchanged", topic: "greeting" }] });
const USAGE0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const TOOLS = [{ name: "compress", description: "Compress ranges", parameters: { type: "object", properties: {} } }];
const REASONING = JSON.stringify({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC-signed-abc123" });
const BASH_ARGS = { command: "printf '\\x3cacp\\x3e' > out.txt" };

function history(model: { provider: string; id: string }) {
  return [
    { role: "user", content: "plan it", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: REASONING }, { type: "toolCall", id: "call_1|fc_1", name: "bash", arguments: BASH_ARGS }], api: "openai-codex-responses", provider: model.provider, model: model.id, usage: USAGE0, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
    { role: "user", content: "next", timestamp: 4 },
    { role: "assistant", content: [{ type: "toolCall", id: TRIGGER, name: "compress", arguments: { content: [] } }], api: "openai-codex-responses", provider: model.provider, model: model.id, usage: USAGE0, stopReason: "toolUse", timestamp: 5 },
    { role: "toolResult", toolCallId: TRIGGER, toolName: "compress", content: [{ type: "text", text: "Background compression queued." }], isError: false, timestamp: 6 },
  ];
}

// The main agent's compress({content: []}) as the WebSocket's first reply.
function triggerEvents(responseId: string): unknown[] {
  const call = { type: "function_call", id: "fc_trig", call_id: "call_trig", name: "compress", arguments: JSON.stringify({ content: [] }), status: "completed" };
  return [
    { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.done", item_id: call.id, output_index: 0, arguments: call.arguments },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: responseId, status: "completed", output: [call], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } } },
  ];
}

function textEvents(responseId: string, text: string): unknown[] {
  const message = { type: "message", id: `msg_${responseId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: responseId, status: "completed", output: [message], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } } },
  ];
}

function compressEvents(args: string): unknown[] {
  const call = { type: "function_call", id: "fc_fork", call_id: "call_fork", name: "compress", arguments: args, status: "completed" };
  return [
    { type: "response.created", response: { id: "resp_fork", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: args },
    { type: "response.function_call_arguments.done", item_id: call.id, output_index: 0, arguments: args },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: "resp_fork", status: "completed", output: [call], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 80 } } } },
  ];
}

type Listener = (event: unknown) => void;

// Answers every response.create frame with a short text reply.
class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  static frames: Array<Record<string, unknown>> = [];
  static script: Array<(responseId: string) => unknown[]> = [];
  readyState = 0;
  private listeners = new Map<string, Listener[]>();
  constructor(readonly url: string, readonly options: { headers?: Record<string, string> }) {
    FakeWebSocket.sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.dispatch("open", {}); }, 0);
  }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn)); }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    FakeWebSocket.frames.push(frame);
    const id = `resp_main_${FakeWebSocket.frames.length}`;
    (FakeWebSocket.script.shift()?.(id) ?? textEvents(id, "ok")).forEach((ev, i) => setTimeout(() => this.dispatch("message", { data: JSON.stringify(ev) }), i + 1));
  }
  close() { this.readyState = 3; }
  private dispatch(type: string, event: unknown) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
}

interface SentRequest { url: string; headers: Headers; body: Record<string, unknown> }

function installTransports(forkArgs = ARGS_JSON): { requests: SentRequest[]; restore: () => void } {
  const requests: SentRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalWs = (globalThis as { WebSocket?: unknown }).WebSocket;
  FakeWebSocket.sockets = [];
  FakeWebSocket.frames = [];
  FakeWebSocket.script = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = Buffer.from(init?.body as Uint8Array | string);
    const text = headers.get("content-encoding") === "zstd" ? zlib.zstdDecompressSync(raw).toString("utf8") : raw.toString("utf8");
    requests.push({ url: String(input), headers, body: JSON.parse(text) as Record<string, unknown> });
    const body = compressEvents(forkArgs).map((ev) => `event: ${(ev as { type: string }).type}\ndata: ${JSON.stringify(ev)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWs;
    },
  };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const fakePi = {
  appendEntry: () => {},
  getThinkingLevel: () => "off" as const,
  getActiveTools: () => ["compress"],
  getAllTools: () => TOOLS.map((t) => ({ ...t, sourceInfo: { path: "", source: "builtin", scope: "user", origin: "top-level" } })),
} as unknown as ConstructorParameters<typeof AsyncCompressor>[0]["pi"];

test("real Codex adapter: fork goes over SSE with refreshed OAuth auth and leaves the main WebSocket session untouched", async () => {
  const { provider, model, api } = await codex();
  const sid = "codex-adapter-isolation";
  api.closeOpenAICodexWebSocketSessions(sid);
  api.resetOpenAICodexWebSocketDebugStats(sid);
  const { requests, restore } = installTransports();
  try {
    const messages = history(model as { provider: string; id: string });
    const captured: Array<Record<string, unknown>> = [];
    const mainRequest = (msgs: unknown[]) => provider.streamSimple(model, { systemPrompt: "SYS", messages: msgs, tools: TOOLS }, {
      apiKey: jwt("acct_main"),
      sessionId: sid,
      transport: "auto",
      headers: { "x-extension": "kept" },
      onPayload: (p: unknown) => { captured.push(structuredClone(p) as Record<string, unknown>); return undefined; },
    }).result() as Promise<{ content: Array<{ type: string; text?: string }>; stopReason: string }>;

    const first = await mainRequest(messages);
    assert.equal(first.stopReason, "stop");
    assert.equal(FakeWebSocket.frames.length, 1, "main request went over the WebSocket");
    assert.equal(requests.length, 0);
    const statsBefore = structuredClone(api.getOpenAICodexWebSocketDebugStats(sid));
    assert.equal(statsBefore?.cachedContextRequests, 1, "main WebSocket session uses cached-context continuation");

    const ctx = {
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: { getSessionId: () => sid },
      modelRegistry: { getProvider: () => provider, getProviderAuth: async () => ({ auth: { apiKey: jwt("acct_refreshed") }, env: {} }) },
    } as unknown as ExtensionContext;
    const compressor = new AsyncCompressor({ pi: fakePi });
    compressor.start(sid, { nudgeText: NUDGE, snapshot: takeSnapshot([], createInitialState()), model: model as unknown as NonNullable<ExtensionContext["model"]>, triggerCallId: TRIGGER });
    compressor.onHeaders(sid, { "x-extension": "kept" });
    compressor.onPayload(sid, captured[0], ctx);
    compressor.onStreamStart(sid, ctx);
    await waitFor(() => compressor.phase(sid) !== "running");
    const ready = compressor.takeReady(sid);
    assert.deepEqual(ready?.ranges, [{ startRef: "m00001", endRef: "m00002", summary: "greeting exchanged", topic: "greeting" }]);

    assert.equal(requests.length, 1, "exactly one fork request, over HTTP/SSE");
    assert.equal(FakeWebSocket.sockets.length, 1, "fork opened no WebSocket");
    assert.equal(FakeWebSocket.frames.length, 1, "fork sent nothing on the main WebSocket");
    const sent = requests[0]!;
    assert.ok(sent.url.endsWith("/codex/responses"), sent.url);
    assert.deepEqual(sent.body, JSON.parse(JSON.stringify(forkPayload("openai-codex-responses", captured[0], FORK_PROMPT))), "fork body = captured main body + one nudge turn");
    assert.deepEqual((sent.body.input as unknown[]).slice(0, -1), captured[0]!.input, "history prefix byte-identical");
    assert.equal(sent.body.prompt_cache_key, captured[0]!.prompt_cache_key, "same prompt cache key as the main request");
    assert.equal(sent.body.store, false);
    assert.ok(!("previous_response_id" in sent.body));
    const wire = JSON.stringify(sent.body);
    assert.ok(wire.includes("ENC-signed-abc123"), "signed reasoning replayed verbatim");
    assert.ok(wire.includes(JSON.stringify(JSON.stringify(BASH_ARGS))), "tool-call arguments replayed byte-exact");
    assert.equal(sent.headers.get("authorization"), `Bearer ${jwt("acct_refreshed")}`, "auth resolved at fork time");
    assert.equal(sent.headers.get("chatgpt-account-id"), "acct_refreshed");
    assert.equal(sent.headers.get("session-id"), sid);
    assert.equal(sent.headers.get("x-extension"), "kept", "captured final headers forwarded");

    assert.deepEqual(api.getOpenAICodexWebSocketDebugStats(sid), statsBefore, "main WebSocket stats, fallback flag and continuation untouched");
    const second = await mainRequest([...messages, first, { role: "user", content: "again", timestamp: 6 }]);
    assert.equal(second.stopReason, "stop");
    assert.equal(FakeWebSocket.sockets.length, 1, "main reuses its socket");
    const frame = FakeWebSocket.frames[1]!;
    assert.equal(frame.previous_response_id, "resp_main_1", "main WebSocket continuation survived the fork");
    assert.equal(api.getOpenAICodexWebSocketDebugStats(sid)?.sseFallbacks, 0);
    assert.ok(!("previous_response_id" in captured[1]!), "captured payload is always the full context, never the WebSocket delta");
  } finally {
    api.closeOpenAICodexWebSocketSessions(sid);
    restore();
  }
});

// Hooks forwarded the way pi's sdk wires them.

const MID = "lorem ipsum dolor sit amet ".repeat(400);
type Handler = (event: unknown, ctx: unknown) => unknown;

function entry(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: role === "assistant"
    ? { role, content: [{ type: "text", text }], api: "openai-codex-responses", provider: "openai-codex", model: "m", usage: USAGE0, stopReason: "stop", timestamp: 1 }
    : { role, content: text, timestamp: 1 } };
}

test("Codex main over WebSocket: real Agent turn queues with compress([]); the next request's stream start launches the fork; result applies at the next boundary", async () => {
  const { provider, model, api } = await codex();
  const { Agent } = (await import(AGENT_CORE)) as { Agent: new (opts: Record<string, unknown>) => { prompt(text: string): Promise<void>; subscribe(fn: (e: { type: string }) => unknown): () => void } };
  const sid = "codex-agent-ws";
  await rm(LOG_FILE, { force: true });
  api.closeOpenAICodexWebSocketSessions(sid);
  const stateFile = join(tmpdir(), `pai-acp-async-codex-${process.pid}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });
  const forkArgs = JSON.stringify({ content: [{ startId: "m00002", endId: "m00010", summary: "early turns: repeated lorem ipsum exchanges between user and assistant, no decisions", topic: "early" }] });
  const { requests, restore } = installTransports(forkArgs);
  try {
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
      getAllTools: () => TOOLS,
    };
    createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false, compress: { async: true } })(pi as never);
    const ctx = {
      mode: "rpc",
      hasUI: false,
      cwd: tmpdir(),
      ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
      model: { ...model, contextWindow: 200_000 },
      getContextUsage: () => null,
      modelRegistry: { getProvider: () => provider, getProviderAuth: async () => ({ auth: { apiKey: jwt("acct_1") }, env: {} }) },
      sessionManager: { buildContextEntries: () => entries, getSessionId: () => sid, getSessionFile: () => stateFile },
    };
    const fired: string[] = [];
    const emit = async (event: string, payload: object) => {
      fired.push(event);
      let last: unknown;
      for (const fn of handlers.get(event) ?? []) last = await fn({ type: event, ...payload }, ctx);
      return last;
    };
    const nudges = () => appended.filter((a) => a.customType === ACP_NUDGE_CUSTOM_TYPE).length;
    for (let i = 0; i < 3 && nudges() === 0; i++) await emit("context", { messages: [] });
    assert.equal(nudges(), 1, "nudge decided");

    const compress = tools.get("compress")!;
    const agentTool = { name: compress.name, label: compress.label, description: compress.description, parameters: compress.parameters, execute: (id: unknown, params: unknown, signal: unknown, onUpdate: unknown) => compress.execute(id, params, signal, onUpdate, ctx) };
    FakeWebSocket.script = [triggerEvents];
    const payloads: Array<Record<string, unknown>> = [];
    const agent = new Agent({
      initialState: { systemPrompt: "SYS", model, thinkingLevel: "off", tools: [agentTool] },
      convertToLlm,
      sessionId: sid,
      transport: "auto",
      getApiKey: () => jwt("acct_1"),
      transformContext: async (messages: unknown[]) => ((await emit("context", { messages })) as { messages?: unknown[] } | undefined)?.messages ?? messages,
      streamFn: async (m: unknown, context: unknown, options: Record<string, unknown>) => {
        const headers: Record<string, string> = { "x-extension": "kept" };
        await emit("before_provider_headers", { headers });
        return provider.streamSimple(m, context, { ...options, headers });
      },
      onPayload: async (payload: unknown) => {
        payloads.push(structuredClone(payload) as Record<string, unknown>);
        return ((await emit("before_provider_request", { payload })) as unknown) ?? payload;
      },
      onResponse: async (r: { status: number; headers: Record<string, string> }) => { await emit("after_provider_response", r); },
    });
    // pi persists each finished message before the next request is built.
    agent.subscribe(async (e) => {
      if (e.type === "message_end") entries = [...entries, { type: "message", id: `p${entries.length}`, parentId: null, timestamp: "", message: (e as unknown as { message: unknown }).message }];
      if (["message_start", "message_end", "agent_end"].includes(e.type)) await emit(e.type, e);
    });
    await agent.prompt("go");

    assert.equal(FakeWebSocket.frames.length, 2, "both main requests went over the WebSocket");
    assert.ok(!fired.includes("after_provider_response"), "the WebSocket transport fires no after_provider_response");
    await waitFor(() => logged(sid, "result-ready"));
    assert.equal(requests.length, 1);
    assert.equal(FakeWebSocket.frames.length, 2, "fork used SSE, not the main socket");
    const captured = payloads[1]!;
    assert.deepEqual((requests[0]!.body.input as unknown[]).slice(0, -1), JSON.parse(JSON.stringify(captured.input)), "fork prefix = the full request after the trigger");
    assert.ok(JSON.stringify(captured.input).includes('"type":"function_call_output","call_id":"call_trig"'), "which carries the queued result");
    assert.equal(requests[0]!.body.prompt_cache_key, captured.prompt_cache_key);

    const r = (await emit("context", { messages: [] })) as { messages: Array<{ role: string; content: unknown }> };
    const records = appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE);
    assert.equal(records.length, 1, "async result applied at the next boundary");
    assert.ok(String((records[0]!.data as { callId: string }).callId).startsWith(ASYNC_CALL_ID_PREFIX));
    assert.ok(r.messages.some((m) => JSON.stringify(m.content).includes("[ACP async compression:")), "summary carrier rendered");
  } finally {
    api.closeOpenAICodexWebSocketSessions(sid);
    restore();
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});
