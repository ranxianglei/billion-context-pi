import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

const STATE_FILE = "/tmp/pai-acp-warnings-it.session.json";

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

async function cleanState() {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
}

function fakeCtx(entries: any[]) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

async function setup(entries: any[]) {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const ctx = fakeCtx(entries);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  return { compressTool, ctx };
}

const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
const filler = (n: string) => `filler ${n} `.repeat(400);

test("软保护区排除消息 → kernel warnings 透出到结果行", async () => {
  await cleanState();
  const entries = [
    userMsg("e1", longText),
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];
  const { compressTool, ctx } = await setup(entries);
  const res = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00007", summary: "Compressed the early session content including all setup messages." }] },
    undefined, undefined, ctx,
  );
  const text = (res.content[0] as any).text as string;
  assert.match(text, /⚠️/, "warning line should be surfaced in the result");
  assert.match(text, /Excluded \d+ protected message\(s\)/, "warning should mention protected exclusions");
});
