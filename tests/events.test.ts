import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventLine, activityLines, extractContentText, newPortion, ThinkingCollector } from "../src/delegate-events.js";

test("parses text_delta and text_end from message_update", () => {
  const delta = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}');
  assert.deepEqual(delta, { kind: "reply-delta", delta: "Hello " });

  const end = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}');
  assert.deepEqual(end, { kind: "reply-complete", content: "Hello world" });
});

test("parses thinking_delta wrapped in message_update", () => {
  const ev = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":" wan"}}');
  assert.deepEqual(ev, { kind: "thinking-delta", delta: " wan" });
});

test("parses tool_execution_start with bash command args", () => {
  const ev = parseEventLine('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"}}');
  assert.deepEqual(ev, { kind: "tool-start", toolName: "bash", argsText: "echo hi" });
});

test("parses tool_execution_update partialResult text", () => {
  const ev = parseEventLine(
    '{"type":"tool_execution_update","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"},"partialResult":{"content":[{"type":"text","text":"hi\\n"}],"details":{}}}',
  );
  assert.deepEqual(ev, { kind: "tool-update", toolCallId: "call_1", text: "hi\n" });
});

test("parses tool_execution_end with isError", () => {
  const ok = parseEventLine('{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"hi\\n"}]},"isError":false}');
  assert.deepEqual(ok, { kind: "tool-end", toolName: "bash", isError: false });

  const err = parseEventLine('{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{},"isError":true}');
  assert.deepEqual(err, { kind: "tool-end", toolName: "bash", isError: true });
});

test("ignores non-JSON lines and irrelevant events", () => {
  assert.equal(parseEventLine("not json"), null);
  assert.equal(parseEventLine('{"type":"turn_start","sessionId":"s"}'), null);
  assert.equal(parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}'), null);
});

test("extractContentText joins text blocks and tolerates non-array content", () => {
  assert.equal(extractContentText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(extractContentText({ content: [] }), "");
  assert.equal(extractContentText({}), "");
  assert.equal(extractContentText(null), "");
});

test("activityLines formats tool activity and gates thinking", () => {
  assert.deepEqual(
    activityLines({ kind: "tool-start", toolName: "bash", argsText: "echo hi" }, { showThinking: false }),
    ["[tool] bash echo hi\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "tool-update", toolCallId: "c", text: "hi\n" }, { showThinking: false }),
    ["hi\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "tool-end", toolName: "bash", isError: true }, { showThinking: false }),
    ["[done] bash (error)\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "thinking-delta", delta: " wan" }, { showThinking: false }),
    [],
  );
  assert.deepEqual(
    activityLines({ kind: "thinking-delta", delta: " wan" }, { showThinking: true }),
    ["[thinking]  wan\n"],
  );
});

test("newPortion returns only the appended part of a snapshot", () => {
  assert.equal(newPortion("hello", ""), "hello");
  assert.equal(newPortion("hello world", "hello"), " world");
  assert.equal(newPortion("hello", "hello"), "");
  assert.equal(newPortion("rewritten", "hello"), "rewritten");
});

test("parses thinking_end from message_update", () => {
  const ev = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0}}');
  assert.deepEqual(ev, { kind: "thinking-end" });
});

test("ThinkingCollector merges deltas into one line per segment", () => {
  const on = new ThinkingCollector(true);
  on.push("The user ");
  on.push("wants me ");
  assert.equal(on.flush(), "[thinking] The user wants me\n");
  assert.equal(on.flush(), "", "second flush is empty");

  const off = new ThinkingCollector(false);
  off.push("hidden ");
  assert.equal(off.flush(), "", "disabled collector emits nothing");
});

test("parses auto_retry_start and auto_retry_end", () => {
  const start = parseEventLine('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 {\\"error\\":{\\"type\\":\\"overloaded_error\\"}}"}');
  assert.deepEqual(start, {
    kind: "retry-start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: '529 {"error":{"type":"overloaded_error"}}',
  });

  const end = parseEventLine('{"type":"auto_retry_end","success":true,"attempt":2}');
  assert.deepEqual(end, { kind: "retry-end", success: true, attempt: 2 });
});

test("activityLines formats retry events", () => {
  assert.deepEqual(
    activityLines({ kind: "retry-start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" }, { showThinking: false }),
    ["[retry] attempt 1/3, backoff 2000ms — 529 overloaded\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "retry-start", attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "" }, { showThinking: false }),
    ["[retry] attempt 2/3, backoff 5000ms\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "retry-end", success: true, attempt: 2 }, { showThinking: false }),
    ["[retry] attempt 2 succeeded\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "retry-end", success: false, attempt: 3 }, { showThinking: false }),
    ["[retry] attempt 3 failed\n"],
  );
});

test("parses message_end with usage data (returns UsageUpdateEvent)", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"assistant","usage":{"input":150,"output":80,"cacheRead":0,"cacheWrite":0,"totalTokens":230,"cost":{"input":0.0015,"output":0.0008,"cacheRead":0,"cacheWrite":0,"total":0.0023}}}}') as { kind: "usage-update"; usage: Record<string, unknown> };
  assert.equal(ev.kind, "usage-update");
  assert.equal(ev.usage.input, 150);
  assert.equal(ev.usage.output, 80);
  assert.equal(ev.usage.cacheRead, 0);
  assert.equal(ev.usage.cacheWrite, 0);
  assert.equal(ev.usage.totalTokens, 230);
  assert.deepEqual(ev.usage.cost, { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 });
});

test("message_end with optional fields returns UsageUpdateEvent with undefined", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"assistant","usage":{"input":150,"output":80,"cacheRead":0,"cacheWrite":0,"totalTokens":230,"cost":{"input":0.0015,"output":0.0008,"cacheRead":0,"cacheWrite":0,"total":0.0023}}}}') as { kind: "usage-update"; usage: Record<string, unknown> };
  assert.equal(ev.usage.cacheWrite1h, undefined);
  assert.equal(ev.usage.reasoning, undefined);
});

