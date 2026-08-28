import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { setRunNpmForTest } from "../src/update.js";

// Headless handlers await the update check — keep every test hermetic by
// resolving it through this fake (no network, no update available).
setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));

// Never touch the real throttle file under the user's home dir: parallel test
// processes race on it (one stamps while another just deleted it → the check
// silently skips "npm view" and the test times out). Per-pid temp file + env
// override (src/update.ts reads it lazily) keeps this file hermetic.
const UPDATE_THROTTLE_FILE = join(tmpdir(), `acp-test-update-throttle-${process.pid}`);
process.env.ACP_UPDATE_THROTTLE_FILE = UPDATE_THROTTLE_FILE;

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

test("factory registers the compress tool and 6 flat commands", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false })(api as any);

  assert.ok(api.tools.some((t) => t.name === "compress"), "compress tool registered");
  assert.deepEqual([...api.commands.keys()].sort(), ["acp", "acp-decompress", "acp-rollover", "acp-search", "acp-status", "acp-subagents"]);
  assert.ok(handlers.has("context"), "context event wired");
  assert.ok(handlers.has("session_before_compact"), "compaction-disable wired");
  assert.ok(handlers.has("before_agent_start"), "system-prompt wired");
});

test("session_before_compact cancels Pi's auto-compaction", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false })(api as any);
  const result = handlers.get("session_before_compact")![0]!({}, {});
  assert.deepEqual(result, { cancel: true });
});

test("before_agent_start appends the ACP system prompt", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false })(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {});
  assert.ok(result.systemPrompt.startsWith("BASE"));
  assert.ok(result.systemPrompt.includes("compress"));
  assert.ok(result.systemPrompt.includes("acp"));
});

test("context handler tags every message with a ref even when length matches event.messages", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);

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
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);

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
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/nonexistent-pai-acp-omp-lag.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  // Simulate omp's real timing: the branch only holds the PREVIOUS turn's
  // messages (the current user message is persisted only after the LLM call,
  // in message_end, which omp emits AFTER transformContext → emitContext).
  const persisted = [userMsg("e1", "first")];
  const liveMessages = [
    { role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() },
    { role: "user", content: [{ type: "text", text: "SECOND MESSAGE" }], timestamp: Date.now() },
  ];
  const ctx = {
    ...fakeCtx(persisted, stateFile),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
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
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);

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

test("omp migrates tagged live refs to stable entry ids", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-identity.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const texts = ["This tagged message must retain its stable persisted identity. ".repeat(130), "filler two ".repeat(400)];
  let persisted: ReturnType<typeof userMsg>[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const first = await handlers.get("context")![0]!({ type: "context", messages: texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })) }, ctx);
  const targetRef = first.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  persisted = texts.map((text, index) => userMsg(`e${index + 1}`, text));
  await handlers.get("context")![0]!({ type: "context", messages: first.messages }, ctx);
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw.e1, targetRef);
  assert.equal(saved.messageRefs.byRaw["live-0"], undefined);
});

test("omp matches a persisted context suffix before assigning live refs", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-suffix.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const texts = ["This suffix message must retain its persisted identity. ".repeat(130), "filler two ".repeat(400)];
  const persisted = [userMsg("older", "This older branch message is absent from provider context."), ...texts.map((text, index) => userMsg(`e${index + 1}`, text))];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const transformed = await handlers.get("context")![0]!({ type: "context", messages: texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })) }, ctx);
  const targetRef = transformed.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw.e1, targetRef);
  assert.equal(saved.messageRefs.byRaw["live-0"], undefined);
});

test("omp rejects a non-contiguous persisted subsequence", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-gap.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const persisted = [userMsg("e1", "A"), userMsg("gap", "X"), userMsg("e2", "B")];
  const ctx = fakeCtx(persisted, stateFile);
  const result = await handlers.get("context")![0]!({ type: "context", messages: [
    { role: "user", content: "A", timestamp: 1 },
    { role: "user", content: "B", timestamp: 2 },
  ] }, ctx);
  const firstRef = result.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw.e1, undefined);
  assert.equal(saved.messageRefs.byRaw["live-0"], firstRef);
});

