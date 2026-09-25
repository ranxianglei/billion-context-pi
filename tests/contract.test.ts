import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { SIDECAR_SCHEMA_VERSION, sidecarProducer, type BcpBlockV1, type BcpSidecarV1 } from "../src/contract.js";
import type { CompressionBlock } from "acp-kernel";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// issue #368: downstream tools glob <sessionFile>.acp.json directly. The
// sidecar must carry an explicit contract: schemaVersion + producer headers,
// blocks shaped as the exported BcpBlockV1, atomically replaced.
test("saved sidecar carries schemaVersion/producer and BcpBlockV1-shaped blocks", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const stateFile = tmpPath("pai-acp-contract.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [
    { type: "message", id: "e1", parentId: null, timestamp: "", message: { role: "user", content: "中".repeat(6000), timestamp: Date.now() } },
    { type: "message", id: "e2", parentId: null, timestamp: "", message: { role: "user", content: "中".repeat(6000), timestamp: Date.now() } },
  ];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "contract test block: sidecar must carry the v1 schema headers on every save" }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(text.includes("▣ ACP"), `compress failed: ${text}`);

  const sidecar = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8")) as BcpSidecarV1;
  assert.equal(sidecar.schemaVersion, SIDECAR_SCHEMA_VERSION);
  assert.match(sidecar.producer, /^billion-context-pi@/);
  assert.ok(Array.isArray(sidecar.blocks) && sidecar.blocks.length > 0);
  const b = sidecar.blocks[0]!;
  assert.match(b.blockId, /^b\d+$/);
  assert.ok(typeof b.summary === "string" && b.summary.length > 0);
  assert.ok([1, 2, 3].includes(b.tier));
  assert.ok(Array.isArray(b.directMessageIds));
  assert.equal(typeof b.createdAt, "number");
  assert.ok(["young", "old"].includes(b.generation));
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("sidecarProducer identifies the writer", () => {
  assert.match(sidecarProducer(), /^billion-context-pi@/);
});

// #368: blocks persist verbatim as kernel CompressionBlock. The exported
// BcpBlockV1 is an inlined mirror, so this compile-time assertion fails typecheck
// if the kernel drops/renames a field the mirror requires but no longer provides.
test("kernel CompressionBlock still covers the exported BcpBlockV1 shape", () => {
  const cover: [CompressionBlock] extends [BcpBlockV1] ? true : never = true;
  assert.equal(cover, true);
});

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
      getSessionId: () => "contract-session",
      getSessionFile: () => stateFile,
    },
  };
}