test("message_end with no usage object returns null", () => {
  const ev = parseEventLine('{"type":"message_end","role":"assistant","message":{}}');
  assert.equal(ev, null);
});

test("message_end with no cost object defaults cost to zeros", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"assistant","usage":{"input":150,"output":80,"cacheRead":0,"cacheWrite":0,"totalTokens":230}}}') as { kind: "usage-update"; usage: Record<string, unknown> };
  assert.deepEqual(ev.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("message_end with non-finite number returns null when all fields invalid", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"assistant","usage":{"input":"NaN","output":"NaN","cacheRead":"NaN","cacheWrite":"NaN","totalTokens":230,"cost":{"input":0.0015,"output":0.0008,"cacheRead":0,"cacheWrite":0,"total":0.0023}}}}');
  assert.equal(ev, null);
});

test("handleMessageEnd skips non-assistant message_end", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"user","usage":{"input":150,"output":80,"cacheRead":0,"cacheWrite":0,"totalTokens":230,"cost":{"input":0.0015,"output":0.0008,"cacheRead":0,"cacheWrite":0,"total":0.0023}}}}');
  assert.equal(ev, null);
});

test("activityLines ignores usage-update events", () => {
  const ev = { kind: "usage-update" as const, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  assert.deepEqual(activityLines(ev, { showThinking: false }), []);
});

test("accumulateUsage sums all fields including nested cost", async () => {
  const { accumulateUsage } = await import("../src/delegate-tool.js");
  const a = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } };
  const b = { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { input: 0.002, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
  const result = accumulateUsage(a, b);
  assert.equal(result.input, 300);
  assert.equal(result.output, 150);
  assert.equal(result.cacheRead, 0);
  assert.equal(result.cacheWrite, 0);
  assert.equal(result.cacheWrite1h, 0);
  assert.equal(result.reasoning, 0);
  assert.equal(result.totalTokens, 450);
  assert.ok(Math.abs(result.cost.input - 0.003) < 1e-10);
  assert.ok(Math.abs(result.cost.output - 0.0015) < 1e-10);
  assert.equal(result.cost.cacheRead, 0);
  assert.equal(result.cost.cacheWrite, 0);
  assert.ok(Math.abs(result.cost.total - 0.0045) < 1e-10);
});

test("accumulateUsage returns b when a is undefined", async () => {
  const { accumulateUsage } = await import("../src/delegate-tool.js");
  const b = { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { input: 0.002, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
  const result = accumulateUsage(undefined, b);
  assert.deepEqual(result, b);
});

test("parses agent_settled event", () => {
  const ev = parseEventLine('{"type":"agent_settled"}');
  assert.deepEqual(ev, { kind: "agent-settled" });
});

test("activityLines ignores agent-settled events", () => {
  const ev = { kind: "agent-settled" as const };
  assert.deepEqual(activityLines(ev, { showThinking: false }), []);
  assert.deepEqual(activityLines(ev, { showThinking: true }), []);
});

test("parseEventLine tolerates trailing CR (CRLF line endings)", () => {
  assert.deepEqual(parseEventLine('{"type":"agent_settled"}\r'), { kind: "agent-settled" });
  assert.deepEqual(
    parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0}}\r'),
    { kind: "thinking-end" },
  );
  assert.deepEqual(
    parseEventLine('{"type":"message_end","message":{"role":"assistant","usage":{"input":150,"output":80,"cacheRead":0,"cacheWrite":0,"totalTokens":230}}}\r'),
    { kind: "usage-update", usage: { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, cacheWrite1h: undefined, reasoning: undefined, totalTokens: 230, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  );
});

test("message_end with partial usage fills missing numeric fields with 0", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"assistant","usage":{"input":150,"totalTokens":150}}}') as { kind: "usage-update"; usage: Record<string, unknown> };
  assert.equal(ev.kind, "usage-update");
  assert.equal(ev.usage.input, 150);
  assert.equal(ev.usage.output, 0);
  assert.equal(ev.usage.cacheRead, 0);
  assert.equal(ev.usage.cacheWrite, 0);
  assert.equal(ev.usage.totalTokens, 150);
  assert.deepEqual(ev.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});
