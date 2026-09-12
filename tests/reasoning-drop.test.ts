import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPRESS_REASONING, applyStrictReasoningGate, dropCompressReasoning, isStrictReasoningEcho, resolveReasoningDrop } from "../src/reasoning-drop.js";
import { resolveCompress } from "../src/config.js";

type AgentMessage = SessionMessageEntry["message"];

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function assistant(parts: unknown[]): AgentMessage {
  return { role: "assistant", content: parts, timestamp: 0 } as unknown as AgentMessage;
}

function toolResult(toolCallId: string): AgentMessage {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }], timestamp: 0 } as unknown as AgentMessage;
}

function thinking(len: number, extra: Record<string, unknown> = {}): { type: "thinking"; thinking: string } & Record<string, unknown> {
  return { type: "thinking", thinking: "x".repeat(len), ...extra };
}

function compressCall(id = "c1"): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
  return { type: "toolCall", id, name: "compress", arguments: {} };
}

function otherCall(name = "bash"): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
  return { type: "toolCall", id: "t1", name, arguments: {} };
}

test("defaults: drop=true, threshold=2048; drop:false disables", () => {
  assert.deepEqual(DEFAULT_COMPRESS_REASONING, { drop: true, threshold: 2048 });
  assert.deepEqual(resolveReasoningDrop(undefined), { drop: true, threshold: 2048 });
  assert.deepEqual(resolveReasoningDrop({}), { drop: true, threshold: 2048 });
  assert.deepEqual(resolveReasoningDrop({ drop: false }), { drop: false, threshold: 2048 });
  assert.deepEqual(resolveReasoningDrop({ threshold: 0 }), { drop: true, threshold: 0 });
});

test("invalid threshold falls back to default, invalid drop is truthy", () => {
  assert.equal(resolveReasoningDrop({ threshold: -1 }).threshold, 2048);
  assert.equal(resolveReasoningDrop({ threshold: Number.NaN }).threshold, 2048);
  assert.equal(resolveReasoningDrop({ threshold: 8192.9 }).threshold, 8192);
  assert.equal(resolveReasoningDrop({ drop: "yes" as unknown as boolean }).drop, true);
});

test("gate: closed round — result arrived and a later message exists", () => {
  const big = thinking(4096);
  const closed = assistant([{ type: "text", text: "old" }, thinking(4096), compressCall("c1")]);
  const inFlight = assistant([{ type: "text", text: "active" }, thinking(4096), compressCall("c2")]);
  const msgs = [closed, toolResult("c1"), user("go"), inFlight, toolResult("c2")];
  const out = dropCompressReasoning(msgs, { drop: true, threshold: 0 });
  assert.equal((out[0]!.content as unknown[]).includes(big), false);
  assert.deepEqual(out[3]!.content, msgs[3]!.content); // result is last message → in flight
});

test("#348: closes WITHOUT any user message — assistant continuation is round evidence", () => {
  const closed = assistant([{ type: "text", text: "agentic" }, thinking(4096), compressCall("c1")]);
  const continuing = assistant([{ type: "text", text: "carrying on" }]);
  const out = dropCompressReasoning([closed, toolResult("c1"), continuing], { drop: true, threshold: 0 });
  assert.deepEqual(out[0]!.content, [{ type: "text", text: "agentic" }, compressCall("c1")]);
  assert.deepEqual(out[2]!.content, continuing.content);
});

test("gate: result pending (call without any result) is never touched", () => {
  const pending = assistant([{ type: "text", text: "hi" }, thinking(4096), compressCall("c1")]);
  const msgs = [pending, assistant([{ type: "text", text: "next" }])];
  assert.equal(dropCompressReasoning(msgs, { drop: true, threshold: 0 }), msgs);
});

test("gate: result for a different call id does not close the round", () => {
  const msg = assistant([{ type: "text", text: "hi" }, thinking(4096), compressCall("c1")]);
  const msgs = [msg, toolResult("other"), user("go")];
  assert.equal(dropCompressReasoning(msgs, { drop: true, threshold: 0 }), msgs);
});

