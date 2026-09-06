import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBashTimeout,
  capToolOutput,
  detectBashTimeout,
  appendTimeoutNotice,
  isBashToolResult,
  wireToolGuardrails,
  canonicalStringify,
  repetitionFingerprint,
  RepetitionTracker,
} from "../src/tool-guardrails.js";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "../src/runtime.js";

type Content = ToolResultEvent["content"];
const text = (t: string): Content => [{ type: "text", text: t }];

test("resolveBashTimeout returns undefined when the model already set a timeout", () => {
  assert.equal(resolveBashTimeout({ timeout: 30 }, 60), undefined);
});

test("resolveBashTimeout injects the default when the model omitted timeout", () => {
  assert.equal(resolveBashTimeout({}, 60), 60);
  assert.equal(resolveBashTimeout({ timeout: undefined }, 60), 60);
});

test("resolveBashTimeout returns undefined when the default is disabled (0 / negative / NaN)", () => {
  assert.equal(resolveBashTimeout({}, 0), undefined);
  assert.equal(resolveBashTimeout({}, -5), undefined);
  assert.equal(resolveBashTimeout({}, Number.NaN), undefined);
});

test("resolveBashTimeout falls back to the 60s built-in default when default is undefined", () => {
  assert.equal(resolveBashTimeout({}, undefined), 60);
});

test("capToolOutput leaves small output untouched (returns undefined)", () => {
  assert.equal(capToolOutput(text("hello"), 100), undefined);
});

test("capToolOutput returns undefined when the cap is disabled", () => {
  assert.equal(capToolOutput(text("x".repeat(10_000)), 0), undefined);
  assert.equal(capToolOutput(text("x".repeat(10_000)), undefined), undefined);
});

test("capToolOutput truncates oversized text to under the byte cap and adds a notice", () => {
  const big = "line\n".repeat(4000);
  const out = capToolOutput(text(big), 500);
  assert.ok(out, "should return truncated content");
  const t = (out![0] as { text: string }).text;
  assert.ok(Buffer.byteLength(t, "utf8") <= 500 + 200, "truncated payload must be near the cap (notice adds a little)");
  assert.match(t, /ACP guardrail/);
  assert.match(t, /dropped/);
});

test("capToolOutput keeps a complete last line (no mid-line cut)", () => {
  const big = "0123456789\n".repeat(2000);
  const out = capToolOutput(text(big), 100);
  const t = (out![0] as { text: string }).text;
  const body = t.split("\n\n[ACP guardrail")[0];
  for (const line of body.split("\n")) {
    assert.ok(line.length === 0 || line.length === 10, "no partial line: " + JSON.stringify(line));
  }
});

test("capToolOutput mentions the saved full-output path for bash-style results", () => {
  const big = "x".repeat(10_000);
  const out = capToolOutput(text(big), 500, "/tmp/acp-full.log");
  const t = (out![0] as { text: string }).text;
  assert.match(t, /\/tmp\/acp-full\.log/);
});

test("capToolOutput preserves non-text (image) content alongside truncated text", () => {
  const img = { type: "image", source: { media_type: "image/png", data: "AAAA" } } as Content[number];
  const content: Content = [{ type: "text", text: "x".repeat(10_000) }, img];
  const out = capToolOutput(content, 500);
  assert.ok(out);
  assert.equal(out!.some((c) => c.type === "image"), true, "image part must survive");
  assert.equal(out!.some((c) => c.type === "text"), true, "truncated text part must be present");
});

test("capToolOutput is UTF-8 safe (never splits a multibyte sequence)", () => {
  const big = "中文测试\n".repeat(3000);
  const out = capToolOutput(text(big), 200);
  const t = (out![0] as { text: string }).text;
  const body = t.split("\n\n[ACP guardrail")[0];
  const buf = Buffer.from(body, "utf8");
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    const size = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    assert.ok(i + size <= buf.length, "no truncated multibyte sequence at byte " + i);
    i += size;
  }
});

