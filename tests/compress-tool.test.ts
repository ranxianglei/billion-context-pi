import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

const STATE_FILE = "/tmp/pai-acp-compress-tool-it.session.json";

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

function toolCallMsg(id: string, callId: string, args: unknown) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: { role: "assistant", content: [{ type: "toolCall", name: "decompress", id: callId, arguments: args }], timestamp: Date.now() },
  };
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
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

async function setup(entries: any[]) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const ctx = fakeCtx(entries);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  return { compressTool, ctx };
}

async function readBlocks() {
  const raw = await readFile(`${STATE_FILE}.acp.json`, "utf8");
  return (JSON.parse(raw) as any).blocks;
}

const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
const filler = (n: string) => `filler ${n} `.repeat(400);

test("范围含 decompress 调用且摘要未提及 → 机械补记 [auto] 行", async () => {
  await cleanState();
  const entries = [
    toolCallMsg("e1", "dc1", { blockId: "b1" }),
    userMsg("e2", longText),
    userMsg("e3", filler("three")), userMsg("e4", filler("four")),
    userMsg("e5", filler("five")), userMsg("e6", filler("six")),
    userMsg("e7", filler("seven")),
  ];
  const { compressTool, ctx } = await setup(entries);
  const res = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00002", summary: "Compressed early session content including setup messages." }] },
    undefined, undefined, ctx,
  );
  const blocks = await readBlocks();
  assert.equal(blocks.length, 1);
  assert.ok(
    blocks[0].summary.includes('[auto] decompress ops: decompress({"blockId":"b1"})'),
    `block summary should carry the mechanical ops line, got: ${blocks[0].summary}`,
  );
});

test("T2 蒸馏 b1 时 [auto] 行接力到新摘要", async () => {
  await cleanState();
  const entries = [
    toolCallMsg("e1", "dc1", { blockId: "b1" }),
    userMsg("e2", longText),
    userMsg("e3", filler("three")), userMsg("e4", filler("four")),
    userMsg("e5", filler("five")), userMsg("e6", filler("six")),
    userMsg("e7", filler("seven")),
  ];
  const { compressTool, ctx } = await setup(entries);
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00002", summary: "Compressed early session content including setup messages." }] },
    undefined, undefined, ctx,
  );
  await compressTool.execute(
    "tc2",
    { content: [{ startId: "b1", endId: "b1", summary: "Tier-2 distillation of the early session content and its key takeaways." }] },
    undefined, undefined, ctx,
  );
  const blocks = await readBlocks();
  const b2 = blocks.find((b: any) => b.tier === 2);
  assert.ok(b2, "tier-2 block should exist");
  assert.ok(
    b2.summary.includes('[auto] decompress ops: decompress({"blockId":"b1"})'),
    `tier-2 summary should relay the ops line, got: ${b2.summary}`,
  );
});

test("范围无 decompress 调用 → 零误报（无 [auto] 行）", async () => {
  await cleanState();
  const entries = [
    userMsg("e1", longText), userMsg("e2", longText),
    userMsg("e3", filler("three")), userMsg("e4", filler("four")),
    userMsg("e5", filler("five")), userMsg("e6", filler("six")),
    userMsg("e7", filler("seven")),
  ];
  const { compressTool, ctx } = await setup(entries);
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00002", summary: "Compressed early session content including setup messages." }] },
    undefined, undefined, ctx,
  );
  const blocks = await readBlocks();
  assert.ok(
    !blocks[0].summary.includes("[auto] decompress ops"),
    `no decompress ops line expected, got: ${blocks[0].summary}`,
  );
});

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