test("gate: result BEFORE the call message does not close the round", () => {
  const msg = assistant([{ type: "text", text: "hi" }, thinking(4096), compressCall("c1")]);
  const msgs = [toolResult("c1"), msg, user("go")];
  assert.equal(dropCompressReasoning(msgs, { drop: true, threshold: 0 }), msgs);
});

test("gate: mixed message closes on the compress result alone (other calls' results are irrelevant)", () => {
  const msg = assistant([{ type: "text", text: "hi" }, thinking(4096), compressCall("c1"), otherCall("read")]);
  const msgs = [msg, toolResult("c1"), user("go")]; // read result never arrives
  const out = dropCompressReasoning(msgs, { drop: true, threshold: 0 });
  assert.deepEqual(out[0]!.content, [{ type: "text", text: "hi" }, compressCall("c1"), otherCall("read")]);
});

test("gate: selector — only messages carrying a compress toolCall part are touched", () => {
  const textOnly = assistant([{ type: "text", text: "hi" }, thinking(4096)]);
  const otherTool = assistant([{ type: "text", text: "hi" }, thinking(4096), otherCall()]);
  const msgs = [textOnly, otherTool, toolResult("t1"), user("go")];
  const out = dropCompressReasoning(msgs, { drop: true, threshold: 0 });
  assert.deepEqual(out[0]!.content, textOnly.content);
  assert.deepEqual(out[1]!.content, otherTool.content);
  assert.equal(thinking(1).type, "thinking");
});

test("gate: size — strictly exceeds threshold, summed across parts of the same message only", () => {
  const at = assistant([{ type: "text", text: "hi" }, thinking(1024), thinking(1024), compressCall()]);
  const above = assistant([{ type: "text", text: "hi" }, thinking(1025), thinking(1025), compressCall()]);
  const splitKept = [
    assistant([{ type: "text", text: "hi" }, thinking(1500), compressCall("a")]),
    toolResult("a"),
    assistant([{ type: "text", text: "mid" }]),
    assistant([{ type: "text", text: "hi" }, thinking(1500), compressCall("b")]),
    toolResult("b"),
    user("go"),
  ];
  const out = dropCompressReasoning([at, above, toolResult("c1"), user("go")], { drop: true, threshold: 2048 });
  assert.deepEqual(out[0]!.content, at.content); // 2048 == threshold → kept
  assert.equal((out[1]!.content as unknown[]).some((p) => p === (above.content as unknown[])[1]), false); // 2050 > 2048 → dropped
  const out2 = dropCompressReasoning(splitKept, { drop: true, threshold: 2048 });
  assert.deepEqual(out2[0]!.content, splitKept[0]!.content); // lengths not accumulated across messages
  assert.deepEqual(out2[3]!.content, splitKept[3]!.content);
});

test("threshold 0 drops any non-empty reasoning; zero-length survives", () => {
  const nonEmpty = assistant([{ type: "text", text: "hi" }, thinking(3), compressCall()]);
  const empty = assistant([{ type: "text", text: "hi" }, thinking(0), compressCall("c2")]);
  const out = dropCompressReasoning([nonEmpty, toolResult("c1"), empty, toolResult("c2"), user("go")], { drop: true, threshold: 0 });
  assert.equal((out[0]!.content as unknown[]).length, 2);
  assert.equal((out[2]!.content as unknown[]).length, 3);
});

test("purity and idempotence: input never mutated; second pass is a no-op", () => {
  const original = assistant([{ type: "text", text: "hi" }, thinking(4096), compressCall()]);
  const msgs = [original, toolResult("c1"), user("go")];
  const out1 = dropCompressReasoning(msgs, { drop: true, threshold: 0 });
  assert.deepEqual(original.content, [{ type: "text", text: "hi" }, thinking(4096), compressCall()]); // input unmutated
  assert.notEqual(out1[0], msgs[0]); // rewritten message is a new object
  const out2 = dropCompressReasoning(out1, { drop: true, threshold: 0 });
  assert.equal(out2, out1); // idempotent
});