test("omp rejects ambiguous equal-length persisted runs", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-ambiguous-run.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const persisted = [userMsg("e1", "same"), userMsg("gap", "different"), userMsg("e2", "same")];
  const ctx = fakeCtx(persisted, stateFile);
  const result = await handlers.get("context")![0]!({
    type: "context",
    messages: [{ role: "user", content: "same", timestamp: 1 }],
  }, ctx);
  const liveRef = result.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw.e1, undefined);
  assert.equal(saved.messageRefs.byRaw.e2, undefined);
  assert.equal(saved.messageRefs.byRaw["live-0"], liveRef);
});

test("omp migrates a live ref after the provider context evicts its prefix", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-shifted-live-ref.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  let persisted: ReturnType<typeof userMsg>[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const first = await handlers.get("context")![0]!({ type: "context", messages: ["A", "B", "C"].map((text) => ({ role: "user", content: text, timestamp: Date.now() })) }, ctx);
  const bRef = first.messages[1].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  persisted = [userMsg("eA", "A"), userMsg("eB", "B"), userMsg("eC", "C")];
  await handlers.get("context")![0]!({ type: "context", messages: [first.messages[1], first.messages[2]] }, ctx);
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw.eB, bRef);
  assert.equal(saved.messageRefs.byRaw["live-1"], undefined);
  assert.equal(saved.messageRefs.byRef[bRef], "eB");
});
type PersistedEntry = { type: "message"; id: string; parentId: null; timestamp: string; message: Record<string, unknown> };

test("omp does not bind a different toolCallId with identical visible text to the persisted identity", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-toolcallid.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const toolResult = (toolCallId: string) => ({
    role: "toolResult",
    toolName: "bash",
    toolCallId,
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: Date.now(),
  });
  let persisted: PersistedEntry[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const first = await handlers.get("context")![0]!({ type: "context", messages: [toolResult("call-1")] }, ctx);
  const targetRef = first.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  persisted = [{ type: "message", id: "e1", parentId: null, timestamp: "", message: toolResult("call-1") }];
  await handlers.get("context")![0]!({ type: "context", messages: [toolResult("call-2")] }, ctx);
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw.e1, undefined, "a different toolCallId must not inherit the persisted identity");
  assert.equal(saved.messageRefs.byRaw["live-0"], targetRef, "the live message keeps its own ref");
});

