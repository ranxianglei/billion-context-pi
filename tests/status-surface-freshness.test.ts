import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// issue #608: #601 made the live context hook reject the host's raw session-tree
// total after a failed latest assistant turn, but the three reporting surfaces
// (acp_status tool, /acp, /acp-status) still passed the inflated count to
// processTurn and mislabeled the replayed fallback estimate "Provider-reported".
// They must apply the same selection as src/index.ts (#601):
// fresh || lastRealTokens <= 0 ? reportedHost : lastRealTokens — for BOTH the
// nudge decision and the display. Fresh readings, the no-anchor tree-sum
// fallback, and post-compression behavior stay intact.

// tsup defines CURRENT_VERSION at build time; under the node test runner it
// is a bare global — stub it like tests/commands-kit-panel.test.ts does.
(globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";

const WINDOW = 180_000;
const PANEL_OK = "▣ ACP | 42.3K → 18.9K tokens (~23.4K reclaimed, 3 blocks)";

function captureApi() {
  const api = {
    on() {},
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return api;
}

const msg = (id: string, message: Record<string, unknown>) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { timestamp: Date.now(), ...message },
});

// Sized exactly like tests/host-floor-freshness.test.ts so ONLY the host floor
// can flip the nudge: the estimate's effective compressible mass stays below
// the flat 50K nudge-growth floor while an inflated tree-sum floor (~97%) lands
// in the emergency band and a 60K floor does not.
const MID = "lorem ".repeat(1800);

const baseStream = (): any[] => {
  const entries = [msg("e0", { role: "user", content: "start " + MID })];
  for (let i = 1; i <= 17; i++) entries.push(msg(`e${i}`, { role: i % 2 ? "assistant" : "user", content: `f${i} ` + MID }));
  return entries;
};

const usedAssistant = (id: string, input: number) =>
  msg(id, { role: "assistant", content: "ok " + MID, usage: { input, cacheRead: 0, cacheWrite: 0 } });

const erroredAssistant = (id: string) =>
  msg(id, { role: "assistant", content: "err " + MID, stopReason: "error", errorMessage: "Error: fetch failed" });

const compressResult = (id: string) =>
  msg(id, { role: "toolResult", toolName: "compress", toolCallId: "c1", isError: false, content: [{ type: "text", text: PANEL_OK }] });

interface Surf {
  api: any;
  ctx: any;
  notifies: string[];
}

function setup(entries: any[], stateFile: string, hostTokens: number): Surf {
  const api = captureApi();
  createAcpExtension({ modelContextLimit: WINDOW })(api as any);
  const notifies: string[] = [];
  const ctx = {
    mode: "rpc",
    hasUI: false,
    ui: { notify: (t: string) => { notifies.push(t); }, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: WINDOW },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "status-surf-" + hostTokens,
      getSessionFile: () => stateFile,
    },
    getContextUsage: () => ({ tokens: hostTokens, percent: hostTokens / WINDOW, contextWindow: WINDOW }),
  };
  return { api, ctx, notifies };
}

async function statusToolText(s: Surf): Promise<string> {
  const tool = s.api.tools.find((t: any) => t.name === "acp_status")!;
  const res = await tool.execute("tc1", {}, undefined, undefined, s.ctx);
  return (res.content[0] as any).text as string;
}

async function commandText(s: Surf, name: string): Promise<string> {
  await s.api.commands.get(name)!.handler("", s.ctx);
  assert.ok(s.notifies.length > 0, `${name} notified output`);
  return s.notifies[s.notifies.length - 1] as string;
}

const FAILED_LATEST = (): any[] => [...baseStream(), usedAssistant("e18", 60_000), erroredAssistant("e19")];

