import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AsyncCompressor, ASYNC_FORK_DIRECTIVE, ASYNC_QUEUED_TEXT, forkPayload, takeSnapshot } from "../src/async-compress.js";
import { createInitialState } from "acp-kernel";

// #614: the fork goes through the host's REAL pi-ai provider adapters. These
// tests run the installed adapters end-to-end against a stubbed fetch with
// hermetic SSE fixtures — no network, no API keys.
const PI_AI = "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/";

type AnyProvider = {
  id: string;
  getModels(): Array<Record<string, unknown> & { api: string; id: string; provider: string }>;
  streamSimple(model: unknown, context: unknown, options?: Record<string, unknown>): { result(): Promise<unknown> };
};

async function loadProvider(file: string, factory: string): Promise<AnyProvider> {
  const mod = (await import(PI_AI + file)) as Record<string, () => AnyProvider>;
  return mod[factory]!();
}

const NUDGE = "Context is growing — compress m00001..m00002 now.";
const ARGS = { content: [{ startId: "m00001", endId: "m00002", summary: "greeting exchanged", topic: "greeting" }] };
const ARGS_JSON = JSON.stringify(ARGS);

const USAGE0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const FORK_PROMPT = `${ASYNC_FORK_DIRECTIVE}\n\n${NUDGE}`;
const TRIGGER: Record<string, string> = { "anthropic-messages": "toolu_trigger", "openai-completions": "call_trigger", "openai-responses": "call_trigger|fc_trigger" };
const READ_ID: Record<string, string> = { "anthropic-messages": "toolu_read", "openai-completions": "call_read", "openai-responses": "call_read|fc_read" };
const toolCall = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id: string, name: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 5 });
const assistant = (content: unknown[]) => ({ role: "assistant", content, api: "x", provider: "x", model: "x", usage: USAGE0, stopReason: "toolUse", timestamp: 4 });
// History ending in the main agent's compress({content: []}) and its "queued" result.
const mainMessages = (api: string) => [
  { role: "user", content: "hello", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "hi there" }], api: "x", provider: "x", model: "x", usage: USAGE0, stopReason: "stop", timestamp: 2 },
  { role: "user", content: "next", timestamp: 3 },
  assistant([toolCall(TRIGGER[api]!, "compress", { content: [] })]),
  toolResult(TRIGGER[api]!, "compress", ASYNC_QUEUED_TEXT),
];
const TOOLS = [{ name: "compress", description: "Compress ranges", parameters: { type: "object", properties: {} } }];

// Capture the body a real adapter builds for `messages`, without sending it.
async function buildPayload(provider: AnyProvider, model: unknown, messages: unknown[], apiKey = "test-key"): Promise<Record<string, unknown>> {
  let got: Record<string, unknown> | undefined;
  const ctrl = new AbortController();
  await provider.streamSimple(model, { systemPrompt: "SYSTEM PROMPT", messages, tools: TOOLS }, {
    apiKey,
    signal: ctrl.signal,
    onPayload: (p: unknown) => {
      got = structuredClone(p) as Record<string, unknown>;
      ctrl.abort();
      throw new Error("captured");
    },
  }).result();
  assert.ok(got, "adapter produced a payload");
  return got;
}

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
}

const FIXTURES: Record<string, string> = {
  "anthropic-messages": sse([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "compress", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ARGS_JSON } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]),
  "openai-completions": sse([
    { data: { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: ARGS_JSON } }] }, finish_reason: null }] } },
    { data: { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
    { data: { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } } } },
    { data: "[DONE]" },
  ]),
  "openai-responses": sse([
    { event: "response.created", data: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "compress", arguments: "" } } },
    { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: ARGS_JSON } },
    { event: "response.function_call_arguments.done", data: { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: ARGS_JSON } },
    { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "compress", arguments: ARGS_JSON, status: "completed" } } },
    { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "compress", arguments: ARGS_JSON, status: "completed" }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 80 } } } } },
  ]),
};

interface Captured { url: string; headers: Headers; body: unknown }