test("omp does not bind differing image content with identical visible text to the persisted identity", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-image.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const imgMsg = (data: string) => ({
    role: "user",
    content: [
      { type: "text", text: "see" },
      { type: "image", data, mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });
  let persisted: PersistedEntry[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const first = await handlers.get("context")![0]!({ type: "context", messages: [imgMsg("img-1")] }, ctx);
  const targetRef = first.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  persisted = [{ type: "message", id: "e1", parentId: null, timestamp: "", message: imgMsg("img-1") }];
  await handlers.get("context")![0]!({ type: "context", messages: [imgMsg("img-2")] }, ctx);
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw.e1, undefined, "different image data must not inherit the persisted identity");
  assert.equal(saved.messageRefs.byRaw["live-0"], targetRef, "the live message keeps its own ref");
});

test("omp matches emergency-truncated tool results before compression", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const dir = await mkdtemp(join(tmpdir(), "pai-acp-omp-truncation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");
  const originalText = "This large tool output must retain its persisted identity. ".repeat(130);
  const truncatedText = `${originalText.slice(0, 2000)}\n\n...[truncated for context space] — original ~1500 tokens]...\n\n${originalText.slice(-2000)}`;
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const persisted = [
    { type: "message", id: "e1", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "read", toolCallId: "call-read", content: [{ type: "text", text: originalText }], timestamp: Date.now() } },
    ...["two", "three", "four", "five", "six", "seven"].map((n, index) => userMsg(`e${index + 2}`, filler(n))),
  ];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const liveMessages = [
    { role: "toolResult", toolName: "read", toolCallId: "call-read", content: [{ type: "text", text: truncatedText }], timestamp: Date.now() },
    ...["two", "three", "four", "five", "six", "seven"].map((n) => ({ role: "user", content: [{ type: "text", text: filler(n) }], timestamp: Date.now() })),
  ];
  const transformed = await handlers.get("context")![0]!({ type: "context", messages: liveMessages }, ctx);
  const targetRef = transformed.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const result = await compressTool.execute("tc-omp-truncation", { content: [{ startId: targetRef, endId: targetRef, summary: "This large tool result was emergency-truncated in provider context and is now safely compressed from the original entry." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /1 block/, result.content[0].text);
});

test("omp does not collapse distinct multimodal user messages with identical text (images survive)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);

  const persistedImage = { type: "image", mimeType: "image/png", data: "persisted-image-payload" };
  const liveImage = { type: "image", mimeType: "image/png", data: "live-image-payload" };
  const persisted = [
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "",
      message: { role: "user", content: [{ type: "text", text: "what is this?" }, persistedImage], timestamp: Date.now() },
    },
  ];
  const liveMessages = [{ role: "user", content: [{ type: "text", text: "what is this?" }, liveImage], timestamp: Date.now() }];
  const ctx = {
    ...fakeCtx(persisted, "/tmp/nonexistent-pai-acp-omp-images.session.json"),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-pai-acp-omp-images.session.json",
    },
  };

  const result = await handlers.get("context")![0]!({ type: "context", messages: liveMessages }, ctx);
  assert.ok(result, "handler must not throw");
  assert.equal(result.messages.length, 1, "the live multimodal message must survive the transform");
  const content = result.messages[0].content;
  const imageBlocks = content.filter((b: { type?: string; data?: string }) => b.type === "image");
  assert.equal(imageBlocks.length, 1, "exactly one image block must survive");
  assert.equal(imageBlocks[0]!.data, "live-image-payload", "the LIVE image payload must survive, not the persisted one");
  assert.ok(!content.some((b: { type?: string; data?: string }) => b.data === "persisted-image-payload"), "persisted image must not replace the live one");
});

test("omp does not collapse distinct multimodal tool results with identical text (images survive)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);

  const persistedImage = { type: "image", mimeType: "image/png", data: "persisted-image-payload" };
  const liveImage = { type: "image", mimeType: "image/png", data: "live-image-payload" };
  const persisted = [
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "",
      message: { role: "toolResult", toolName: "read", toolCallId: "call-read", content: [{ type: "text", text: "same tool output" }, persistedImage], timestamp: Date.now() },
    },
  ];
  const liveMessages = [{ role: "toolResult", toolName: "read", toolCallId: "call-read", content: [{ type: "text", text: "same tool output" }, liveImage], timestamp: Date.now() }];
  const ctx = {
    ...fakeCtx(persisted, "/tmp/nonexistent-pai-acp-omp-toolresult-images.session.json"),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-pai-acp-omp-toolresult-images.session.json",
    },
  };

  const result = await handlers.get("context")![0]!({ type: "context", messages: liveMessages }, ctx);
  assert.ok(result, "handler must not throw");
  assert.equal(result.messages.length, 1, "the live multimodal tool result must survive the transform");
  const content = result.messages[0].content;
  const imageBlocks = content.filter((b: { type?: string; data?: string }) => b.type === "image");
  assert.equal(imageBlocks.length, 1, "exactly one image block must survive");
  assert.equal(imageBlocks[0]!.data, "live-image-payload", "the LIVE image payload must survive, not the persisted one");
  assert.ok(!content.some((b: { type?: string; data?: string }) => b.data === "persisted-image-payload"), "persisted image must not replace the live one");
});