test("detectBashTimeout extracts the seconds from Pi's timeout error text", () => {
  assert.equal(detectBashTimeout(text("Command timed out after 60 seconds")), 60);
  assert.equal(detectBashTimeout(text("partial output\nCommand timed out after 300 seconds")), 300);
});

test("detectBashTimeout returns undefined when there is no timeout error", () => {
  assert.equal(detectBashTimeout(text("Command aborted")), undefined);
  assert.equal(detectBashTimeout(text("no error here")), undefined);
  assert.equal(detectBashTimeout([]), undefined);
});

test("appendTimeoutNotice appends actionable guidance to the last text part", () => {
  const out = appendTimeoutNotice(text("Command timed out after 60 seconds"), 60);
  assert.equal(out.length, 1);
  const t = (out[0] as { text: string }).text;
  assert.match(t, /killed after 60s/);
  assert.match(t, /`timeout`/);
  assert.match(t, /"timeout": 120/);
});

test("appendTimeoutNotice suggests a larger timeout that scales with the kill time", () => {
  const out = appendTimeoutNotice(text("Command timed out after 300 seconds"), 300);
  const t = (out[0] as { text: string }).text;
  assert.match(t, /"timeout": 600/);
});

test("appendTimeoutNotice adds a new text part when content has no text part", () => {
  const img = { type: "image", source: { media_type: "image/png", data: "AAAA" } } as Content[number];
  const out = appendTimeoutNotice([img], 30);
  assert.equal(out.length, 2);
  assert.equal(out[1].type, "text");
});

test("isBashToolResult narrows by toolName and exposes bash details (vendored guard, host-agnostic)", () => {
  const bash = { toolName: "bash", content: text("ok"), isError: false, details: { fullOutputPath: "/tmp/x" } } as unknown as ToolResultEvent;
  const other = { toolName: "read", content: text("ok"), isError: false } as unknown as ToolResultEvent;
  assert.equal(isBashToolResult(bash), true);
  assert.equal(isBashToolResult(other), false);
  if (isBashToolResult(bash)) {
    assert.equal(bash.details?.fullOutputPath, "/tmp/x");
  }
});

// --- wiring: the default-application contract (issue #210) ---

function wireFor(adapter: Record<string, unknown>) {
  const handlers: Record<string, (e: ToolResultEvent) => unknown> = {};
  const pi = {
    on: (name: string, fn: (e: never) => unknown) => {
      handlers[name] = fn as (e: ToolResultEvent) => unknown;
    },
  } as unknown as ExtensionAPI;
  const runtime = { adapter } as AcpRuntime;
  wireToolGuardrails(pi, runtime);
  return (event: ToolResultEvent) => handlers["tool_result"]!(event);
}

const readResult = (t: string) =>
  ({ toolName: "read", content: text(t), isError: false }) as unknown as ToolResultEvent;

function textOf(part: unknown): string {
  if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
    return part.text;
  }
  throw new Error("expected a text content part");
}

