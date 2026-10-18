import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToCoreMessages, coreOutToAgentMessages, isCustomMessageEntry, matchesStoredText, messageIdentity, collectOriginals, CONTEXT_EDIT_ENTRY_TYPE, ACP_STATUS_CUSTOM_TYPE, ACP_EXPORT_CUSTOM_TYPE, ACP_RULE_CUSTOM_TYPE } from "../src/messages.js";
import { isTurnBoundary } from "../src/turn-boundary.js";
import type { CoreMessage } from "acp-kernel";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const LT = "\x3c";
const GT = "\x3e";
function acpRef(ref: string, tokens = "2", type = "text"): string {
  return LT + 'acp tokens="' + tokens + '" type="' + type + '"' + GT + ref + LT + "/acp" + GT;
}

function msgEntry(id: string, message: object): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as SessionMessageEntry["message"],
  };
}

function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function userBlocks(text: string): object {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistantToolCall(name: string): object {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name, arguments: {} }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
function assistantParallelToolCalls(calls: { id: string; name: string; args?: unknown }[]): object {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Running multiple tools" },
      ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
function toolResult(callId: string, name: string, text: string): object {
  return { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

test("entriesToCoreMessages projects user/assistant/toolResult roles and extracts text", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello world")),
    msgEntry("b", userBlocks("block text")),
    msgEntry("c", assistantToolCall("read")),
    msgEntry("d", toolResult("tc1", "read", "file contents")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "hello world");
  assert.equal(core[1]!.text, "block text");
  assert.equal(core[2]!.role, "assistant");
  assert.equal(core[2]!.contentType, "tool-call");
  assert.equal(core[2]!.toolName, "read");
  assert.equal(core[3]!.role, "tool");
  assert.equal(core[3]!.contentType, "tool-result");
  assert.equal(core[3]!.text, "file contents");
});

function assistantThinkingOnly(thinking: string): object {
  return { role: "assistant", content: [{ type: "thinking", thinking }], timestamp: Date.now() };
}
function assistantThinkingAndText(thinking: string, text: string): object {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }, { type: "text", text }],
    timestamp: Date.now(),
  };
}

test("entriesToCoreMessages drops thinking-only assistant turns (no empty assistant text → no provider 400)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    msgEntry("b", assistantThinkingOnly("internal reasoning, no output") as object),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "thinking-only assistant dropped, not emitted as empty text");
  assert.ok(
    !core.some((m) => m.role === "assistant" && (!m.text || !m.text.trim())),
    "no empty-text assistant message in output",
  );
});

test("entriesToCoreMessages keeps assistant turn that has thinking AND text (text extracted, thinking ignored)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", assistantThinkingAndText("private reasoning", "visible answer") as object),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "assistant");
  assert.equal(core[0]!.contentType, "text");
  assert.equal(core[0]!.text, "visible answer", "text kept, thinking block not inlined");
});

test("entriesToCoreMessages drops assistant turn whose text is whitespace-only", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    msgEntry("b", { role: "assistant", content: [{ type: "text", text: "   \n  " }], timestamp: Date.now() } as object),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "whitespace-only assistant dropped");
});

function customEntry(id: string, customType: string, content: string | unknown[]): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    content,
  } as SessionEntry;
}

// SDK ≥1.x context_edit entry (absent from the pinned 0.83.0 types → cast).
function editEntry(id: string, targetId: string, replacement: { content: unknown } | null): SessionEntry {
  return {
    type: CONTEXT_EDIT_ENTRY_TYPE,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    targetId,
    replacement,
  } as SessionEntry;
}

test("entriesToCoreMessages projects custom_message as user message (string content)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello")),
    customEntry("b", "subagent_result", "Sub-agent test completed (6s)."),
    msgEntry("c", user("ok")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 3, "all 3 entries projected");
  assert.equal(core[1]!.id, "b");
  assert.equal(core[1]!.role, "user", "custom_message projected as user");
  assert.equal(core[1]!.contentType, "text");
  assert.equal(core[1]!.text, "Sub-agent test completed (6s).");
});

test("entriesToCoreMessages projects custom_message with array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [{ type: "text", text: "Array content here" }]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "Array content here");
});

test("entriesToCoreMessages drops custom_message with empty content", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    customEntry("b", "subagent_result", ""),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "empty custom_message skipped");
});

test("empty custom_message neither projects nor starts a turn (#364 acceptance c)", () => {
  const empty = customEntry("b", "subagent_result", "");
  assert.equal(isCustomMessageEntry(empty), false, "not a context-participating entry");
  assert.equal(isTurnBoundary(empty, { countCustomMessages: true }), false, "empty control signal starts no turn");
  const full = customEntry("d", "subagent_result", "injected agent turn");
  assert.equal(isCustomMessageEntry(full), true);
  assert.equal(isTurnBoundary(full, { countCustomMessages: true }), true, "non-empty injected turn starts a turn");
});

