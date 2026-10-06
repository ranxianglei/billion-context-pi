import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { BRIDGE_FORK_CHANNEL } from "../src/async-compress.js";
import { createAcpExtension } from "../src/index.js";
import { setRunNpmForTest } from "../src/update.js";
import { ASYNC_COMPRESS_CUSTOM_TYPE } from "../src/messages.js";

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_UPDATE_THROTTLE_FILE = join(tmpdir(), `acp-test-async-bridge-optin-throttle-${process.pid}`);
const LOG_FILE = join(tmpdir(), `acp-test-async-bridge-optin-${process.pid}.log`);
process.env.ACP_LOG_FILE = LOG_FILE;

const MID = "lorem ipsum dolor sit amet ".repeat(400);
const USAGE0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Handler = (event: unknown, ctx: unknown) => unknown;
type Req = { piSessionId: string; signal: AbortSignal; accept(result: unknown): boolean };

function logLines(sid: string, event: string): string[] {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.includes(`sid=${sid} event=${event} `) || (sid === "" && l.includes(`event=${event} `)));
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function entry(id: string, role: string, text: string, api: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: role === "assistant"
    ? { role, content: [{ type: "text", text }], api, provider: api, model: "m", usage: USAGE0, stopReason: "stop", timestamp: 1 }
    : { role, content: text, timestamp: 1 } };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function session(sid: string, compress: unknown, opts: { api?: string; onFork?: (r: Req) => void } = {}) {
  const api = opts.api ?? "claude-bridge";
  const cwd = await mkdtemp(join(tmpdir(), "acp-bridge-optin-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const setConfig = (c: unknown) => writeFile(join(cwd, ".pi", "acp.json"), JSON.stringify(c === undefined ? {} : { compress: c }));
  await setConfig(compress);
  const stateFile = join(cwd, "session.json");
  const bus = createEventBus();
  const requests: Req[] = [];
  bus.on(BRIDGE_FORK_CHANNEL, (data) => {
    const r = data as Req;
    if (r.piSessionId !== sid) return;
    requests.push(r);
    opts.onFork?.(r);
  });
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
  const appended: Array<{ customType: string; data?: unknown }> = [];
  let entries: unknown[] = [entry("u0", "user", "start " + MID, api)];
  for (let i = 1; i < 40; i++) entries.push(entry(`e${i}`, i % 2 ? "assistant" : "user", `turn ${i} ` + MID, api));
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
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false })(pi as never);
  const model = { api, provider: api, id: "claude-opus-5-5", contextWindow: 200_000, maxTokens: 8000, input: ["text"], reasoning: false, baseUrl: api, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd,
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
  const lastText = (r: unknown) => JSON.stringify((r as { messages: unknown[] }).messages.at(-1));
  const syncNudged = (r: unknown) => lastText(r).includes("Compression Philosophy");
  let seq = 0;
  /** One main turn: context until a nudge is shown; main calls compress({content: []});
   *  the next request (carrying the result) is built and its stream starts. */
  const turn = async () => {
    let r: unknown;
    for (let i = 0; i < 3; i++) {
      r = await emit("context", { messages: [] });
      if (syncNudged(r)) break;
    }
    const id = `toolu_${sid}_${++seq}`;
    const queued = (await tools.get("compress")!.execute(id, { content: [] }, undefined, undefined, ctx)).content[0]!.text;
    entries = [...entries,
      { type: "message", id: `a-${id}`, parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id, name: "compress", arguments: { content: [] } }], api, provider: api, model: "m", usage: USAGE0, stopReason: "toolUse", timestamp: 1 } },
      { type: "message", id: `r-${id}`, parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: id, toolName: "compress", content: [{ type: "text", text: queued }], isError: false, timestamp: 1 } }];
    await emit("context", { messages: [] });
    await emit("message_start", { message: { role: "assistant", content: [], stopReason: "stop", api, provider: api, model: "m", usage: USAGE0, timestamp: Date.now() } });
    return { nudge: r, queued };
  };
  open.push(async () => {
    await emit("session_shutdown", {});
    await rm(cwd, { recursive: true, force: true });
  });
  const switchModel = (next: string) => Object.assign(model, { api: next, provider: next, baseUrl: next });
  return { emit, turn, syncNudged, requests, appended, setConfig, switchModel };
}