test("acp_status: failed latest turn rejects the tree-sum — idle nudge, 'Last valid usage' label", async () => {
  const stateFile = tmpPath("pai-acp-status-surf-failed.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup(FAILED_LATEST(), stateFile, 174_000);
    const text = await statusToolText(s);
    assert.match(text, /Nudge: idle/, "nudge idle: processTurn floored at last real reading (60K), not the 174K tree-sum");
    assert.doesNotMatch(text, /Nudge: ACTIVE/, "no emergency nudge from the rejected tree-sum");
    assert.match(text, /Last valid usage: 60\.0k/, "display shows the replayed last real reading");
    assert.doesNotMatch(text, /Provider-reported: 174\.0k/, "the inflated tree-sum is neither shown nor labeled Provider-reported");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("acp_status: fresh provider reading is still trusted (control)", async () => {
  const stateFile = tmpPath("pai-acp-status-surf-fresh.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup([...baseStream(), usedAssistant("e18", 175_000)], stateFile, 175_000);
    const text = await statusToolText(s);
    assert.match(text, /Nudge: ACTIVE/, "emergency still fires from a FRESH 175K reading (#257 path intact)");
    assert.match(text, /Provider-reported: 175\.0k/, "fresh reading keeps the Provider-reported label");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("acp_status: no valid anchor anywhere — tree-sum fallback preserved", async () => {
  const stateFile = tmpPath("pai-acp-status-surf-noanchor.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup(baseStream(), stateFile, 174_000);
    const text = await statusToolText(s);
    assert.match(text, /Nudge: ACTIVE/, "with no anchor at all the tree-sum is still trusted (#601 no-anchor fallback)");
    assert.match(text, /Provider-reported: 174\.0k/, "degenerate case keeps the existing label/value");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("/acp: failed latest turn floors the session line at the last real reading", async () => {
  const stateFile = tmpPath("pai-acp-cmd-acp-failed.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup(FAILED_LATEST(), stateFile, 174_000);
    const text = await commandText(s, "acp");
    assert.match(text, /Nudge: idle/, "/acp panel nudges off the floored tokenCount");
    assert.match(text, /Context \(session accounting.*?\(60k \//, "session line shows the last real reading");
    assert.doesNotMatch(text, /174k/, "inflated tree-sum absent from the panel");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("/acp-status: failed latest turn floors the session line at the last real reading", async () => {
  const stateFile = tmpPath("pai-acp-cmd-acpstatus-failed.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup(FAILED_LATEST(), stateFile, 174_000);
    const text = await commandText(s, "acp-status");
    assert.match(text, /Nudge: idle/, "/acp-status panel nudges off the floored tokenCount");
    assert.match(text, /Context \(session accounting.*?\(60k \//, "session line shows the last real reading");
    assert.doesNotMatch(text, /174k/, "inflated tree-sum absent from the panel");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("/acp: fresh reading still drives session line and nudge (control)", async () => {
  const stateFile = tmpPath("pai-acp-cmd-acp-fresh.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup([...baseStream(), usedAssistant("e18", 175_000)], stateFile, 175_000);
    const text = await commandText(s, "acp");
    assert.match(text, /Nudge: ACTIVE/, "fresh 175K reading still trips the emergency nudge");
    assert.match(text, /Context \(session accounting.*?\(175k \//, "session line shows the fresh reading");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("/acp: successful compress after the anchor — sent-view-only metering preserved", async () => {
  const stateFile = tmpPath("pai-acp-cmd-acp-predates.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup([...baseStream(), usedAssistant("e18", 60_000), compressResult("e19")], stateFile, 174_000);
    const text = await commandText(s, "acp");
    assert.match(text, /Nudge: idle/, "post-compression staleness still skips the host floor entirely (existing behavior)");
    assert.doesNotMatch(text, /Nudge: ACTIVE/, "pre-compression tree-sum must not re-fire a nudge after a compress");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

// review #611: pin the predates && !fresh corner (successful compress after the
// anchor, THEN a failed latest turn). Decision stays sent-view-only; the display
// must show the replayed anchor under the honest label instead of relabeling the
// inflated tree-sum "Provider-reported".
test("acp_status: post-compression + failed latest — sent-view metering kept, honest 'Last valid usage' label", async () => {
  const stateFile = tmpPath("pai-acp-status-surf-predates-failed.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  try {
    const s = setup([...baseStream(), usedAssistant("e18", 60_000), compressResult("e19"), erroredAssistant("e20")], stateFile, 174_000);
    const text = await statusToolText(s);
    assert.match(text, /Nudge: idle/, "predates keeps sent-view-only metering despite the failed latest turn");
    assert.doesNotMatch(text, /Nudge: ACTIVE/, "pre-compression tree-sum must not re-fire a nudge");
    assert.match(text, /Last valid usage: 60\.0k/, "replayed anchor shown under the honest label");
    assert.doesNotMatch(text, /Provider-reported/, "the inflated tree-sum is not labeled as a live provider reading");
  } finally {
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});
