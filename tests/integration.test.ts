import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";

// Mock Pi's ExtensionAPI — captures the event handlers the factory registers,
// so we can invoke them with a fake ExtensionContext and assert the wiring works.
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
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

function fakeCtx(entries: any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

test("factory registers the compress tool and 4 flat commands", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);

  assert.ok(api.tools.some((t) => t.name === "compress"), "compress tool registered");
  assert.deepEqual([...api.commands.keys()].sort(), ["acp", "acp-decompress", "acp-search", "acp-settings", "acp-status"]);
  assert.ok(handlers.has("context"), "context event wired");
  assert.ok(handlers.has("before_agent_start"), "system-prompt wired");
});

test("session_before_compact intercepts Pi's compaction with ACP compression", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  // /compact must run ACP's compression (create blocks), never return
  // { cancel: true } (which makes Pi throw "Compaction cancelled").
  assert.ok(handlers.has("session_before_compact"), "handler registered — /compact intercepted");
  const result = await handlers.get("session_before_compact")![0]!(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "e1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        fileOps: { readFiles: [], modifiedFiles: [] },
        settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
      },
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    fakeCtx([], "/tmp/nonexistent-pai-acp-it.session.json"),
  );
  // No session file → no ACP state → falls back to Pi's default compaction
  // (undefined), never { cancel: true }.
  assert.ok(result === undefined || (result as { compaction?: unknown })?.compaction !== undefined, "never returns { cancel: true }");
});

test("before_agent_start appends the ACP system prompt", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {});
  assert.ok(result.systemPrompt.startsWith("BASE"));
  assert.ok(result.systemPrompt.includes("compress"));
  assert.ok(result.systemPrompt.includes("acp"));
});

test("context handler tags every message with a ref even when length matches event.messages", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const entries = [userMsg("e1", "first"), userMsg("e2", "second"), userMsg("e3", "third")];
  const ctx = fakeCtx(entries, "/tmp/nonexistent-pai-acp-it.session.json");
  // Real Pi passes event.messages with the same length/roles as the session — the
  // handler must STILL return {messages} (not undefined), or the model never sees tags.
  const sameLengthMessages = entries.map(() => ({ role: "user", content: "x", timestamp: 0 }));

  const result = await handlers.get("context")![0]!({ type: "context", messages: sameLengthMessages }, ctx);
  assert.ok(result, "must return transformed array even when length/roles match (tags must apply)");
  const out = result.messages;
  assert.equal(out.length, 3);
  const firstContent = (out[0] as any).content as any[];
  assert.ok(firstContent.some((b: any) => b.type === "text" && b.text.includes("m0000")), "first msg ref-tagged");
});

test("context handler works under omp (oh-my-pi) where sessionManager exposes getBranch() not buildContextEntries()", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const entries = [userMsg("e1", "first"), userMsg("e2", "second")];
  const ctx = {
    ...fakeCtx(entries, "/tmp/nonexistent-pai-acp-omp.session.json"),
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-pai-acp-omp.session.json",
    },
  };
  const sameLengthMessages = entries.map(() => ({ role: "user", content: "x", timestamp: 0 }));

  const result = await handlers.get("context")![0]!({ type: "context", messages: sameLengthMessages }, ctx);
  assert.ok(result, "handler must not throw and must return transformed messages under omp");
  const out = result.messages;
  assert.equal(out.length, 2);
  const firstContent = (out[0] as any).content as any[];
  assert.ok(firstContent.some((b: any) => b.type === "text" && b.text.includes("m0000")), "omp path tags messages with refs");
});

test("omp context handler keeps the current (not-yet-persisted) user message: branch lags event.messages by one", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  // Simulate omp's real timing: the branch only holds the PREVIOUS turn's
  // messages (the current user message is persisted only after the LLM call,
  // in message_end, which omp emits AFTER transformContext → emitContext).
  const persisted = [userMsg("e1", "first")];
  const liveMessages = [
    { role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() },
    { role: "user", content: [{ type: "text", text: "SECOND MESSAGE" }], timestamp: Date.now() },
  ];
  const ctx = {
    ...fakeCtx(persisted, "/tmp/nonexistent-pai-acp-omp-lag.session.json"),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-pai-acp-omp-lag.session.json",
    },
  };

  const result = await handlers.get("context")![0]!({ type: "context", messages: liveMessages }, ctx);
  assert.ok(result, "handler must not throw");
  const out = result.messages;
  assert.equal(out.length, 2, "the not-yet-persisted current message must survive the transform");
  const texts = out.map((m: any) =>
    (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n"),
  );
  assert.ok(texts[0]!.includes("first"), "persisted message present");
  assert.ok(texts[1]!.includes("SECOND MESSAGE"), "live current message present, not dropped");
  assert.ok(texts[1]!.includes("m0000"), "live message ref-tagged");
});

