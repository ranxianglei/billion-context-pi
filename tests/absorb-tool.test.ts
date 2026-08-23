import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { resolveConfig } from "../src/config.js";

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
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function msgEntry(id: string, message: object): any {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}
function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function assistantToolCall(callId: string, name: string, args: Record<string, string>): object {
  return { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], api: "anthropic", provider: "anthropic", model: "claude", usage: {}, stopReason: "toolUse", timestamp: Date.now() };
}
function toolResult(callId: string, name: string, text: string): object {
  return { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
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

async function fireContext(handlers: Map<string, ((event: any, ctx: any) => any)[]>, ctx: any): Promise<any[]> {
  const handler = handlers.get("context")?.[0];
  assert.ok(handler, "context handler not registered");
  const out = await handler({ type: "context", messages: [] }, ctx);
  return out.messages;
}

function resultText(messages: any[], marker: string): string {
  for (const m of messages) {
    if (m.role !== "toolResult") continue;
    const text = (m.content as Array<{ type: string; text: string }>).map((b) => b.text).join("");
    if (text.includes(marker)) return text;
  }
  throw new Error(`marker ${marker} not found in tool results`);
}

test("resolveConfig maps absorb settings", () => {
  const off = resolveConfig({}, 200_000);
  assert.notEqual(off.absorb?.enabled, true);
  const on = resolveConfig({ absorb: true }, 200_000);
  assert.deepEqual(on.absorb, { enabled: true, toolName: "absorb", minToolTokens: 1000, contextThresholdPct: 0, excludeTools: [] });
  const tuned = resolveConfig({ absorb: { minToolTokens: 500, contextThresholdPct: "30%", excludeTools: ["read"] } }, 200_000);
  assert.deepEqual(tuned.absorb, { enabled: true, toolName: "absorb", minToolTokens: 500, contextThresholdPct: 0.3, excludeTools: ["read"] });
});

test("absorb tool is registered only when enabled", () => {
  const off = captureApi();
  createAcpExtension({ autoUpdate: false })(off.api);
  assert.equal(off.api.tools.find((t: any) => t.name === "absorb"), undefined);
  const on = captureApi();
  createAcpExtension({ autoUpdate: false, absorb: true })(on.api);
  assert.ok(on.api.tools.find((t: any) => t.name === "absorb"));
  const named = captureApi();
  createAcpExtension({ autoUpdate: false, absorb: { toolName: "takeaway" } })(named.api);
  assert.ok(named.api.tools.find((t: any) => t.name === "takeaway"));
  assert.equal(named.api.tools.find((t: any) => t.name === "absorb"), undefined);
});

test("large tool result gets forced absorb prompt; small ones do not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-absorb-"));
  try {
    const stateFile = join(dir, "session.jsonl");
    const big = "UNIQUE-BIG-MARKER " + "x".repeat(8000);
    const entries = [
      msgEntry("e1", user("run it")),
      msgEntry("e2", assistantToolCall("tc1", "bash", { command: "ls" })),
      msgEntry("e3", toolResult("tc1", "bash", big)),
      msgEntry("e4", user("continue")),
    ];
    const { api, handlers } = captureApi();
    createAcpExtension({ autoUpdate: false, absorb: true })(api);
    const out = await fireContext(handlers, fakeCtx(entries, stateFile));
    const bigText = resultText(out, "UNIQUE-BIG-MARKER");
    assert.ok(bigText.includes("[ACP absorb]"), "forced prompt missing on large result");
    assert.ok(bigText.includes("UNIQUE-BIG-MARKER"), "original content stays in the same turn");
    const ref = bigText.match(/m\d{4,}/)?.[0];
    assert.ok(ref, "ref tag present on big result");
    const smallFile = join(dir, "s2.jsonl");
    const smallEntries = [
      msgEntry("f1", user("hi")),
      msgEntry("f2", toolResult("tc9", "bash", "tiny output")),
      msgEntry("f3", user("go")),
    ];
    const smallOut = await fireContext(handlers, fakeCtx(smallEntries, smallFile));
    assert.equal(resultText(smallOut, "tiny output").includes("[ACP absorb]"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("absorb hides the original pair and keeps the summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-absorb-"));
  try {
    const stateFile = join(dir, "session.jsonl");
    const big = "UNIQUE-BIG-MARKER " + "x".repeat(8000);
    const entries = [
      msgEntry("e1", user("run it")),
      msgEntry("e2", assistantToolCall("tc1", "bash", { command: "ls" })),
      msgEntry("e3", toolResult("tc1", "bash", big)),
      msgEntry("e4", user("continue")),
    ];
    const { api, handlers } = captureApi();
    createAcpExtension({ autoUpdate: false, absorb: true })(api);
    const ctx = fakeCtx(entries, stateFile);
    const out = await fireContext(handlers, ctx);
    const ref = resultText(out, "UNIQUE-BIG-MARKER").match(/m\d{4,}/)?.[0]!;
    const absorb = (api as any).tools.find((t: any) => t.name === "absorb");
    assert.ok(absorb, "absorb tool registered");
    const ok = await absorb.execute("call-1", { ref, summary: "ls output listed 3 files: a.ts, b.ts, c.ts (distilled summary)" }, {}, undefined, ctx);
    assert.match(ok.content[0].text, /^absorbed m\d+/);
    const followup = [
      ...entries,
      msgEntry("e5", assistantToolCall("tc2", "absorb", { ref, summary: "distilled summary" })),
      msgEntry("e6", toolResult("tc2", "absorb", ok.content[0].text)),
    ];
    const after = await fireContext(handlers, fakeCtx(followup, stateFile));
    const dump = JSON.stringify(after);
    assert.equal(dump.includes("UNIQUE-BIG-MARKER"), false, "original tool result should be hidden");
    assert.equal(dump.includes("distilled summary"), true, "summary should survive");
    const again = await absorb.execute("call-2", { ref, summary: "distilled summary" }, {}, undefined, ctx);
    assert.match(again.content[0].text, /already absorbed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("absorb rejects bad refs and empty summaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-absorb-"));
  try {
    const stateFile = join(dir, "session.jsonl");
    const entries = [
      msgEntry("e1", user("hi")),
      msgEntry("e2", toolResult("tc1", "bash", "out")),
      msgEntry("e3", user("go")),
    ];
    const { api, handlers } = captureApi();
    createAcpExtension({ autoUpdate: false, absorb: true })(api);
    const ctx = fakeCtx(entries, stateFile);
    fireContext(handlers, ctx);
    const absorb = (api as any).tools.find((t: any) => t.name === "absorb");
    await assert.rejects(absorb.execute("c1", { ref: "m99999", summary: "s" }, {}, undefined, ctx), /does not exist in this session/);
    await assert.rejects(absorb.execute("c2", { ref: "", summary: "s" }, {}, undefined, ctx), /Invalid absorb arguments/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("system prompt gains absorb section when enabled", () => {
  const on = captureApi();
  createAcpExtension({ autoUpdate: false, absorb: { toolName: "takeaway" } })(on.api);
  const handler = on.handlers.get("before_agent_start")![0] as (e: { systemPrompt: string }) => { systemPrompt: string };
  const result = handler({ systemPrompt: "BASE" });
  assert.ok(result.systemPrompt.includes("BASE"));
  assert.ok(result.systemPrompt.includes("takeaway"), "absorb section should mention tool name");
  const off = captureApi();
  createAcpExtension({ autoUpdate: false })(off.api);
  const offHandler = off.handlers.get("before_agent_start")![0] as (e: { systemPrompt: string }) => { systemPrompt: string };
  const offResult = offHandler({ systemPrompt: "BASE" });
  assert.ok(!offResult.systemPrompt.toLowerCase().includes("absorb"), "no absorb section when disabled");
});
