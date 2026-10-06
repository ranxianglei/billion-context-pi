import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { defaultCountTokens } from "acp-kernel";
import { createAcpExtension } from "../src/index.js";
import { setRunNpmForTest } from "../src/update.js";
import { extractText } from "../src/messages.js";
import { RetainedNudges } from "../src/retained-nudges.js";
import { setDebugEnabled } from "../src/log.js";

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_UPDATE_THROTTLE_FILE = join(tmpdir(), `acp-test-retained-nudges-throttle-${process.pid}`);
const LOG_FILE = join(tmpdir(), `acp-test-retained-nudges-${process.pid}.log`);
process.env.ACP_LOG_FILE = LOG_FILE;

const MID = "lorem ipsum dolor sit amet ".repeat(400);
const USAGE0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Handler = (event: unknown, ctx: unknown) => unknown;
type Msg = { role: string; content: unknown; toolCallId?: string };

const msg = (id: string, message: Record<string, unknown>) => ({ type: "message", id, parentId: null, timestamp: "", message: { timestamp: 1, ...message } });
const user = (id: string, text: string) => msg(id, { role: "user", content: text });
const assistant = (id: string, content: unknown[], stopReason = "stop") => msg(id, { role: "assistant", content, api: "x", provider: "x", model: "m", usage: USAGE0, stopReason });
const toolResult = (id: string, callId: string, text: string) => msg(id, { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text }], isError: false });

async function session(name: string, opts: { api?: string; compress?: unknown; turns?: number; systemPrompt?: string } = {}) {
  const api = opts.api ?? "claude-bridge";
  const sid = `retained-${name}`;
  const cwd = await mkdtemp(join(tmpdir(), "acp-retained-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "acp.json"), JSON.stringify({ compress: opts.compress ?? {} }));
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
  const h = { entries: [user("u0", "start " + MID)] as unknown[] };
  for (let i = 1; i < (opts.turns ?? 40); i++) h.entries.push(i % 2 ? assistant(`e${i}`, [{ type: "text", text: `turn ${i} ` + MID }]) : user(`e${i}`, `turn ${i} ` + MID));
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool(tool: never) { tools.set((tool as { name: string }).name, tool); },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry(customType: string, data?: unknown) { h.entries = [...h.entries, { type: "custom", id: `c${h.entries.length}`, parentId: null, timestamp: "", customType, data }]; },
    getThinkingLevel: () => "off",
    getActiveTools: () => ["compress", "read"],
    getAllTools: () => [{ name: "compress", description: "c", parameters: { type: "object", properties: {} } }],
    events: createEventBus(),
  };
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false })(pi as never);
  const ctx = {
    mode: "rpc", hasUI: false, cwd,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { api, provider: api, id: "m", contextWindow: 200_000, maxTokens: 0, input: ["text"], reasoning: false, baseUrl: api, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    getContextUsage: () => null,
    getSystemPrompt: () => opts.systemPrompt ?? "",
    modelRegistry: { getProvider: () => ({}), getProviderAuth: async () => undefined },
    sessionManager: { buildContextEntries: () => h.entries, getSessionId: () => sid, getSessionFile: () => join(cwd, "session.json") },
  };
  const emit = async (event: string, payload: object = {}) => {
    let last: unknown;
    for (const fn of handlers.get(event) ?? []) last = await fn({ type: event, messages: [], ...payload }, ctx);
    return last;
  };
  const request = async () => ((await emit("context")) as { messages: Msg[] }).messages;
  const nudges = (ms: Msg[]) => ms.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("Compression Philosophy"));
  const tokensLogged = () => {
    const lines = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.includes(`sid=${sid} model=`)) : [];
    return Number(/ tokens=(\d+)/.exec(lines.at(-1) ?? "")?.[1]);
  };
  const add = (...es: unknown[]) => { h.entries = [...h.entries, ...es]; };
  return { h, emit, request, nudges, add, tools, tokensLogged, ctx, sid };
}

// A main turn that ends on a parallel tool-result batch, then the request that carries it.
async function nudgedAfterParallelResults(name: string, opts: Parameters<typeof session>[1] = {}) {
  const s = await session(name, opts);
  s.add(user("p1", "read two files"), assistant("a1", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }, { type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } }], "toolUse"), toolResult("r1", "c1", "file a"), toolResult("r2", "c2", "file b"));
  const first = await s.request();
  assert.equal(s.nudges(first).length, 1, "the nudge goes out with the tool results");
  assert.equal(first.at(-1), s.nudges(first)[0]);
  return { s, first };
}

