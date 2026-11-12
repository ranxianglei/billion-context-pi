import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { assertNotAborted } from "../src/abort.js";

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

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function fakeCtx(entries: any[], stateFile: string) {
  let usage: { tokens: number; percent: number } | null = null;
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => usage,
    __setUsage(t: number) { usage = { tokens: t, percent: t / 200_000 }; },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

function statePath(name: string): string {
  return join(tmpdir(), `pai-acp-${name}.session.json`);
}

async function prime(handlers: Map<string, any[]>, ctx: any) {
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

test("assertNotAborted passes for undefined/fresh signal, throws AbortError when aborted", () => {
  assert.doesNotThrow(() => assertNotAborted(undefined));
  assert.doesNotThrow(() => assertNotAborted(new AbortController().signal));
  const dead = new AbortController();
  dead.abort();
  assert.throws(
    () => assertNotAborted(dead.signal),
    (e: Error) => e.name === "AbortError" && e.message === "Operation aborted",
  );
});

test("compress rejects with AbortError on a pre-aborted signal and persists nothing", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = statePath("abort-compress");
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", "more context here to compress")];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await prime(handlers, ctx);

  const before = await readFile(`${stateFile}.acp.json`, "utf8").catch(() => null);
  const ctrl = new AbortController();
  ctrl.abort();
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await assert.rejects(
    () => compressTool.execute(
      "tc1",
      { content: [{ startId: "m00001", endId: "m00002", summary: "compressed" }] },
      ctrl.signal,
      () => {},
      ctx,
    ),
    (e: Error) => e.name === "AbortError" && e.message === "Operation aborted",
  );
  const after = await readFile(`${stateFile}.acp.json`, "utf8").catch(() => null);
  assert.equal(after, before);
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("decompress rejects with AbortError on a pre-aborted signal", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = statePath("abort-decompress");
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", "more context here")];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await prime(handlers, ctx);

  const ctrl = new AbortController();
  ctrl.abort();
  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  await assert.rejects(
    () => decompressTool.execute("tc1", { blockId: "b1" }, ctrl.signal, () => {}, ctx),
    (e: Error) => e.name === "AbortError" && e.message === "Operation aborted",
  );
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("compress completes normally when given a live (unaborted) signal", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = statePath("abort-live");
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", "中".repeat(300))];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await prime(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00002", summary: "compressed" }] },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.match(text, /▣ ACP \|/);
  await rm(`${stateFile}.acp.json`, { force: true });
});