test("wireToolGuardrails applies the documented 200KB default when toolOutputMaxBytes is unset", () => {
  const onResult = wireFor({});
  const ret = onResult(readResult("x".repeat(300 * 1024)));
  assert.ok(ret && typeof ret === "object" && "content" in ret && Array.isArray(ret.content),
    "oversized output must be capped even with no explicit config");
  const t = textOf(ret.content[0]);
  assert.match(t, /\[ACP guardrail/);
  assert.ok(Buffer.byteLength(t, "utf8") < 250 * 1024, "payload must be truncated near the 200KB default");
});

test("wireToolGuardrails keeps an explicit toolOutputMaxBytes: 0 as disable", () => {
  const onResult = wireFor({ toolOutputMaxBytes: 0 });
  assert.equal(onResult(readResult("x".repeat(300 * 1024))), undefined);
});

test("wireToolGuardrails honors an explicit smaller cap", () => {
  const onResult = wireFor({ toolOutputMaxBytes: 1000 });
  const ret = onResult(readResult("x".repeat(10_000)));
  assert.ok(ret && typeof ret === "object" && "content" in ret && Array.isArray(ret.content));
  const t = textOf(ret.content[0]);
  assert.ok(Buffer.byteLength(t, "utf8") < 2000, "payload must be truncated to the explicit cap");
});

// --- generic tool-call repetition guard (issue #308) ---

test("canonicalStringify is key-order independent for objects", () => {
  assert.equal(canonicalStringify({ a: 1, b: 2 }), canonicalStringify({ b: 2, a: 1 }));
});

test("canonicalStringify preserves array order (arrays are ordered)", () => {
  assert.notEqual(canonicalStringify([1, 2]), canonicalStringify([2, 1]));
});

test("canonicalStringify recurses into nested objects and drops undefined values", () => {
  assert.equal(
    canonicalStringify({ x: { p: 1, q: 2 }, y: 3 }),
    canonicalStringify({ y: 3, x: { q: 2, p: 1 } }),
  );
  assert.equal(canonicalStringify({ a: 1, b: undefined }), canonicalStringify({ a: 1 }));
});

test("repetitionFingerprint is stable across argument key order", () => {
  assert.equal(
    repetitionFingerprint("acp_status", { scope: "uncompressed", view: "ranges" }),
    repetitionFingerprint("acp_status", { view: "ranges", scope: "uncompressed" }),
  );
});

test("repetitionFingerprint changes when any argument differs", () => {
  const base = repetitionFingerprint("acp_status", { scope: "uncompressed", view: "ranges" });
  assert.notEqual(base, repetitionFingerprint("acp_status", { scope: "uncompressed", view: "messages" }));
  assert.notEqual(base, repetitionFingerprint("acp_status", {}));
});

test("repetitionFingerprint distinguishes different tools with identical args", () => {
  assert.notEqual(repetitionFingerprint("read", { path: "/x" }), repetitionFingerprint("bash", { path: "/x" }));
});

test("RepetitionTracker escalates none -> warn -> abort by consecutive count", () => {
  const t = new RepetitionTracker({ warn: 3, abort: 5 });
  assert.equal(t.note("x", {}).action, "none");
  assert.equal(t.note("x", {}).action, "none");
  assert.equal(t.note("x", {}).action, "warn");
  assert.equal(t.note("x", {}).action, "warn");
  assert.equal(t.note("x", {}).action, "abort");
  assert.equal(t.note("x", {}).action, "abort");
});

test("RepetitionTracker resets on a different fingerprint (args or tool name)", () => {
  const t = new RepetitionTracker({ warn: 2, abort: 99 });
  t.note("x", { a: 1 });
  t.note("x", { a: 1 });
  assert.equal(t.note("x", { a: 2 }).action, "none");
  assert.equal(t.note("y", { a: 1 }).action, "none");
});

test("RepetitionTracker.reset() clears the run", () => {
  const t = new RepetitionTracker({ warn: 2, abort: 3 });
  t.note("x", {});
  t.note("x", {});
  t.reset();
  assert.equal(t.note("x", {}).action, "none");
});

function makeRepCtx(sid = "sess-rep") {
  const ctx = {
    hasUI: false,
    ui: { notify: () => {} },
    abortCalls: 0,
    sessionManager: { getSessionId: () => sid },
    abort: () => {
      ctx.abortCalls += 1;
    },
  };
  return ctx;
}

function wireRepetition(adapter: Record<string, unknown>) {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const pi = {
    on: (name: string, fn: (...a: never[]) => unknown) => {
      handlers[name] = fn as (...a: unknown[]) => unknown;
    },
  } as unknown as ExtensionAPI;
  const runtime = { adapter } as AcpRuntime;
  const ctx = makeRepCtx();
  wireToolGuardrails(pi, runtime);
  return {
    call: (event: ToolCallEvent) => handlers["tool_call"]!(event, ctx),
    result: (event: ToolResultEvent) => handlers["tool_result"]!(event),
    input: (source: string) => handlers["input"]!({ source }, ctx),
    shutdown: () => handlers["session_shutdown"]!({}, ctx),
    ctx,
  };
}

const statusCall = (id: string): ToolCallEvent =>
  ({ type: "tool_call", toolName: "acp_status", toolCallId: id, input: { scope: "uncompressed", view: "ranges" } }) as unknown as ToolCallEvent;

const statusResult = (id: string): ToolResultEvent =>
  ({ toolName: "acp_status", toolCallId: id, content: text("status ok"), isError: false }) as unknown as ToolResultEvent;

const hasContent = (ret: unknown): ret is { content: Content } =>
  !!ret && typeof ret === "object" && "content" in ret;

test("repetition guard queues a warning at warn=3 (default) without blocking", () => {
  const w = wireRepetition({});
  assert.equal(w.call(statusCall("c1")), undefined);
  assert.equal(w.call(statusCall("c2")), undefined);
  assert.equal(w.call(statusCall("c3")), undefined, "warn threshold must not block");
  const res = w.result(statusResult("c3"));
  assert.ok(hasContent(res), "warned result must be modified");
  const t = textOf(res.content[0]);
  assert.match(t, /CONSECUTIVE identical/);
  assert.match(t, /acp_status/);
});

test("repetition guard blocks and aborts at abort=5 (default)", () => {
  const w = wireRepetition({});
  for (const id of ["k1", "k2", "k3", "k4"]) {
    assert.equal(w.call(statusCall(id)), undefined, "below abort must not block");
  }
  const fifth = w.call(statusCall("k5")) as { block?: boolean; reason?: string };
  assert.equal(fifth?.block, true, "5th identical call must be blocked");
  assert.match(fifth?.reason ?? "", /BLOCKED/);
  assert.equal(w.ctx.abortCalls, 1, "turn must be aborted exactly once");
  const sixth = w.call(statusCall("k6")) as { block?: boolean };
  assert.equal(sixth?.block, true, "still blocked after abort");
});

test("repetition guard resets the run when arguments change", () => {
  const w = wireRepetition({});
  const other: ToolCallEvent = {
    type: "tool_call",
    toolName: "acp_status",
    toolCallId: "x",
    input: { scope: "compressed" },
  } as unknown as ToolCallEvent;
  w.call(statusCall("r1"));
  w.call(statusCall("r2"));
  w.call(other);
  w.call(statusCall("r3"));
  w.call(statusCall("r4"));
  assert.equal(w.result(statusResult("r4")), undefined, "only 2 consecutive identical -> no warning yet");
  w.call(statusCall("r5"));
  const res5 = w.result(statusResult("r5"));
  assert.ok(hasContent(res5), "3rd consecutive identical -> warning");
});

test("repetition guard run resets on real user input but not extension-sent input", () => {
  const w = wireRepetition({});
  w.call(statusCall("u1"));
  w.call(statusCall("u2"));
  w.input("interactive");
  w.call(statusCall("u3"));
  w.call(statusCall("u4"));
  assert.equal(w.result(statusResult("u4")), undefined, "after user-input reset, only 2 consecutive -> no warning");
  w.input("extension");
  w.call(statusCall("u5"));
  const res5 = w.result(statusResult("u5"));
  assert.ok(hasContent(res5), "extension-sent input must not reset the run");
});

test("repetition guard is fully inert when repetitionGuard: false", () => {
  const w = wireRepetition({ repetitionGuard: false });
  for (let i = 1; i <= 6; i++) {
    assert.equal(w.call(statusCall(`d${i}`)), undefined, `identical call ${i} must not be blocked when disabled`);
  }
  assert.equal(w.ctx.abortCalls, 0, "never aborts when disabled");
});

test("repetition guard honors custom warn/abort thresholds", () => {
  const w = wireRepetition({ repetitionGuard: { warn: 2, abort: 3 } });
  assert.equal(w.call(statusCall("t1")), undefined);
  assert.equal(w.call(statusCall("t2")), undefined);
  const res2 = w.result(statusResult("t2"));
  assert.ok(hasContent(res2), "warn fires at custom warn=2");
  const third = w.call(statusCall("t3")) as { block?: boolean };
  assert.equal(third?.block, true, "abort fires at custom abort=3");
});
