import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";
import { isCompressSuccessText, isCompressNoopText } from "../src/compress-tool.js";
import { tmpPath } from "./tmp-path.js";

// Issue #250 loop breaker (small local models, e.g. quantized 27B):
// the model repeats an identical compress call with refs that can NEVER
// resolve (stale — consumed by an active block — or unknown). The kernel
// rejects every time and the model just retries the same dead refs for
// minutes (issue log: 8 identical failures over 14 min AFTER the nudge cap
// fired — the cap only suppressed nudge re-injection, not the tool itself,
// and the kernel's "run acp_status" hint is unexecutable for small models).
//
// Behavior under test:
//  1. noteDeadCompress/clearDeadCompress: per-session, per-fingerprint
//     dead-range counter; cleared on the next successful compress.
//  2. After 2 identical all-dead failures the tool returns a hard rejection
//     (still a 0-block panel, so the per-turn failure counter keeps
//     advancing) that lists the LIVE compressible ranges — no acp_status
//     round-trip needed.
//  3. Once the turn's MAX_COMPRESS_ATTEMPTS cap is burned, EVERY compress
//     call is rejected until the next user message — even calls with live
//     refs (the turn is paused, not just the dead range).
//  4. A new user message resets the cap; a successful compress clears the
//     dead-range fingerprint (the same range can fail fresh again later).
//  5. enabled:false (adapter config or acp.json) registers nothing: no
//     tools, no context transform — Pi's native compaction stays active.

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

function roleMsg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now() } };
}

function toolResultMsg(id: string, toolCallId: string, text: string, isError: boolean) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: {
      role: "toolResult", toolCallId, toolName: "compress",
      content: [{ type: "text", text }], isError, timestamp: Date.now(),
    },
  };
}

function fakeCtx(getEntries: () => any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => getEntries(),
      getSessionId: () => "loop-test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

const textOf = (out: any) => (typeof out === "string" ? out : out.content?.[0]?.text ?? String(out));

const ZH = "中".repeat(6000);

// ─── unit: dead-range counter ───────────────────────────────────────────────

test("noteDeadCompress/clearDeadCompress: per-session, per-fingerprint, cleared on success", () => {
  const rt = createRuntime({});
  assert.equal(rt.noteDeadCompress("s1", "a"), 1);
  assert.equal(rt.noteDeadCompress("s1", "a"), 2);
  assert.equal(rt.noteDeadCompress("s1", "b"), 1, "different fingerprint counts independently");
  assert.equal(rt.noteDeadCompress("s2", "a"), 1, "different session counts independently");
  rt.clearDeadCompress("s1");
  assert.equal(rt.noteDeadCompress("s1", "a"), 1, "cleared fingerprint restarts at 1");
  assert.equal(rt.noteDeadCompress("s2", "a"), 2, "clearing one session leaves the other untouched");
});

// ─── integration: the issue #250 loop ───────────────────────────────────────

test("issue #250: dead-range repeat breaker + turn cap + reset on new turn", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = tmpPath("pai-acp-loop-main.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });

  // 16 alternating messages (last user = e15, recent zone = e12..e16, so
  // e9..e11 are the live compressible range after t1).
  let entries: any[] = [];
  for (let i = 1; i <= 16; i++) entries.push(roleMsg(`e${i}`, i % 2 ? "user" : "assistant", `m${i} ` + ZH));
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const S = (a: string, b: string) => [{ startId: a, endId: b, summary: "Loop breaker integration test summary covering the compressed range content." }];
  const run = async (id: string, ranges: any[]) => {
    const text = textOf(await compressTool.execute(id, { content: ranges }, undefined, undefined, ctx));
    entries = [...entries, toolResultMsg(`r${id}`, id, text, false)];
    await fire(handlers, ctx);
    return text;
  };

  const t1 = await run("tc1", S("m00001", "m00008"));
  assert.ok(isCompressSuccessText(t1), `t1 should succeed: ${t1}`);

  const t2 = await run("tc2", S("m00001", "m00008"));
  assert.ok(isCompressNoopText(t2), `t2 is a 0-block kernel panel: ${t2}`);
  assert.ok(!t2.includes("REJECTED"), "first dead failure shows the kernel's canonical error");

  const t3 = await run("tc3", S("m00001", "m00008"));
  assert.ok(t3.includes("REJECTED"), `t3 is the hard rejection: ${t3}`);
  assert.ok(isCompressNoopText(t3), "rejection stays a 0-block panel (counts toward the cap)");
  assert.ok(t3.includes("m00009"), `rejection lists the live compressible range: ${t3}`);

  const t4 = await run("tc4", S("m00001", "m00008"));
  assert.ok(t4.includes("REJECTED"), "t4 still rejected");

  // t2..t4 burned the turn's 3-attempt cap → every compress call is paused
  const t5 = await run("tc5", S("m00099", "m00100"));
  assert.ok(t5.includes("PAUSED"), `t5 paused by the turn cap: ${t5}`);

  const t6 = await run("tc6", S("m00009", "m00010"));
  assert.ok(t6.includes("PAUSED"), "even a LIVE range is paused until the next user message");

  entries = [...entries, roleMsg("e17", "user", "next question")];
  await fire(handlers, ctx);

  const t7 = await run("tc7", S("m00009", "m00010"));
  assert.ok(isCompressSuccessText(t7), `t7 succeeds after the new turn: ${t7}`);

  const t8 = await run("tc8", S("m00001", "m00008"));
  assert.ok(isCompressNoopText(t8), `t8 is a fresh kernel panel: ${t8}`);
  assert.ok(!t8.includes("REJECTED"), "fingerprint cleared by t7's success — no hard rejection yet");
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("issue #250: unknown-ref dead ranges get the hard rejection with a live snapshot", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = tmpPath("pai-acp-loop-unknown.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [];
  for (let i = 1; i <= 8; i++) entries.push(roleMsg(`e${i}`, i % 2 ? "user" : "assistant", `m${i} ` + ZH));
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const S = () => [{ startId: "m00099", endId: "m00100", summary: "unknown refs" }];
  const run = async (id: string) => {
    const text = textOf(await compressTool.execute(id, { content: S() }, undefined, undefined, ctx));
    entries = [...entries, toolResultMsg(`r${id}`, id, text, false)];
    await fire(handlers, ctx);
    return text;
  };

  const u1 = await run("uc1");
  assert.ok(isCompressNoopText(u1), `u1 is a 0-block kernel panel: ${u1}`);
  assert.ok(u1.includes("does not exist"), "kernel reports unknown refs");

  const u2 = await run("uc2");
  assert.ok(u2.includes("REJECTED"), `u2 is the hard rejection: ${u2}`);
  assert.ok(u2.includes("m00001"), `rejection lists the live compressible range: ${u2}`);
  await rm(`${stateFile}.acp.json`, { force: true });
});

// ─── enabled:false master switch ────────────────────────────────────────────

test("enabled:false (adapter config) registers nothing — Pi native compaction stays active", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, enabled: false })(api as any);
  assert.equal(api.tools.length, 0, "no tools registered");
  assert.equal(handlers.size, 0, "no event handlers wired");
});

test("enabled:false in project acp.json disables the adapter", () => {
  const dir = mkdtempSync(join(tmpdir(), "bcp-loop-disabled-"));
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "acp.json"), JSON.stringify({ enabled: false }));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    assert.equal(api.tools.length, 0, "no tools registered");
    assert.equal(handlers.size, 0, "no event handlers wired");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