const READY = { ok: true, args: { content: [{ startId: "m00002", endId: "m00010", summary: "early turns: repeated lorem ipsum exchanges between user and assistant, no decisions", topic: "early" }] }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };

test("claude-bridge async is off by default and with compress.async alone: sync nudge, no fork request, no fallback", async () => {
  for (const [sid, compress] of [["optin-default", undefined], ["optin-async-only", { async: true }], ["optin-flag-only", { asyncClaudeBridge: true }]] as const) {
    const s = await session(sid, compress, { onFork: (r) => r.accept(Promise.resolve(READY)) });
    const { nudge, queued } = await s.turn();
    assert.ok(s.syncNudged(nudge), `${sid}: nudge in the main request`);
    assert.ok(!JSON.stringify(nudge).includes("Background compression is on"), `${sid}: without the async hint`);
    assert.equal(queued, "No ranges provided.", `${sid}: compress([]) keeps its sync reply`);
    assert.equal(s.requests.length, 0, `${sid}: no isolated-fork request`);
    assert.equal(logLines(sid, "job-created").length, 0, `${sid}: no async job`);
    assert.equal(logLines(sid, "sync-fallback").length + logLines(sid, "job-dropped").length, 0, `${sid}: not treated as a bridge failure`);
  }
});

test("compress.async alone logs the missing claude-bridge opt-in once per session", async () => {
  const sid = "optin-log-once";
  const s = await session(sid, { async: true });
  await s.turn();
  await s.turn();
  const lines = logLines(sid, "bridge-async-not-enabled");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /compress\.asyncClaudeBridge/);
});

test("compress.async plus compress.asyncClaudeBridge forks through the bridge", async () => {
  const sid = "optin-both";
  const s = await session(sid, { async: true, asyncClaudeBridge: true }, { onFork: (r) => r.accept(Promise.resolve(READY)) });
  const { nudge, queued } = await s.turn();
  assert.ok(JSON.stringify(nudge).includes("Background compression is on"), "main sees the nudge and the async hint");
  assert.match(queued, /^Background compression queued/);
  assert.equal(s.requests.length, 1);
  await waitFor(() => logLines(sid, "result-ready").length > 0);
  await s.emit("context", { messages: [] });
  assert.equal(s.appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE).length, 1, "result applied");
});

test("asyncClaudeBridge resolves through the providers/models cascade; only a literal true opts in", async () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["optin-provider-off", { async: true, asyncClaudeBridge: true, providers: { "claude-bridge": { asyncClaudeBridge: false } } }, false],
    ["optin-model-on", { async: true, providers: { "claude-bridge": { models: { "claude-opus-5-5": { asyncClaudeBridge: true } } } } }, true],
    ["optin-provider-async-off", { asyncClaudeBridge: true, async: true, providers: { "claude-bridge": { async: false } } }, false],
    ["optin-string", { async: true, asyncClaudeBridge: "true" }, false],
  ];
  for (const [sid, compress, forks] of cases) {
    const s = await session(sid, compress, { onFork: (r) => r.accept(Promise.resolve(READY)) });
    await s.turn();
    assert.equal(s.requests.length, forks ? 1 : 0, sid);
  }
  const warn = logLines("", "compress-async-claude-bridge-invalid");
  assert.equal(warn.length, 1);
  assert.match(warn[0]!, /type=string/);
  assert.doesNotMatch(warn[0]!, /"true"/, "the invalid value itself is not logged");
});

