import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// issue #616: pi 1.0.x built-in MCP publishes its server list as a mid-session
// system message carrying only `sections.mcp_servers` (empty content). Before
// the fix the model-visible prompt lost `<mcp_servers>` on the very first
// rebuild (the patch projects to no core message) and again after any
// compression block covering an earlier system message (index-based pairing
// dropped the unpaired input system).

const MCP_SECTION = "<mcp_servers>\n- docx_mcp (codemode)\n</mcp_servers>";

function buildHarness() {
  const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
  const api: any = {
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as unknown[],
    commands: new Map<string, unknown>(),
    registerTool(tool: unknown) { this.tools.push(tool); },
    registerCommand(name: string, options: unknown) { this.commands.set(name, options); },
  };
  createAcpExtension({ modelContextLimit: 200_000 })(api);
  return { handlers, api };
}

function sysMsg(id: string, content: string, sections: Record<string, string | null>, ts: number) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "system", content, sections, timestamp: ts } };
}
function userMsg(id: string, text: string, ts: number) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: ts } };
}
function assistantMsg(id: string, text: string, ts: number) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "text", text }] , timestamp: ts, provider: "test", model: "test-model" } };
}

test("MCP <mcp_servers> section survives rebuilds and compression (#616)", async () => {
  const { handlers, api } = buildHarness();
  const stateFile = tmpPath("pai-acp-mcp-sections-e2e.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });

  const big = "lorem ipsum dolor sit amet ".repeat(80);
  let ts = 1_700_000_000_000;
  const nextTs = () => (ts += 1000);
  const entries = [
    sysMsg("e-sys0", "You are a coding agent.", { env: "<env>linux</env>" }, nextTs()),
    userMsg("e-u1", big, nextTs()),
    assistantMsg("e-a1", big, nextTs()),
    userMsg("e-u2", big, nextTs()),
    assistantMsg("e-a2", big, nextTs()),
    sysMsg("e-sys1", "", { mcp_servers: MCP_SECTION }, nextTs()),
    userMsg("e-u3", big, nextTs()),
    assistantMsg("e-a3", big, nextTs()),
    userMsg("e-u4", big, nextTs()),
    assistantMsg("e-a4", big, nextTs()),
    userMsg("e-u5", big, nextTs()),
    assistantMsg("e-a5", big, nextTs()),
    userMsg("e-u6", big, nextTs()),
    assistantMsg("e-a6", big, nextTs()),
  ];

  const ctx: any = {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "mcp-sections-session",
      getSessionFile: () => stateFile,
    },
  };

  const fire = async () => {
    const res = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
    return (res as { messages: unknown[] }).messages;
  };
  const systemsOf = (msgs: unknown[]) => msgs.filter((m) => (m as { role?: string }).role === "system") as Record<string, unknown>[];
  const mcpVisible = (msgs: unknown[]) => JSON.stringify(systemsOf(msgs).map((s) => s.sections)).includes("docx_mcp");

  const q1 = await fire();
  assert.ok(mcpVisible(q1), `before compression: <mcp_servers> must be visible, got systems: ${JSON.stringify(systemsOf(q1).map((s) => s.sections))}`);
  assert.ok(JSON.stringify(systemsOf(q1).map((s) => s.sections)).includes("<env>"), "leading system's env section must stay visible");

  const compressTool = (api.tools as { name: string; execute: (...a: unknown[]) => Promise<unknown> }[]).find((t) => t.name === "compress")!;
  const out = await compressTool.execute("tc1", {
    content: JSON.stringify([{ startId: "m00001", endId: "m00005", summary: "Early turns one and two completed; MCP server docx_mcp registered with codemode tools available for document work." }]),
  }, undefined, undefined, ctx);
  const panel = typeof out === "string" ? out : String((out as { content?: { text?: string }[] }).content?.[0]?.text ?? "");
  assert.match(panel, /▣ ACP \|/, `expected a compress panel, got: ${panel}`);

  const q2 = await fire();
  assert.ok(mcpVisible(q2), `after compression: <mcp_servers> must still be visible, got systems: ${JSON.stringify(systemsOf(q2).map((s) => s.sections))}`);
  const q2Sys = systemsOf(q2);
  const envIdx = q2Sys.findIndex((s) => JSON.stringify(s.sections).includes("<env>"));
  const mcpIdx = q2Sys.findIndex((s) => JSON.stringify(s.sections).includes("docx_mcp"));
  assert.ok(envIdx >= 0 && mcpIdx >= 0 && envIdx < mcpIdx, `host order of system messages must be preserved, got: ${JSON.stringify(q2Sys.map((s) => s.sections))}`);

  await rm(`${stateFile}.acp.json`, { force: true });
});