test("acp_status refs remain usable by the next compress call", async () => {
  const { api } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-status-compress.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const originalText = "This range is reported by acp_status and must remain addressable by compress. ".repeat(130);
  const persisted = [userMsg("e1", originalText), ...["two", "three", "four", "five", "six", "seven"].map((n, index) => userMsg(`e${index + 2}`, `filler ${n} `.repeat(400)))];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const statusTool = api.tools.find((tool: { name: string }) => tool.name === "acp_status")!;
  const status = await statusTool.execute("tc-status", {}, undefined, undefined, ctx);
  const targetRef = status.content[0].text.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const result = await compressTool.execute("tc-status-compress", { content: [{ startId: targetRef, endId: targetRef, summary: "This range was selected by acp_status and is now safely compressed from the original entry." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /1 block/, result.content[0].text);
});

test("omp rebuilds refs after stale live state before status compression", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-stale-live.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const longText = "This stale live state must be rebuilt against the current persisted branch. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const texts = [longText, filler("two"), filler("three"), filler("four"), filler("five"), filler("six"), filler("seven")];
  let persisted: ReturnType<typeof userMsg>[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const liveMessages = texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }));
  await handlers.get("context")![0]!({ type: "context", messages: liveMessages }, ctx);
  persisted = texts.map((text, index) => userMsg(`e${index + 1}`, text));
  const statusTool = api.tools.find((tool: { name: string }) => tool.name === "acp_status")!;
  const status = await statusTool.execute("tc-stale-live-status", {}, undefined, undefined, ctx);
  const targetRef = status.content[0].text.match(/m\d{5}/)![0];
  assert.equal(targetRef, "m00001", status.content[0].text);
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const result = await compressTool.execute("tc-stale-live-compress", { content: [{ startId: targetRef, endId: targetRef, summary: "This stale live range was rebuilt against stable persisted entries and is now safely compressed." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /1 block/, result.content[0].text);
});

test("system prompt sources compression rules from acp-kernel (no hardcoded drift, no markers)", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false })(api as any);
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
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);

  const entries = [userMsg("e1", "alpha"), userMsg("e2", "beta")];
  const ctx = fakeCtx(entries, "/tmp/nonexistent-pai-acp-it2.session.json");


  const first = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const second = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  assert.equal(first.messages.length, second.messages.length);
  const tag1 = ((first.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  const tag2 = ((second.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  assert.equal(tag1?.text, tag2?.text, "refs stable across calls (loaded from persisted state)");
});
test("omp migrates assistant tool-call refs after prefix eviction", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-assistant-origin.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const assistant = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "x" } }], timestamp: Date.now() });
  let persisted: ReturnType<typeof userMsg>[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  await handlers.get("context")![0]!({ type: "context", messages: [assistant("call-a")] }, ctx);
  const firstState = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  const ref = firstState.messageRefs.byRaw["live-0"];
  assert.ok(ref, "assistant temporary ref must be assigned");
  persisted = [userMsg("older", "evicted"), { type: "message", id: "e-assistant", parentId: null, timestamp: "", message: assistant("call-a") }];
  await handlers.get("context")![0]!({ type: "context", messages: [assistant("call-a")] }, ctx);
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw["e-assistant"], ref);
  assert.equal(saved.messageRefs.byRaw["live-0"], undefined);
});

test("omp migrates parallel assistant tool-call child refs after prefix eviction", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-parallel-origin.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const assistant = () => ({ role: "assistant", content: [
    { type: "text", text: "parallel" },
    { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "call-b", name: "write", arguments: { path: "b" } },
  ], timestamp: Date.now() });
  let persisted: ReturnType<typeof userMsg>[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  await handlers.get("context")![0]!({ type: "context", messages: [assistant()] }, ctx);
  const first = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  const callARef = first.messageRefs.byRaw["live-0#call-a"];
  const callBRef = first.messageRefs.byRaw["live-0#call-b"];
  assert.ok(callARef && callBRef);
  persisted = [{ type: "message", id: "e-assistant", parentId: null, timestamp: "", message: assistant() }];
  await handlers.get("context")![0]!({ type: "context", messages: [assistant()] }, ctx);
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw["e-assistant#call-a"], callARef);
  assert.equal(saved.messageRefs.byRaw["e-assistant#call-b"], callBRef);
  assert.equal(saved.messageRefs.byRaw["live-0#call-a"], undefined);
  assert.equal(saved.messageRefs.byRaw["live-0#call-b"], undefined);
});