test("omp live message keeps the same entry id once persisted (stable refs across turns)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  // Turn 1: branch empty (brand-new session), event carries the first message.
  const turn1Messages = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }];
  const ctx1 = {
    ...fakeCtx([], "/tmp/nonexistent-pai-acp-omp-stable.session.json"),
    sessionManager: {
      getBranch: () => [] as any[],
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-pai-acp-omp-stable.session.json",
    },
  };
  const r1 = await handlers.get("context")![0]!({ type: "context", messages: turn1Messages }, ctx1);
  assert.ok(r1);
  assert.equal(r1.messages.length, 1, "first-ever message must not be dropped");

  // Turn 2: the message is now persisted (with its real entry id), plus a new
  // not-yet-persisted message. Both must survive; refs must not collide.
  const persistedTurn2 = [userMsg("e1", "hello")];
  const turn2Messages = [
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
    { role: "user", content: [{ type: "text", text: "world" }], timestamp: Date.now() },
  ];
  const ctx2 = {
    ...fakeCtx(persistedTurn2, "/tmp/nonexistent-pai-acp-omp-stable.session.json"),
    sessionManager: {
      getBranch: () => persistedTurn2,
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-pai-acp-omp-stable.session.json",
    },
  };
  const r2 = await handlers.get("context")![0]!({ type: "context", messages: turn2Messages }, ctx2);
  assert.ok(r2);
  assert.equal(r2.messages.length, 2, "both persisted and live messages must survive");
});
test("system prompt sources compression rules from acp-kernel (no hardcoded drift, no markers)", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, {});
  const sp = result.systemPrompt;
  // kernel constants inlined (regression guard against reverting to a hardcoded copy)
  assert.ok(sp.includes("Work from summaries, not raw tool outputs"), "kernel COMPRESS_PHILOSOPHY inlined");
  assert.ok(sp.includes("HOW TO COMPRESS"), "kernel HOW_TO_COMPRESS_RULES inlined");
  assert.ok(sp.includes("TIER 2 COMPRESSION"), "kernel TIER2_DISTILL_RULES inlined");
  assert.ok(sp.includes("TIER 3 COMPRESSION"), "kernel TIER3_CONDENSE_RULES inlined");
  // acp_delegate notification education present (models must learn to treat
  // injected delegate results as system notifications, not user messages)
  assert.ok(sp.includes("ACP_DELEGATE NOTIFICATIONS"), "delegate notification section present");
  assert.ok(/NOT .*(user message|user request)/i.test(sp), "delegates marked as not-user-message");
  assert.ok(/no status tool|NO .?status tool|only way.*acp_delegate_wait/i.test(sp), "wait replaces status tool");
  // marker system removed entirely from kernel constants
  assert.ok(!sp.includes("[[KEEP:"), "no KEEP marker teaching");
  assert.ok(!sp.includes("[[REF:"), "no REF marker teaching");
  assert.ok(!sp.includes("KEEP MARKERS"), "no KEEP MARKERS section");
  // old hardcoded copy removed
  assert.ok(!sp.includes("Two failure modes to avoid"), "old hardcoded philosophy removed");
  assert.ok(!sp.includes("Over-compression: Compressing too aggressively"), "old hardcoded over/under-compression section removed");
});

test("context handler persists state so a second call is idempotent on the same entries", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const entries = [userMsg("e1", "alpha"), userMsg("e2", "beta")];
  const ctx = fakeCtx(entries, "/tmp/nonexistent-pai-acp-it2.session.json");

  const first = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const second = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  assert.equal(first.messages.length, second.messages.length);
  const tag1 = ((first.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  const tag2 = ((second.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  assert.equal(tag1?.text, tag2?.text, "refs stable across calls (loaded from persisted state)");
});

test("delegate:false omits the ACP_DELEGATE NOTIFICATIONS section from the system prompt", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ delegate: false })(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, {});
  assert.ok(!result.systemPrompt.includes("ACP_DELEGATE NOTIFICATIONS"), "delegate section omitted when delegate:false");
  // Core ACP prompt is still present — only the delegate section is dropped.
  assert.ok(result.systemPrompt.includes("ACP TAGS"), "core ACP prompt still present when delegate disabled");
});