test("claude-bridge keeps its nudge, unchanged, right after the tool results it followed, so the next request extends the previous one", async () => {
  const { s, first } = await nudgedAfterParallelResults("keep");
  s.add(assistant("a2", [{ type: "text", text: "done" }]), user("p2", "next"));
  const next = await s.request();
  assert.deepEqual(next.slice(0, first.length), first, "the previous request is an exact prefix of the next");
  const at = next.indexOf(s.nudges(next)[0]!);
  assert.equal(next[at - 1]!.role, "toolResult", "after the last result of the parallel batch");
  assert.equal(next[at + 1]!.role, "assistant", "and before the next assistant message, so tool pairing is unchanged");
  assert.equal(s.nudges(next).length, 1, "no second nudge");
});

test("the same request sent again carries the nudge once, not twice", async () => {
  const { s, first } = await nudgedAfterParallelResults("retry");
  assert.deepEqual(await s.request(), first);
});

test("a nudge whose anchor is folded, branched away or reset is no longer sent", async () => {
  const folded = await nudgedAfterParallelResults("fold");
  assert.deepEqual(await folded.s.request(), folded.first, "kept before the change");
  const text = (await folded.s.tools.get("compress")!.execute("fold-call", { content: [{ startId: "m00002", endId: "m00045", summary: "early turns and the two reads: lorem ipsum filler and two short files, nothing decided" }] }, undefined, undefined, folded.s.ctx)).content[0]!.text;
  assert.match(text, /ACP/);
  folded.s.add(assistant("fa", [{ type: "toolCall", id: "fold-call", name: "compress", arguments: {} }], "toolUse"), msg("fr", { role: "toolResult", toolCallId: "fold-call", toolName: "compress", content: [{ type: "text", text }], isError: false }));
  assert.equal(folded.s.nudges(await folded.s.request()).filter((m) => JSON.stringify(m.content) === JSON.stringify(folded.first.at(-1)!.content)).length, 0, "folded anchor: gone");

  const branched = await nudgedAfterParallelResults("branch");
  assert.deepEqual(await branched.s.request(), branched.first, "kept before the change");
  branched.s.h.entries = branched.s.h.entries.filter((e) => !["r2"].includes((e as { id: string }).id));
  branched.s.add(toolResult("r2b", "c2", "file b, edited"));
  assert.ok(!(await branched.s.request()).includes(branched.first.at(-1)!), "edited anchor: gone");

  const reset = await nudgedAfterParallelResults("reset");
  assert.deepEqual(await reset.s.request(), reset.first, "kept before the change");
  await reset.s.emit("session_before_tree");
  reset.s.add(assistant("a2", [{ type: "text", text: "done" }]), user("p2", "next"));
  const after = await reset.s.request();
  assert.ok(!after.slice(0, -1).some((m) => JSON.stringify(m.content) === JSON.stringify(reset.first.at(-1)!.content)), "lifecycle reset: gone");
});

test("only claude-bridge retains: other wires keep the nudge request-local", async () => {
  const { s } = await nudgedAfterParallelResults("direct", { api: "anthropic-messages" });
  s.add(assistant("a2", [{ type: "text", text: "done" }]), user("p2", "next"));
  const next = await s.request();
  assert.ok(next.slice(0, -1).every((m) => !JSON.stringify(m.content).includes("Compression Philosophy")));
});

test("retained nudges count toward the estimate like the system prompt", async () => {
  const bridge = await nudgedAfterParallelResults("tokens-bridge");
  const direct = await nudgedAfterParallelResults("tokens-direct", { api: "anthropic-messages" });
  for (const s of [bridge.s, direct.s]) {
    s.add(assistant("a2", [{ type: "text", text: "done" }]), user("p2", "next"));
    await s.request();
  }
  assert.equal(bridge.s.tokensLogged() - direct.s.tokensLogged(), defaultCountTokens(extractText(bridge.first.at(-1)!.content)));
});

