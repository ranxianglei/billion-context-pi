import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension, formatNudgeRecord } from "../src/index.js";
import type { NudgeDecision } from "acp-kernel";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { setRunNpmForTest } from "../src/update.js";
import { ACP_NUDGE_CUSTOM_TYPE } from "../src/messages.js";

// Headless handlers await the update check — keep this file hermetic too.
setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_UPDATE_THROTTLE_FILE = join(tmpdir(), `acp-test-nudge-record-throttle-${process.pid}`);

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const entryRenderers = new Map<string, ((entry: any, options: any, theme: any) => any)[]>();
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
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
    registerEntryRenderer(customType: string, renderer: any) { entryRenderers.set(customType, renderer); },
    appendEntry(customType: string, data?: unknown) { appendedEntries.push({ customType, data }); },
  };
  return { api, handlers, entryRenderers, appendedEntries };
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
      getSessionId: () => "nudge-record-session",
      getSessionFile: () => stateFile,
    },
  };
}

// ─── unit: record format ────────────────────────────────────────────────────

test("formatNudgeRecord: compact one-liner matching the issue #326 example", () => {
  const base = {
    shouldInject: true,
    reason: "context pressure",
    contextUsage: 0.953,
    tier: null,
    compressibleRanges: [
      { startRef: "m00001", endRef: "m00010", count: 10, tokens: 500 },
      { startRef: "m00120", endRef: "m00168", count: 48, tokens: 3000 },
    ],
    breakdown: {},
  } as unknown as NudgeDecision;
  assert.equal(formatNudgeRecord(base, true), "[ACP nudge] EMERGENCY 95% · T1 · top range m00120–m00168");
  assert.equal(formatNudgeRecord(base, false), "[ACP nudge] 95% · T1 · top range m00120–m00168");
  assert.equal(formatNudgeRecord({ ...base, tier: 2 } as NudgeDecision, false), "[ACP nudge] 95% · T2 · top range m00120–m00168");
  assert.equal(formatNudgeRecord({ ...base, compressibleRanges: [] } as NudgeDecision, true), "[ACP nudge] EMERGENCY 95% · T1");
});

// ─── integration: persistence wiring ────────────────────────────────────────

test("nudge injection persists exactly one display-only entry per user turn (issue #326)", async () => {
  const { api, handlers, entryRenderers, appendedEntries } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const stateFile = join(tmpdir(), `pai-acp-nudge-record-${process.pid}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });

  assert.ok(entryRenderers.has(ACP_NUDGE_CUSTOM_TYPE), "entry renderer registered at factory time");

  // ~270K tokens of sent view vs a 180K window → kernel goes EMERGENCY and
  // the nudge re-injects on every context fire (dedup bypass).
  const MID = "lorem ".repeat(3000);
  const roleMsg = (id: string, role: string, text: string) => ({
    type: "message", id, parentId: null, timestamp: "",
    message: { role, content: text, timestamp: Date.now() },
  });
  let entries: any[] = [roleMsg("u0", "user", "start " + MID)];
  for (let i = 1; i <= 59; i++) entries.push(roleMsg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const ctx = fakeCtx(() => entries, stateFile);
  const fire = () => handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const nudgeCount = (r: any) =>
    (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached/.test(JSON.stringify(m.content))).length;

  const r0 = await fire();
  assert.ok(nudgeCount(r0) >= 1, "emergency nudge fires on real overflow");
  assert.equal(appendedEntries.length, 1, "one persisted record on first injection");
  assert.equal(appendedEntries[0].customType, ACP_NUDGE_CUSTOM_TYPE);
  assert.match(String(appendedEntries[0].data?.text), /^\[ACP nudge\] EMERGENCY \d+% · T\d+( · top range m\d+–m\d+)?$/);

  // Second LLM call of the SAME turn: the emergency nudge re-injects into
  // context, but the session file must not gain a second record.
  const r1 = await fire();
  assert.ok(nudgeCount(r1) >= 1, "emergency re-injection still reaches the model");
  assert.equal(appendedEntries.length, 1, "no duplicate record within the same turn");

  // New user message → new turn key → next injection records again.
  entries = [...entries, roleMsg("u1", "user", "next " + MID)];
  const r2 = await fire();
  assert.ok(nudgeCount(r2) >= 1, "nudge fires for the new turn");
  assert.equal(appendedEntries.length, 2, "new turn gets its own record");

  await rm(`${stateFile}.acp.json`, { force: true });
});

test("acp-nudge entry renderer builds a dim boxed component", () => {
  const { api, entryRenderers } = captureApi();
  createAcpExtension({})(api as any);
  const renderer = entryRenderers.get(ACP_NUDGE_CUSTOM_TYPE)!;
  const theme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
  } as Theme;

  const comp = renderer({ customType: ACP_NUDGE_CUSTOM_TYPE, data: { text: "[ACP nudge] EMERGENCY 95% · T1" } }, { expanded: false }, theme);
  assert.ok(comp, "well-formed record renders a component");
  assert.equal(comp.children.length, 1, "box holds the text child");

  assert.equal(renderer({ customType: ACP_NUDGE_CUSTOM_TYPE, data: {} }, { expanded: false }, theme), undefined, "missing text → invisible but persisted");
});