test("entriesToCoreMessages extracts only text blocks from array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [
      { type: "text", text: "visible text" },
      { type: "image", url: "https://example.com/img.png" },
      { type: "text", text: "more text" },
    ]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1, "entry projected");
  assert.equal(core[0]!.text, "visible text\nmore text", "only text blocks extracted, joined with newline");
});

test("entriesToCoreMessages drops custom_message with non-text-only array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [{ type: "image", url: "https://example.com/img.png" }]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 0, "non-text array content yields empty text → skipped");
});

test("entriesToCoreMessages drops acp-status panels, acp-export docs and acp-rule reports (UI-only, never sent to model)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    customEntry("b", ACP_STATUS_CUSTOM_TYPE, "╭── ACP ──╮\npanel body"),
    customEntry("e", ACP_EXPORT_CUSTOM_TYPE, "# billion-context session handoff\n- session id: x"),
    customEntry("f", ACP_RULE_CUSTOM_TYPE, "1. [rule1] always run typecheck"),
    customEntry("c", "subagent_result", "other custom messages still project"),
    msgEntry("d", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "c", "d"], "acp-status panel, acp-export doc and acp-rule report excluded, other custom messages kept");
});

test("custom_message round-trip: entriesToCoreMessages → collectOriginals → coreOutToAgentMessages preserves user role", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello")),
    customEntry("b", "subagent_result", "Sub-agent test completed (6s)."),
    msgEntry("c", user("ok")),
  ];

  // Step 1: entries → CoreMessage[]
  const coreMessages = entriesToCoreMessages(entries);

  // Step 2: collectOriginals — message entries keep their exact message;
  // custom_message entries are mirrored as user-role AgentMessages
  // (role:"custom" would be silently dropped by Pi).
  const originalById = collectOriginals(entries);

  // Step 3: coreOutToAgentMessages restores from originalById
  const out = coreOutToAgentMessages(coreMessages, originalById);

  // The custom_message (id "b") should be restored as role:"user", not role:"custom"
  const customOut = out.find((m) => (m as { role?: string }).role === "user" &&
    Array.isArray((m as { content?: unknown[] }).content) &&
    ((m as { content: Array<{ type?: string; text?: string }> }).content.some((b) => b.text?.includes("Sub-agent test"))));
  assert.ok(customOut, "custom_message restored as a user message");
  assert.equal((customOut as { role: string }).role, "user", "role is user, not custom");

  // Ensure no role:"custom" in output (that would be silently dropped by Pi)
  const customs = out.filter((m) => (m as { role?: string }).role === "custom");
  assert.equal(customs.length, 0, "no role:custom messages in output");
});

test("entriesToCoreMessages still skips compaction and model_change", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("alpha")),
    { type: "compaction", id: "x", parentId: null, timestamp: "", summary: "s", firstKeptEntryId: "a", tokensBefore: 0 } as SessionEntry,
    { type: "model_change", id: "y", parentId: null, timestamp: "", provider: "p", modelId: "m" } as SessionEntry,
    msgEntry("b", user("beta")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b"]);
});

test("entriesToCoreMessages preserves omp execution roles (bashExecution/pythonExecution) as user text instead of dropping them", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", { role: "user", content: "run ls", timestamp: Date.now() }),
    msgEntry("b", { role: "bashExecution", command: "ls -la", output: [{ type: "text", text: "file1\nfile2" }], exitCode: 0, timestamp: Date.now() } as object),
    msgEntry("c", { role: "pythonExecution", command: "print('hi')", output: "hi", exitCode: 0, timestamp: Date.now() } as object),
    msgEntry("d", { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() } as object),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b", "c", "d"], "no messages dropped");
  const b = core[1]!;
  assert.equal(b.role, "user");
  assert.ok(b.text!.includes("$ ls -la"), "command rendered as $ command");
  assert.ok(b.text!.includes("file1"), "output text preserved");
  const c = core[2]!;
  assert.equal(c.role, "user");
  assert.ok(c.text!.includes("print('hi')"));
  assert.ok(c.text!.includes("hi"));
});

test("entriesToCoreMessages prefers content over fallback fields when an omp role carries both", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", { role: "bashExecution", content: [{ type: "text", text: "primary text" }], command: "should-not-appear", output: "neither", timestamp: Date.now() } as object),
  ];
  const core = entriesToCoreMessages(entries);
  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "primary text");
});