test("emergency nudges stay request-local, and a kept async hint does not reopen the queue in an emergency", async () => {
  const s = await session("emergency", { compress: { async: true, asyncClaudeBridge: true }, turns: 40 });
  const first = await s.request();
  assert.equal(s.nudges(first).length, 1);
  assert.match(JSON.stringify(first.at(-1)!.content), /compress\(\{ content: \[\] \}\) queues/, "the kept nudge carries the async hint");
  for (let i = 0; i < 60; i++) s.add(i % 2 ? assistant(`g${i}`, [{ type: "text", text: MID }]) : user(`g${i}`, MID));
  const emergency = await s.request();
  assert.match(JSON.stringify(emergency.at(-1)!.content), /Context limit reached|EMERGENCY/i);
  assert.match((await s.tools.get("compress")!.execute("em", { content: [] }, undefined, undefined, s.ctx)).content[0]!.text, /not available while the context is nearly full/);
  s.add(assistant("g-a", [{ type: "text", text: "ok" }]), user("g-u", "next"));
  const after = await s.request();
  const emergencyText = JSON.stringify(emergency.at(-1)!.content);
  assert.equal(after.slice(0, -1).filter((m) => JSON.stringify(m.content) === emergencyText).length, 0, "the emergency nudge was not kept");
});

test("RetainedNudges: replay after each anchor once, prune by sent ids, same anchor replaces, drop and reset", () => {
  const r = new RetainedNudges<string>();
  r.retain("s", "a", "n1", 3);
  r.retain("s", "b", "n2", 4);
  r.retain("s", "a", "n1b", 5);
  assert.deepEqual(r.replay("s", ["A", "x", "B"], ["a", "x", "b"]), ["A", "n1b", "x", "B", "n2"]);
  assert.equal(r.prune("s", new Set(["b"])), 4, "anchor a is no longer sent");
  assert.deepEqual(r.replay("s", ["B"], ["b"]), ["B", "n2"]);
  assert.deepEqual(r.replay("s", ["B"], ["b", "extra"]), ["B"], "ids out of step: nothing inserted");
  assert.equal(r.at("s", "b"), "n2");
  r.drop("s", "b");
  assert.equal(r.at("s", "b"), undefined);
  r.retain("s", "c", "n3", 1);
  r.reset("s");
  assert.deepEqual(r.replay("s", ["C"], ["c"]), ["C"]);
});

test("an empty trigger's emergency decision counts the retained nudges", async () => {
  // Smallest system-prompt padding at which compress([]) is refused as an emergency on claude-bridge.
  const probe = async (words: number, clearRetained: boolean) => {
    const s = await session(`threshold-${words}-${clearRetained}`, { compress: { async: true, asyncClaudeBridge: true }, systemPrompt: "pad ".repeat(words) });
    const first = await s.request();
    if (s.nudges(first).length !== 1 || /EMERGENCY/.test(JSON.stringify(first.at(-1)))) return "no-retained";
    if (clearRetained) await s.emit("session_before_tree");
    return (await s.tools.get("compress")!.execute(`t-${words}`, { content: [] }, undefined, undefined, s.ctx)).content[0]!.text;
  };
  const emergency = (t: string) => /not available while the context is nearly full/.test(t);
  const atOrAbove = (t: string) => t === "no-retained" || emergency(t);
  let lo = 0;
  let hi = 400_000;
  assert.ok(atOrAbove(await probe(hi, false)), "upper bound is past the threshold");
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (atOrAbove(await probe(mid, false))) hi = mid;
    else lo = mid;
  }
  assert.match(await probe(lo, false), /Background compression queued/, "just below: queued");
  assert.ok(emergency(await probe(hi, false)), "the request still carried an ordinary nudge, yet with it retained the trigger is refused");
  assert.match(await probe(hi, true), /Background compression queued/, "at the boundary, without the retained nudge it would have queued");
});

test("a sync compress decision counts the retained nudges too", async () => {
  const sent = async (name: string, clearRetained: boolean) => {
    const s = await session(name);
    assert.equal(s.nudges(await s.request()).length, 1);
    if (clearRetained) await s.emit("session_before_tree");
    setDebugEnabled(true);
    try {
      await s.tools.get("compress")!.execute("sync-1", { content: [{ startId: "m00002", endId: "m00004", summary: "early lorem ipsum turns, nothing the task still needs" }] }, undefined, undefined, s.ctx);
    } finally {
      setDebugEnabled(false);
    }
    const line = readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.includes("compress-in") && l.includes(`retained-${name}`)).at(-1) ?? "";
    return Number(/"?sentTokens"?[=:](\d+)/.exec(line)?.[1]);
  };
  const withRetained = await sent("sync-retained", false);
  const without = await sent("sync-cleared", true);
  assert.ok(Number.isFinite(withRetained) && Number.isFinite(without), `sentTokens logged (${withRetained}, ${without})`);
  assert.ok(withRetained > without, `retained nudge counted: ${withRetained} > ${without}`);
});