function stubFetch(api: string): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const raw = input instanceof Request ? await input.text() : String(init?.body ?? "");
    calls.push({ url, headers, body: JSON.parse(raw) });
    return new Response(FIXTURES[api], { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeCtx(provider: AnyProvider, sid: string, auth: { apiKey: string; baseUrl?: string }): ExtensionContext {
  const notes: string[] = [];
  return {
    hasUI: false,
    ui: { notify: (m: string) => { notes.push(m); } },
    sessionManager: { getSessionId: () => sid },
    modelRegistry: {
      getProvider: () => provider,
      getProviderAuth: async () => ({ auth: { apiKey: auth.apiKey, baseUrl: auth.baseUrl, headers: { "x-provider-auth": "auth-header" } }, env: {} }),
    },
  } as unknown as ExtensionContext;
}

const fakePi = {
  appendEntry: () => {},
  getThinkingLevel: () => "off" as const,
  getActiveTools: () => ["compress"],
  getAllTools: () => TOOLS.map((t) => ({ ...t, sourceInfo: { path: "", source: "builtin", scope: "user", origin: "top-level" } })),
} as unknown as ConstructorParameters<typeof AsyncCompressor>[0]["pi"];

const CASES = [
  { file: "anthropic.js", factory: "anthropicProvider", api: "anthropic-messages", path: "/v1/messages", apiKey: "sk-ant-api03-test" },
  { file: "anthropic.js", factory: "anthropicProvider", api: "anthropic-messages", path: "/v1/messages", apiKey: "sk-ant-oat01-oauth-test" },
  { file: "groq.js", factory: "groqProvider", api: "openai-completions", path: "/chat/completions", apiKey: "gsk-test" },
  { file: "openai.js", factory: "openaiProvider", api: "openai-responses", path: "/responses", apiKey: "sk-test" },
] as const;

for (const c of CASES) {
  test(`real ${c.api} adapter${c.apiKey.includes("oat") ? " (OAuth key)" : ""}: fork body = captured main body + nudge, captured final headers + baseUrl, compress result parsed`, async () => {
    const provider = await loadProvider(c.file, c.factory);
    const model = provider.getModels().find((m) => m.api === c.api)!;
    assert.ok(model, `provider ships a ${c.api} model`);
    const mainPayload = await buildPayload(provider, model, mainMessages(c.api), c.apiKey);
    const sid = `adapter-${c.api}-${c.apiKey}`;
    const ctx = fakeCtx(provider, sid, { apiKey: c.apiKey, baseUrl: "https://fork.test/base" });
    const compressor = new AsyncCompressor({ pi: fakePi });
    const { calls, restore } = stubFetch(c.api);
    try {
      compressor.start(sid, { nudgeText: NUDGE, snapshot: takeSnapshot([], createInitialState()), model: model as unknown as NonNullable<ExtensionContext["model"]>, triggerCallId: TRIGGER[c.api]! });
      const finalHeaders: Record<string, string | null> = { "x-provider-auth": "auth-header" };
      compressor.onHeaders(sid, finalHeaders);
      // A later extension mutates the header object in place AFTER our handler.
      finalHeaders["x-late-extension"] = "late";
      compressor.onPayload(sid, mainPayload, ctx);
      assert.equal(compressor.phase(sid), "awaiting-response");
      compressor.onResponse(sid, 200, ctx);
      await waitFor(() => compressor.phase(sid) !== "running");
      const ready = compressor.takeReady(sid);
      assert.ok(ready, `fork result ready (phase was ${compressor.phase(sid)})`);
      assert.deepEqual(ready.ranges, [{ startRef: "m00001", endRef: "m00002", summary: "greeting exchanged", topic: "greeting" }]);
      assert.equal(calls.length, 1, "exactly one fork request");
      const sent = calls[0]!;
      assert.ok(sent.url.startsWith("https://fork.test/base"), `auth baseUrl honored: ${sent.url}`);
      assert.ok(sent.url.endsWith(c.path), `adapter endpoint: ${sent.url}`);
      assert.deepEqual(sent.body, JSON.parse(JSON.stringify(forkPayload(c.api, mainPayload, FORK_PROMPT))), "wire body is the captured main body (ending in the queued result) plus one appended directive + nudge turn");
      assert.equal(sent.headers.get("x-provider-auth"), "auth-header");
      assert.equal(sent.headers.get("x-late-extension"), "late", "in-place header mutations by later handlers are included");
      const auth = sent.headers.get("authorization") ?? sent.headers.get("x-api-key") ?? "";
      assert.ok(auth.includes(c.apiKey), "apiKey from provider auth reaches the request");
    } finally {
      restore();
    }
  });
}

// Correspondence with the synchronous path: the fork body equals what the
// SAME adapter would build for the sync request (history + nudge as the final
// user turn) except for fields the adapter derives from the request's tail —
// Anthropic's last-user cache breakpoint (the fork keeps main's breakpoint, so
// its prefix is a cache read of the request that was just sent) and the
// OpenAI output-token budget (derived from the input estimate).
function normalize(api: string, body: Record<string, unknown>): unknown {
  const copy = structuredClone(body);
  delete copy.max_output_tokens;
  delete copy.max_completion_tokens;
  const list = (api === "openai-responses" ? copy.input : copy.messages) as Array<Record<string, unknown>>;
  for (const m of list) {
    if (typeof m.content === "string") m.content = [{ type: api === "openai-responses" ? "input_text" : "text", text: m.content }];
    if (Array.isArray(m.content)) for (const part of m.content as Array<Record<string, unknown>>) delete part.cache_control;
  }
  return copy;
}

for (const c of CASES) {
  if (c.apiKey.includes("oat")) continue;
  test(`real ${c.api} adapter: fork body corresponds to the sync request modulo tail-derived fields`, async () => {
    const provider = await loadProvider(c.file, c.factory);
    const model = provider.getModels().find((m) => m.api === c.api)!;
    const main = await buildPayload(provider, model, mainMessages(c.api), c.apiKey);
    const sync = await buildPayload(provider, model, [...mainMessages(c.api), { role: "user", content: [{ type: "text", text: FORK_PROMPT }], timestamp: 6 }], c.apiKey);
    const fork = forkPayload(c.api, main, FORK_PROMPT) as Record<string, unknown>;
    assert.deepEqual(normalize(c.api, fork), normalize(c.api, sync));
    const key = c.api === "openai-responses" ? "input" : "messages";
    assert.deepEqual((fork[key] as unknown[]).slice(0, -1), main[key], "fork prefix is byte-identical to the main request");
  });
}

test("real anthropic-messages adapter: signed thinking blocks reach the fork byte-identical", async () => {
  const provider = await loadProvider("anthropic.js", "anthropicProvider");
  const model = provider.getModels().find((m) => m.api === "anthropic-messages")!;
  const signed = [
    { role: "user", content: "plan it", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "private plan", thinkingSignature: "SIG-abc123" }, { type: "text", text: "done" }], api: "anthropic-messages", provider: model.provider, model: model.id, usage: USAGE0, stopReason: "stop", timestamp: 2 },
    { role: "user", content: "next", timestamp: 3 },
    { ...assistant([{ type: "thinking", thinking: "queue it", thinkingSignature: "SIG-def456" }, toolCall("toolu_trigger", "compress", { content: [] })]), api: "anthropic-messages", provider: model.provider, model: model.id },
    toolResult("toolu_trigger", "compress", ASYNC_QUEUED_TEXT),
  ];
  const main = await buildPayload(provider, model, signed);
  assert.match(JSON.stringify(main), /"signature":"SIG-abc123"/, "adapter replays the signed thinking block");
  assert.match(JSON.stringify(main), /"signature":"SIG-def456"/, "and the trigger turn's signed thinking");
  const sid = "adapter-signed";
  const ctx = fakeCtx(provider, sid, { apiKey: "sk-ant-api03-test" });
  const compressor = new AsyncCompressor({ pi: fakePi });
  const { calls, restore } = stubFetch("anthropic-messages");
  try {
    compressor.start(sid, { nudgeText: NUDGE, snapshot: takeSnapshot([], createInitialState()), model: model as unknown as NonNullable<ExtensionContext["model"]>, triggerCallId: "toolu_trigger" });
    compressor.onPayload(sid, main, ctx);
    compressor.onResponse(sid, 200, ctx);
    await waitFor(() => compressor.phase(sid) !== "running");
    const sentMessages = (calls[0]!.body as { messages: unknown[] }).messages;
    assert.deepEqual(sentMessages.slice(0, -1), main.messages, "history incl. signed thinking is byte-identical to the main request");
  } finally {
    restore();
  }
});