test("coreOutToAgentMessages patches the ref tag onto original messages", () => {
  const tag = acpRef("m00001") + "\n";
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: tag + "hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const content = (out[0] as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]!.type, "text");
  assert.ok(content[0]!.text.includes("hello"), "content includes original text");
  assert.ok(content[0]!.text.includes("m00001"), "content includes ref id");
  assert.equal(content.length, 1, "tag embedded in single text block, not separate");
});

test("coreOutToAgentMessages honors kernel-truncated body instead of original (emergency truncate)", () => {
  const tag = acpRef("m00002", "13K", "tool:bash") + "\n";
  const full = "X".repeat(50000);
  const truncatedBody = "PREFIX".repeat(100) + "\n\n...[truncated for context space]...\n\nSUFFIX";
  const original = msgEntry("t", toolResult("tc1", "bash", full)).message;
  const originalById = new Map([["t", original]]);
  const coreOut: CoreMessage[] = [
    { id: "t", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tc1", text: tag + truncatedBody },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const msg = out[0] as { role: string; toolCallId: string; toolName: string; content: Array<{ type: string; text: string }> };
  assert.equal(msg.role, "toolResult", "role preserved");
  assert.equal(msg.toolCallId, "tc1", "toolCallId preserved");
  const text = msg.content.find((b) => b.type === "text")!.text;
  assert.ok(text.includes("[truncated for context space]"), "truncation marker present in rebuilt body");
  assert.ok(!text.includes("X".repeat(100)), "full original body not emitted");
  assert.ok(text.includes("m00002"), "ref tag preserved");
  assert.ok(text.length < full.length, "body is shorter than original");
});

test("coreOutToAgentMessages does NOT rebuild when non-truncated body starts with newlines (no false positive)", () => {
  const tag = acpRef("m00003", "2", "tool:bash") + "\n";
  const body = "\n\nbash output line";
  const original = msgEntry("n", toolResult("tc3", "bash", body)).message;
  const originalById = new Map([["n", original]]);
  const coreOut: CoreMessage[] = [
    { id: "n", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tc3", text: tag + body },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const text = (out[0] as { content: Array<{ type: string; text: string }> }).content.find((b) => b.type === "text")!.text;
  assert.ok(text.startsWith("\n\nbash output line"), "leading newlines preserved (no false rebuild)");
  assert.ok(!text.includes("[truncated"), "no truncation marker on non-truncated message");
  assert.ok(text.includes("m00003"), "ref tag still appended");
});

test("coreOutToAgentMessages honors kernel-truncated body for string-content tool results", () => {
  const tag = acpRef("m00004", "13K", "tool:bash") + "\n";
  const full = "Y".repeat(40000);
  const truncatedBody = "PRE".repeat(80) + "\n\n...[truncated for context space]...\n\nEND";
  const original = {
    role: "toolResult",
    toolCallId: "tc4",
    toolName: "bash",
    content: full,
    isError: false,
    timestamp: Date.now(),
  };
  const originalById = new Map([["s", original as SessionMessageEntry["message"]]]);
  const coreOut: CoreMessage[] = [
    { id: "s", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tc4", text: tag + truncatedBody },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const msg = out[0] as { role: string; content: string };
  assert.equal(msg.role, "toolResult");
  assert.equal(typeof msg.content, "string", "string content preserved as string");
  assert.ok(msg.content.includes("[truncated for context space]"), "truncated body present");
  assert.ok(!msg.content.includes("Y".repeat(100)), "full original not emitted");
  assert.ok(msg.content.includes("m00004"), "ref tag preserved");
});

test("truncation matching requires the OMP marker", () => {
  assert.equal(matchesStoredText("a\nb", "a\nb"), false);
  assert.equal(matchesStoredText("a\nb", "a\nb\nc"), false);
  assert.equal(matchesStoredText("a\nb", "a\n\nb"), false);
});

test("coreOutToAgentMessages returns original unchanged when no ref tag is present", () => {
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: "hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out[0], original, "un-tagged message returned by reference, untouched");
});

test("coreOutToAgentMessages filters out synthetic summary messages (compress-as-anchor)", () => {
  const originalById = new Map<string, SessionMessageEntry["message"]>();
  const coreOut: CoreMessage[] = [
    { id: "acp_summary_b0", role: "system", contentType: "text", text: "[Compressed conversation section]\nbody" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 0, "synthetic summary messages should be filtered out");
});

test("coreOutToAgentMessages reconstructs parallel tool-call assistant message from split core messages", () => {
  const assistantMsg = assistantParallelToolCalls([
    { id: "call_a", name: "read" },
    { id: "call_b", name: "write" },
    { id: "call_c", name: "list" },
  ]);
  const originalById = new Map([["entry1", assistantMsg as SessionMessageEntry["message"]]]);

  const tag = acpRef("m00003");
  const coreOut: CoreMessage[] = [
    { id: "entry1#call_a", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call_a", text: tag + "\nRunning multiple tools\n{}" },
    { id: "entry1#call_b", role: "assistant", contentType: "tool-call", toolName: "write", toolCallId: "call_b", text: tag + "\n{}" },
    { id: "entry1#call_c", role: "assistant", contentType: "tool-call", toolName: "list", toolCallId: "call_c", text: tag + "\n{}" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 1, "3 split tool-calls merge into 1 assistant message");

  const content = (out[0] as { content: Array<{ type: string; id?: string; text?: string }> }).content;
  const toolCalls = content.filter((b) => b.type === "toolCall");
  assert.equal(toolCalls.length, 3, "all 3 toolCall blocks preserved");
  assert.deepEqual(toolCalls.map((b) => b.id), ["call_a", "call_b", "call_c"]);

  const textBlocks = content.filter((b) => b.type === "text");
  assert.ok(textBlocks.length >= 1, "text block preserved");
  assert.ok(!textBlocks[0]!.text!.includes("m00003"), "assistant message: no tag injected (skip applied)");
});

test("coreOutToAgentMessages drops pruned tool-call blocks when only some survive", () => {
  const assistantMsg = assistantParallelToolCalls([
    { id: "call_a", name: "read" },
    { id: "call_b", name: "write" },
    { id: "call_c", name: "list" },
  ]);
  const originalById = new Map([["entry1", assistantMsg as SessionMessageEntry["message"]]]);

  const coreOut: CoreMessage[] = [
    { id: "entry1#call_a", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call_a", text: "[m00003] {}" },
    { id: "entry1#call_c", role: "assistant", contentType: "tool-call", toolName: "list", toolCallId: "call_c", text: "[m00003] {}" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 1);

  const content = (out[0] as { content: Array<{ type: string; id?: string }> }).content;
  const toolCalls = content.filter((b) => b.type === "toolCall");
  assert.equal(toolCalls.length, 2, "only 2 surviving tool-call blocks");
  assert.deepEqual(toolCalls.map((b) => b.id), ["call_a", "call_c"]);
});

test("message identity ignores tag-only text blocks but preserves original empty blocks", () => {
  const image = { type: "image", data: "same", mimeType: "image/png" };
  const tag = acpRef("m00042");
  const taggedImage = { role: "user", content: [image, { type: "text", text: tag }], timestamp: 1 };
  const imageOnly = { role: "user", content: [image], timestamp: 2 };
  const emptyText = { role: "user", content: [image, { type: "text", text: "" }], timestamp: 3 };
  assert.equal(messageIdentity(taggedImage), messageIdentity(imageOnly));
  assert.notEqual(messageIdentity(emptyText), messageIdentity(imageOnly));
});

test("entriesToCoreMessages applies the latest context_edit to a custom_message (#662)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    customEntry("b", "assistant_partial", "#"),
    editEntry("e1", "b", { content: "#Hel" }),
    editEntry("e2", "b", { content: "#Hello — the full partial response" }),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "b", "c"], "context_edit entries themselves never project");
  assert.equal(core[1]!.role, "user");
  assert.equal(core[1]!.contentType, "text");
  assert.equal(core[1]!.text, "#Hello — the full partial response", "latest edit wins over earlier edits and the original");
});

test("entriesToCoreMessages omits a custom_message whose latest context_edit is null", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    customEntry("b", "assistant_partial", "#"),
    editEntry("e1", "b", { content: "#grown" }),
    editEntry("e2", "b", null),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a"], "null replacement omits the target from model context");
});

test("entriesToCoreMessages lets a context_edit resurrect an empty custom_message (gate on effective content)", () => {
  const entries: SessionEntry[] = [
    customEntry("b", "assistant_partial", ""),
    editEntry("e1", "b", { content: "grown in place" }),
  ];
  const core = entriesToCoreMessages(entries);
  assert.equal(core.length, 1);
  assert.equal(core[0]!.id, "b");
  assert.equal(core[0]!.text, "grown in place");
});

test("entriesToCoreMessages applies context_edits to message entries (SDK string-wrap semantics)", () => {
  const entries: SessionEntry[] = [
    msgEntry("u", user("original question")),
    editEntry("e1", "u", { content: "revised question" }),
    msgEntry("a", { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: Date.now() }),
    editEntry("e2", "a", { content: "replaced assistant text" }),
    msgEntry("t", toolResult("tc9", "bash", "old output")),
    editEntry("e3", "t", { content: "replaced output" }),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["u", "a", "t"]);
  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "revised question", "user keeps the replacement as-is");
  assert.equal(core[1]!.role, "assistant");
  assert.equal(core[1]!.contentType, "text");
  assert.equal(core[1]!.text, "replaced assistant text", "assistant string replacement projected as text");
  assert.equal(core[2]!.role, "tool");
  assert.equal(core[2]!.contentType, "tool-result");
  assert.equal(core[2]!.text, "replaced output", "toolResult string replacement projected as text");
});

test("entriesToCoreMessages ignores malformed context_edits (missing targetId / bad replacement shape)", () => {
  const entries: SessionEntry[] = [
    customEntry("b", "assistant_partial", "#"),
    { type: CONTEXT_EDIT_ENTRY_TYPE, id: "bad1", parentId: null, timestamp: "", replacement: { content: "no target" } } as SessionEntry,
    { type: CONTEXT_EDIT_ENTRY_TYPE, id: "bad2", parentId: null, timestamp: "", targetId: "b", replacement: "not-an-object" } as SessionEntry,
  ];
  const core = entriesToCoreMessages(entries);
  assert.equal(core.length, 1);
  assert.equal(core[0]!.text, "#", "malformed edits are ignored rather than trusted");
});

test("entriesToCoreMessages never projects UI-only custom types, even when edited", () => {
  const entries: SessionEntry[] = [
    customEntry("b", ACP_STATUS_CUSTOM_TYPE, "panel body"),
    editEntry("e1", "b", { content: "should stay hidden" }),
  ];
  assert.deepEqual(entriesToCoreMessages(entries), []);
});

test("collectOriginals materializes the latest context_edit so restoration matches the kernel view (#662)", () => {
  const full = "#The full partial response.";
  const entries: SessionEntry[] = [
    msgEntry("u", user("question")),
    customEntry("b", "assistant_partial", "#"),
    editEntry("e1", "b", { content: "#T" }),
    editEntry("e2", "b", { content: full }),
  ];
  const map = collectOriginals(entries);

  const b = map.get("b")!;
  assert.equal(b.role, "user");
  assert.deepEqual(b.content, [{ type: "text", text: full }], "restored original carries the latest replacement");
  assert.equal(map.get("u"), entries[0]!.message, "unedited entries untouched");
});

test("collectOriginals drops null-replacement targets and wraps edited assistant strings into text blocks", () => {
  const entries: SessionEntry[] = [
    customEntry("b", "assistant_partial", "#"),
    editEntry("e1", "b", null),
    msgEntry("a", { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: Date.now() }),
    editEntry("e2", "a", { content: "new" }),
  ];
  const map = collectOriginals(entries);

  assert.equal(map.has("b"), false, "omitted entry has nothing for coreOutToAgentMessages to restore");
  assert.deepEqual(map.get("a")!.content, [{ type: "text", text: "new" }]);
});

test("#662 regression: interrupted response grown via context_edits reaches the model in full (not just '#')", () => {
  const FULL = "# The full partial response streamed before the interruption.";
  const entries: SessionEntry[] = [
    msgEntry("u", user("do the thing")),
    customEntry("hidden", "assistant_partial", "#"),
    editEntry("e1", "hidden", { content: "# T" }),
    editEntry("e2", "hidden", { content: FULL }),
  ];

  // Kernel input: the projection must carry the full response, not '#'.
  const coreIn = entriesToCoreMessages(entries);
  assert.equal(coreIn.length, 2);
  assert.equal(coreIn[1]!.id, "hidden");
  assert.equal(coreIn[1]!.text, FULL);

  // Simulate the kernel passing the message through with its ref tag
  // (tags ride at the start of core.text in this adapter's pipeline).
  const tag = acpRef("m00002") + "\n";
  const coreOut: CoreMessage[] = [
    { id: "u", role: "user", contentType: "text", text: acpRef("m00001") + "\ndo the thing" },
    { ...coreIn[1]!, text: tag + FULL },
  ];

  const out = coreOutToAgentMessages(coreOut, collectOriginals(entries));
  assert.equal(out.length, 2);
  const restored = out[1] as { role: string; content: Array<{ type: string; text?: string }> };
  assert.equal(restored.role, "user");
  const text = restored.content.find((blk) => blk.type === "text")!.text!;
  assert.ok(text.startsWith(FULL), "model sees the full partial response");
  assert.ok(text.includes("m00002"), "ref tag preserved");
  assert.notEqual(text.trimStart(), "#", "stale first-character value no longer survives");
});