test("other async routes ignore asyncClaudeBridge", async () => {
  const sid = "optin-anthropic";
  const s = await session(sid, { async: true }, { api: "anthropic-messages" });
  const { queued } = await s.turn();
  assert.match(queued, /^Background compression queued/, "anthropic-messages queues with compress.async alone");
  assert.equal(logLines(sid, "job-created").length, 1);
  assert.equal(logLines(sid, "bridge-async-not-enabled").length, 0);
});

test("turning asyncClaudeBridge off discards a ready bridge result", async () => {
  const sid = "optin-off-ready";
  const s = await session(sid, { async: true, asyncClaudeBridge: true }, { onFork: (r) => r.accept(Promise.resolve(READY)) });
  await s.turn();
  await waitFor(() => logLines(sid, "result-ready").length > 0);
  await s.setConfig({ async: true });
  await s.emit("context", { messages: [] });
  assert.equal(s.appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE).length, 0, "ready result not applied");
  assert.equal(logLines(sid, "result-discarded").length, 0, "dropped by the opt-out, not by validation");
  await s.setConfig({ async: true, asyncClaudeBridge: true });
  await s.emit("context", { messages: [] });
  assert.equal(s.appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE).length, 0, "and not kept for later");
});

test("turning asyncClaudeBridge off aborts a running bridge fork", async () => {
  const sid = "optin-off-running";
  const s = await session(sid, { async: true, asyncClaudeBridge: true }, { onFork: (r) => r.accept(new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))) });
  await s.turn();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0]!.signal.aborted, false);
  await s.setConfig({ async: true });
  await s.emit("context", { messages: [] });
  assert.equal(s.requests[0]!.signal.aborted, true, "fork signal aborted");
});

test("a ready bridge result is gated by the job's API, not the model switched to since", async () => {
  const sid = "optin-switch-model";
  const s = await session(sid, { async: true, providers: { "claude-bridge": { asyncClaudeBridge: true } } }, { onFork: (r) => r.accept(Promise.resolve(READY)) });
  await s.turn();
  await waitFor(() => logLines(sid, "result-ready").length > 0);
  s.switchModel("anthropic-messages");
  await s.emit("context", { messages: [] });
  assert.equal(s.appended.filter((a) => a.customType === ASYNC_COMPRESS_CUSTOM_TYPE).length, 0, "bridge result not applied without the bridge opt-in");
  assert.equal(logLines(sid, "result-discarded").length, 0, "dropped by the opt-out, not by validation");
});

test("after a declined bridge fork the nudge is shown synchronously on the next request, with the reason", async () => {
  const sid = "optin-declined-retry";
  const s = await session(sid, { async: true, asyncClaudeBridge: true }, { onFork: (r) => r.accept(Promise.resolve({ ok: false, reason: "stale-context" })) });
  await s.turn();
  assert.equal(s.requests.length, 1);
  await waitFor(() => logLines(sid, "job-dropped").length > 0);
  const retry = await s.emit("context", { messages: [] });
  assert.ok(s.syncNudged(retry), "the nudge main asked to queue is shown synchronously");
  assert.match(JSON.stringify(retry), /Background compression did not run \(bridge-declined:stale-context\)/);
  // claude-bridge keeps that nudge in later requests unchanged instead of injecting another.
  const again = await s.emit("context", { messages: [] }) as { messages: unknown[] };
  assert.deepEqual(again.messages, (retry as { messages: unknown[] }).messages, "the same nudge, kept, not a second one");
  assert.equal(s.requests.length, 1, "the retry does not start another fork");
  assert.equal(logLines(sid, "sync-fallback").length, 0, "one decline keeps async on");
});

test("a fork that applies owes no nudge on the next request", async () => {
  const sid = "optin-applied-no-retry";
  const s = await session(sid, { async: true, asyncClaudeBridge: true }, { onFork: (r) => r.accept(Promise.resolve(READY)) });
  await s.turn();
  await waitFor(() => logLines(sid, "result-ready").length > 0);
  assert.ok(!s.syncNudged(await s.emit("context", { messages: [] })));
  assert.ok(!s.syncNudged(await s.emit("context", { messages: [] })));
});