test("fail-safe: malformed messages return the input unchanged", () => {
  const msgs = [
    { role: "assistant", content: null },
    { role: "assistant" },
    "garbage",
    user("go"),
  ] as unknown as AgentMessage[];
  assert.equal(dropCompressReasoning(msgs, { drop: true, threshold: 0 }), msgs);
});

test("drop:false is a full kill-switch", () => {
  const msgs = [assistant([{ type: "text", text: "hi" }, thinking(99999), compressCall()]), toolResult("c1"), user("go")];
  assert.equal(dropCompressReasoning(msgs, { drop: false }), msgs);
});

test("no round evidence at all → nothing touched", () => {
  const msgs = [assistant([{ type: "text", text: "hi" }, thinking(4096), compressCall()])];
  assert.equal(dropCompressReasoning(msgs, { drop: true, threshold: 0 }), msgs);
});

test("text and toolCall parts (incl. thoughtSignature) survive the drop", () => {
  const call = { ...compressCall(), thoughtSignature: "sig" };
  const out = dropCompressReasoning(
    [assistant([{ type: "text", text: "keep" }, thinking(4096), call]), toolResult("c1"), user("go")],
    { drop: true, threshold: 0 },
  );
  const content = out[0]!.content as unknown[];
  assert.deepEqual(content, [{ type: "text", text: "keep" }, call]);
});

test("three-level merge: model > provider > global, field-wise", () => {
  const merged = resolveCompress(
    {
      reasoning: { drop: true, threshold: 2048 },
      providers: {
        openai: { reasoning: { drop: false }, models: { "gpt-5": { reasoning: { threshold: 0 } } } },
      },
    },
    "openai",
    "gpt-5",
  );
  assert.deepEqual(merged.reasoning, { drop: false, threshold: 0 });
  const provOnly = resolveCompress(
    { reasoning: { threshold: 100 }, providers: { openai: { reasoning: { drop: false } } } },
    "openai",
    undefined,
  );
  assert.deepEqual(provOnly.reasoning, { drop: false, threshold: 100 }); // provider only overrides drop
});

test("isStrictReasoningEcho: deepseek detected via baseUrl or provider name, case-insensitive", () => {
  assert.equal(isStrictReasoningEcho(undefined, "https://api.deepseek.com/v1"), true);
  assert.equal(isStrictReasoningEcho(undefined, "https://api.deepseek.com/beta/chat/completions"), true);
  assert.equal(isStrictReasoningEcho("deepseek", undefined), true);
  assert.equal(isStrictReasoningEcho("DeepSeek-Pro", "https://example.com"), true);
});

test("isStrictReasoningEcho: non-deepseek upstreams are not auto-detected", () => {
  assert.equal(isStrictReasoningEcho("anthropic", "https://api.anthropic.com"), false);
  assert.equal(isStrictReasoningEcho("openai", "https://api.openai.com/v1"), false);
  // GLM-thinking / QwQ are strict-echo too but keyed by other hosts; they use the
  // documented manual drop:false override so their non-thinking models keep the pass.
  assert.equal(isStrictReasoningEcho("zhipu", "https://open.bigmodel.cn/api/paas/v4"), false);
  assert.equal(isStrictReasoningEcho("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"), false);
  assert.equal(isStrictReasoningEcho(), false);
  assert.equal(isStrictReasoningEcho(undefined, undefined), false);
});

test("applyStrictReasoningGate: forces drop off on a strict-echo upstream, preserves threshold", () => {
  const base = resolveReasoningDrop(undefined);
  assert.deepEqual(applyStrictReasoningGate(base, "deepseek", "https://api.deepseek.com/v1"), { drop: false, threshold: 2048 });
  assert.deepEqual(applyStrictReasoningGate(base, undefined, "https://api.deepseek.com/v1"), { drop: false, threshold: 2048 });
});

test("applyStrictReasoningGate: no-op for non-strict-echo and already-disabled configs (same reference)", () => {
  const base = resolveReasoningDrop(undefined);
  assert.equal(applyStrictReasoningGate(base, "openai", "https://api.openai.com/v1"), base);
  const off = resolveReasoningDrop({ drop: false });
  assert.equal(applyStrictReasoningGate(off, "deepseek", "https://api.deepseek.com/v1"), off);
});
