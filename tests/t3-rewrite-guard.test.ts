import assert from "node:assert/strict";
import test from "node:test";
import { rm, readFile } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

const ZH = "概";
const body = (n: number) => "body " + n + " " + ZH.repeat(6000);

function captureApi() {
  const handlers = new Map<string, Array<(payload: unknown, ctx: unknown) => void>>();
  const api = {
    on: (e: string, h: (payload: unknown, ctx: unknown) => void) => {
      const l = handlers.get(e) ?? [];
      l.push(h);
      handlers.set(e, l);
    },
    tools: [] as Array<{ name: string; execute: (callId: string, args: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }>,
    commands: new Map<string, unknown>(),
    registerTool: function (t: { name: string }) {
      this.tools.push(t as never);
    },
    registerCommand: function (n: string, o: unknown) {
      this.commands.set(n, o);
    },
  };
  return { api, handlers };
}

function userMsg(n: number) {
  return {
    type: "message",
    id: "e" + n,
    parentId: null,
    timestamp: "",
    message: { role: "user", content: body(n), timestamp: Date.now() },
  };
}

function fakeCtx(entries: Array<ReturnType<typeof userMsg>>, stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: {
      notify: () => {},
      confirm: async () => true,
      select: async () => undefined,
      input: async () => "",
      setStatus: () => {},
    },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "s",
      getSessionFile: () => stateFile,
    },
  };
}

async function setup(stateFile: string) {
  await rm(stateFile + ".acp.json", { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as never);
  const entries = Array.from({ length: 12 }, (_, i) => userMsg(i));
  const ctx = fakeCtx(entries, stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const tool = api.tools.find((t) => t.name === "compress")!;
  const run = async (content: unknown) => {
    const out = await tool.execute("c", { content }, undefined, undefined, ctx);
    return typeof out === "string" ? out : (out as { content: Array<{ text: string }> }).content[0]!.text;
  };
  return { run, stateFile };
}

const stateOf = async (f: string) => JSON.parse(await readFile(f + ".acp.json", "utf8"));

test("tier-3-only rewrite is rejected and state is rolled back (dog/billion-context-pi#3)", async () => {
  const stateFile = "/tmp/pai-acp-t3-guard.session.json";
  const { run } = await setup(stateFile);
  const sum = (t: string) => t + " " + ZH.repeat(80);

  await run([{ startId: "m00001", endId: "m00002", summary: sum("s1") }]);
  const before = await stateOf(stateFile);
  assert.equal(before.blocks.length, 1);

  await run([{ startId: "b1", endId: "b1", summary: sum("t2") }]);
  await run([{ startId: "b2", endId: "b2", summary: sum("t3") }]);
  const atT3 = await stateOf(stateFile);
  assert.equal(atT3.blocks.length, 3);
  assert.equal(atT3.blocks.filter((b: { active: boolean }) => b.active).length, 1);
  assert.equal(atT3.blocks.find((b: { active: boolean }) => b.active).tier, 3);

  await assert.rejects(
    () => run([{ startId: "b3", endId: "b3", summary: sum("rw1") }]),
    /only re-condenses terminal tier-3 block/,
  );
  await assert.rejects(
    () => run([{ startId: "b3", endId: "b3", summary: sum("rw2") }]),
    /only re-condenses terminal tier-3 block/,
  );

  const after = await stateOf(stateFile);
  assert.equal(after.blocks.length, atT3.blocks.length);
  assert.equal(after.blocks.filter((b: { active: boolean }) => b.active).length, 1);
  assert.equal(after.blocks.find((b: { active: boolean }) => b.active).tier, 3);
});

test("lower-tier distillation still allowed: T2 block condenses to T3", async () => {
  const stateFile = "/tmp/pai-acp-t3-allow.session.json";
  const { run } = await setup(stateFile);
  const sum = (t: string) => t + " " + ZH.repeat(80);

  const t1 = await run([{ startId: "m00001", endId: "m00002", summary: sum("s1") }]);
  assert.match(t1, /▣ ACP \|/);
  assert.doesNotMatch(t1, /re-condenses/);

  const t2 = await run([{ startId: "b1", endId: "b1", summary: sum("t2") }]);
  assert.match(t2, /▣ ACP \|/);
  assert.doesNotMatch(t2, /re-condenses/);

  const t3 = await run([{ startId: "b2", endId: "b2", summary: sum("t3") }]);
  assert.match(t3, /▣ ACP \|/);
  assert.doesNotMatch(t3, /re-condenses/);
  const st = await stateOf(stateFile);
  assert.equal(st.blocks.length, 3);
  const active = st.blocks.find((b: { active: boolean }) => b.active);
  assert.equal(active.tier, 3);
});