// The trigger's result must be in the payload's final tool-result batch; it
// need not be the last item (parallel calls), and nothing is rewritten.
for (const c of CASES) {
  if (c.apiKey.includes("oat")) continue;
  test(`real ${c.api} adapter: capture accepts the trigger anywhere in the final tool-result batch and rejects a missing or stale one`, async () => {
    const provider = await loadProvider(c.file, c.factory);
    const model = provider.getModels().find((m) => m.api === c.api)!;
    const trigger = TRIGGER[c.api]!;
    const read = READ_ID[c.api]!;
    const head = mainMessages(c.api).slice(0, 3);
    const parallel = [...head, assistant([toolCall(trigger, "compress", { content: [] }), toolCall(read, "read", { path: "a" })]), toolResult(trigger, "compress", ASYNC_QUEUED_TEXT), toolResult(read, "read", "file text")];
    const later = [...mainMessages(c.api), assistant([toolCall(read, "read", { path: "a" })]), toolResult(read, "read", "file text")];
    const missing = [...head, assistant([toolCall(read, "read", { path: "a" })]), toolResult(read, "read", "file text")];
    const capture = async (messages: unknown[], name: string) => {
      const payload = await buildPayload(provider, model, messages, c.apiKey);
      const frozen = JSON.stringify(payload);
      const sid = `adapter-batch-${c.api}-${name}`;
      const compressor = new AsyncCompressor({ pi: fakePi });
      compressor.start(sid, { nudgeText: NUDGE, snapshot: takeSnapshot([], createInitialState()), model: model as unknown as NonNullable<ExtensionContext["model"]>, triggerCallId: trigger });
      compressor.onPayload(sid, payload, fakeCtx(provider, sid, { apiKey: c.apiKey }));
      assert.equal(JSON.stringify(payload), frozen, "the main payload is never rewritten");
      const result = { phase: compressor.phase(sid), retry: compressor.takeSyncRetry(sid) };
      compressor.resetSession(sid);
      return result;
    };
    assert.deepEqual(await capture(parallel, "parallel"), { phase: "awaiting-response", retry: false }, "trigger result followed by a sibling result is captured");
    assert.deepEqual(await capture(later, "later"), { phase: undefined, retry: true }, "a newer assistant turn after the trigger means it is not this request's batch");
    assert.deepEqual(await capture(missing, "missing"), { phase: undefined, retry: true }, "no trigger result: nothing forks, the nudge goes back to the sync path");
  });
}