test("omp reloads assistant origins before migrating after prefix eviction", async () => {
  const stateFile = "/tmp/nonexistent-pai-acp-assistant-reload.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const assistant = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "x" } }], timestamp: Date.now() });
  let persisted: ReturnType<typeof userMsg>[] = [];
  const makeCtx = () => ({ ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } });
  const first = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(first.api);
  await first.handlers.get("context")![0]!({ type: "context", messages: [assistant("call-a")] }, makeCtx());
  const initial = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  const ref = initial.messageRefs.byRaw["live-0"];
  assert.ok(ref);
  const second = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(second.api);
  persisted = [{ type: "message", id: "e-assistant", parentId: null, timestamp: "", message: assistant("call-a") }];
  await second.handlers.get("context")![0]!({ type: "context", messages: [assistant("call-a")] }, makeCtx());
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw["e-assistant"], ref);
  assert.equal(saved.messageRefs.byRaw["live-0"], undefined);
  assert.equal(saved.messageRefs.byRef[ref], "e-assistant");
});

test("omp preserves stable destination when migrating a colliding live ref", async () => {
  const stateFile = "/tmp/nonexistent-pai-acp-collision.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const assistant = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "x" } }], timestamp: Date.now() });
  let persisted: ReturnType<typeof userMsg>[] = [];
  const makeCtx = () => ({ ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } });
  const first = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(first.api);
  await first.handlers.get("context")![0]!({ type: "context", messages: [assistant("call-a")] }, makeCtx());
  const initial = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  const liveRef = initial.messageRefs.byRaw["live-0"];
  assert.ok(liveRef);
  const stableRef = "m09999";
  initial.messageRefs.byRaw["e-assistant"] = stableRef;
  initial.messageRefs.byRef[stableRef] = "e-assistant";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${stateFile}.acp.json`, JSON.stringify(initial), "utf8");
  const second = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(second.api);
  persisted = [{ type: "message", id: "e-assistant", parentId: null, timestamp: "", message: assistant("call-a") }];
  await second.handlers.get("context")![0]!({ type: "context", messages: [assistant("call-a")] }, makeCtx());
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.messageRefs.byRaw["e-assistant"], stableRef);
  assert.equal(saved.messageRefs.byRef[stableRef], "e-assistant");
  assert.equal(saved.messageRefs.byRaw["live-0"], undefined);
  assert.equal(saved.messageRefs.byRef[liveRef], undefined);
});

test("empty live context preserves refs created for an unpersisted message", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api);
  const stateFile = "/tmp/nonexistent-pai-acp-empty-live.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx([], stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "live-only" }] }, ctx);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const state = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(state.messageRefs.byRaw["live-0"], "m00001");
});
test("omp keeps compression blocks active when provider context has an extra prefix", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "pai-acp-omp-provider-prefix-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");
  const texts = [
    "This first message is large enough to compress. ".repeat(130),
    "This second message is also part of the compressed range. ".repeat(130),
    ...["three", "four", "five", "six", "seven"].map((n) => `filler ${n} `.repeat(400)),
  ];
  const persisted = texts.map((text, index) => userMsg(`e${index + 1}`, text));
  const ctx = {
    ...fakeCtx(persisted, stateFile),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
  const initial = await handlers.get("context")![0]!(
    { type: "context", messages: texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })) },
    ctx,
  );
  const first = initial.messages[0] as { content: Array<{ type?: string; text?: string }> };
  const targetRef = first.content.find((block) => block.type === "text")!.text!.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const compressed = await compressTool.execute(
    "tc-omp-provider-prefix",
    { content: [{ startId: targetRef, endId: "m00002", summary: "The first two messages were compressed into a durable ACP summary." }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(compressed.content[0].text, /1 block/);

  const next = await handlers.get("context")![0]!(
    {
      type: "context",
      messages: [
        { role: "user", content: [{ type: "text", text: "provider-only context prefix" }], timestamp: Date.now() },
        ...texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })),
      ],
    },
    ctx,
  );
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.blocks[0].active, true, "the compressed block must remain active after the prefix");
  assert.ok(next.messages.length < texts.length + 1, "covered messages must be replaced in provider context");
});

test("omp keeps compression active when persisted and provider tails diverge", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "pai-acp-omp-branch-divergence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");
  const commonTexts = [
    "This first common message is large enough to compress. ".repeat(130),
    "This second common message is also part of the compressed range. ".repeat(130),
    ...["three", "four", "five", "six", "seven"].map((n) => `common filler ${n} `.repeat(400)),
  ];
  let persisted = commonTexts.map((text, index) => userMsg(`e${index + 1}`, text));
  const ctx = {
    ...fakeCtx(persisted, stateFile),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
  const liveCommon = commonTexts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }));
  const initial = await handlers.get("context")![0]!({ type: "context", messages: liveCommon }, ctx);
  const first = initial.messages[0] as { content: Array<{ type?: string; text?: string }> };
  const targetRef = first.content.find((block) => block.type === "text")!.text!.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const compressed = await compressTool.execute(
    "tc-omp-branch-divergence",
    { content: [{ startId: targetRef, endId: "m00002", summary: "The first two common messages were compressed into a durable ACP summary." }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(compressed.content[0].text, /1 block/);

  const activeUserText = "current user on the active branch";
  persisted = [...persisted, userMsg("e-active-user", activeUserText)];
  const divergent = await handlers.get("context")![0]!(
    {
      type: "context",
      messages: [
        { role: "user", content: [{ type: "text", text: "projected provider-only prefix" }], timestamp: Date.now() },
        ...liveCommon,
        { role: "assistant", content: [{ type: "text", text: "abandoned branch assistant tail" }], timestamp: Date.now() },
        { role: "user", content: [{ type: "text", text: activeUserText }], timestamp: Date.now() },
      ],
    },
    ctx,
  );
  const saved = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(saved.blocks[0].active, true, "the compressed block must remain active across divergent branch tails");
  assert.ok(divergent.messages.length < commonTexts.length + 3, "covered common messages must stay pruned");
});


test("delegate:false omits the ACP_DELEGATE NOTIFICATIONS section from the system prompt", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, delegate: false })(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, {});
  assert.ok(!result.systemPrompt.includes("ACP_DELEGATE NOTIFICATIONS"), "delegate section omitted when delegate:false");
  // Core ACP prompt is still present — only the delegate section is dropped.
  assert.ok(result.systemPrompt.includes("ACP TAGS"), "core ACP prompt still present when delegate disabled");
});

// ─── ISSUE-9: modelContextLimit changes in <cwd>/.pi/acp.json hot-reload ──

test("modelContextLimit changes in .pi/acp.json are picked up on the next context event", async () => {
  (globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { formatCompactTokens } = await import("acp-kernel/panel");

  const tmp = mkdtempSync(join(tmpdir(), "acp-hotreload-"));
  const piDir = join(tmp, ".pi");
  mkdirSync(piDir, { recursive: true });
  const acpJson = join(piDir, "acp.json");
  writeFileSync(acpJson, JSON.stringify({ modelContextLimit: 100_000 }));

  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ rollover: false })(api as any);

    function ctxWithCwd() {
      return { ...fakeCtx([], join(tmp, "state.json")), cwd: tmp };
    }
    async function acpStatus(): Promise<string> {
      let captured = "";
      const ctx = {
        ...fakeCtx([], join(tmp, "state.json")),
        cwd: tmp,
        ui: { notify: (s: string) => { captured = s; }, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
      };
      await api.commands.get("acp").handler([], ctx);
      return captured;
    }

    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctxWithCwd());
    assert.ok((await acpStatus()).includes(formatCompactTokens(100_000)), "initial limit reflects acp.json modelContextLimit=100000");

    writeFileSync(acpJson, JSON.stringify({ modelContextLimit: 250_000 }));
    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctxWithCwd());
    assert.ok((await acpStatus()).includes(formatCompactTokens(250_000)), "rewritten modelContextLimit=250000 hot-reloaded on next context event");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── ISSUE-8: headless hosts must stay alive until the update check finishes ──

type NpmResult = { code: number; stdout: string; stderr: string };

function pendingNpm() {
  let resolveView: (r: NpmResult) => void;
  let resolveInstall: (r: NpmResult) => void;
  let viewCalled = false;
  const view = new Promise<NpmResult>((r) => (resolveView = r));
  const install = new Promise<NpmResult>((r) => (resolveInstall = r));
  setRunNpmForTest(async (args) => {
    if (args[0] === "view") {
      viewCalled = true;
      return view;
    }
    return install;
  });
  return {
    viewCalled: () => viewCalled,
    resolveView,
    resolveInstall,
  };
}

async function waitUntil(fn: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

test("headless (hasUI=false) context handler awaits the update check so an exiting process cannot kill an in-flight install", async () => {
  delete process.env.ACP_AUTO_UPDATE;
  await rm(UPDATE_THROTTLE_FILE, { force: true });
  const logFile = join(tmpdir(), `acp-headless-update-${process.pid}.log`);
  process.env.ACP_LOG_FILE = logFile;

  try {
    const npm = pendingNpm();
    const { api, handlers } = captureApi();
    createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
    const stateFile = "/tmp/nonexistent-pai-acp-headless-update.session.json";
    await rm(`${stateFile}.acp.json`, { force: true });
    const ctx = fakeCtx([userMsg("e1", "hi")], stateFile);

    const handlerPromise = handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
    await waitUntil(npm.viewCalled);
    assert.ok(npm.viewCalled(), "check must reach the npm view step");
    // The check is in flight (npm view pending). A headless host exits as soon
    // as this handler settles, so the handler MUST stay pending until then.
    let settled = false;
    handlerPromise.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settled, false, "handler must not settle while the update check is in flight");

    npm.resolveView({ code: 0, stdout: "99.0.0\n", stderr: "" });
    const result = await handlerPromise;
    assert.ok(result, "handler resolves once the check completes");
    // No node_modules ancestor in the test env → install skips; the log proves
    // the check ran through the install attempt (headless has no UI to notify).
    const log = await readFile(logFile, "utf-8");
    assert.ok(log.includes("event=check") && log.includes("latest=99.0.0") && log.includes("hasUpdate=true"), "the check is logged");
    assert.ok(log.includes("install-skip"), "the install skip reason is logged");
  } finally {
    delete process.env.ACP_LOG_FILE;
    await rm(logFile, { force: true });
  }
});

test("TUI (hasUI=true) context handler resolves without waiting for the update check", async () => {
  delete process.env.ACP_AUTO_UPDATE;
  await rm(UPDATE_THROTTLE_FILE, { force: true });
  const logFile = join(tmpdir(), `acp-tui-update-${process.pid}.log`);
  process.env.ACP_LOG_FILE = logFile;

  try {
    const npm = pendingNpm();
    const { api, handlers } = captureApi();
    createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
    const stateFile = "/tmp/nonexistent-pai-acp-tui-update.session.json";
    await rm(`${stateFile}.acp.json`, { force: true });
    const ctx = { ...fakeCtx([userMsg("e1", "hi")], stateFile), hasUI: true };

    const handlerPromise = handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
    const outcome = await Promise.race([
      handlerPromise.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("still-pending"), 500)),
    ]);
    assert.equal(outcome, "settled", "TUI handler must resolve while the update check is in flight");
    // The view promise is still pending here — proves the handler did not wait.
    await waitUntil(npm.viewCalled);
    assert.ok(npm.viewCalled(), "check started (npm view pending) while the TUI handler already settled");
    npm.resolveView({ code: 0, stdout: "0.0.1\n", stderr: "" });
    for (let i = 0; i < 200; i++) {
      if ((await readFile(logFile, "utf-8").catch(() => "")).includes("event=check")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    delete process.env.ACP_LOG_FILE;
    await rm(logFile, { force: true });
  }
});
