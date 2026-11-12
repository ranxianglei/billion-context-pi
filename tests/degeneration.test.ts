import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DEGENERATION_GUARD,
  collapseAssistantDegeneration,
  collapseDegenerateRuns,
  degenerationNotice,
  findDegenerateRuns,
  lastAssistantRuns,
  resolveDegenerationGuard,
} from "../src/degeneration.js";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setRunNpmForTest } from "../src/update.js";

type AgentMessage = SessionMessageEntry["message"];

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));

// ---------- resolveDegenerationGuard ----------

test("resolve: defaults and boolean shorthand", () => {
  assert.deepEqual(DEFAULT_DEGENERATION_GUARD, { enabled: true, minRun: 200 });
  assert.deepEqual(resolveDegenerationGuard(undefined), { enabled: true, minRun: 200 });
  assert.deepEqual(resolveDegenerationGuard(true), { enabled: true, minRun: 200 });
  assert.deepEqual(resolveDegenerationGuard({}), { enabled: true, minRun: 200 });
  assert.deepEqual(resolveDegenerationGuard(false), { enabled: false, minRun: 200 });
  assert.equal(resolveDegenerationGuard({ enabled: false }).enabled, false);
});

test("resolve: minRun validation — floor at 8, invalid falls back to default", () => {
  assert.equal(resolveDegenerationGuard({ minRun: 500 }).minRun, 500);
  assert.equal(resolveDegenerationGuard({ minRun: 8 }).minRun, 8);
  assert.equal(resolveDegenerationGuard({ minRun: 7 }).minRun, 8);
  assert.equal(resolveDegenerationGuard({ minRun: 2 }).minRun, 8);
  assert.equal(resolveDegenerationGuard({ minRun: 2.9 }).minRun, 8);
  assert.equal(resolveDegenerationGuard({ minRun: 1 }).minRun, 200);
  assert.equal(resolveDegenerationGuard({ minRun: -5 }).minRun, 200);
  assert.equal(resolveDegenerationGuard({ minRun: Number.NaN }).minRun, 200);
  assert.equal(resolveDegenerationGuard({ minRun: "200" as unknown as number }).minRun, 200);
});

// ---------- findDegenerateRuns ----------

test("find: detects the #351 signature run (4655×「【」)", () => {
  const runs = findDegenerateRuns("【".repeat(4655), 200);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { char: "【", count: 4655, index: 0 });
});

test("find: boundary — exactly minRun hits, minRun-1 misses", () => {
  assert.equal(findDegenerateRuns("x".repeat(200), 200).length, 1);
  assert.equal(findDegenerateRuns("x".repeat(199), 200).length, 0);
});

test("find: multiple runs, maximal extents, utf16 indices", () => {
  const s = "ab" + "-".repeat(210) + "xy" + "=".repeat(300);
  const runs = findDegenerateRuns(s, 200);
  assert.deepEqual(runs, [
    { char: "-", count: 210, index: 2 },
    { char: "=", count: 300, index: 214 },
  ]);
});

test("find: astral codepoints count as one unit (surrogate-pair safe)", () => {
  const s = "🚀".repeat(250);
  const runs = findDegenerateRuns(s, 200);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.char, "🚀");
  assert.equal(runs[0]?.count, 250);
  // utf16 index math stays consistent across astral characters: "a🚀b" = 1+2+1 utf16 units
  const mixed = "a🚀b" + "★".repeat(205);
  assert.equal(findDegenerateRuns(mixed, 200)[0]?.index, 4);
});

test("find: whitespace runs detected like any other character", () => {
  assert.equal(findDegenerateRuns("\n".repeat(500), 200)[0]?.char, "\n");
  assert.equal(findDegenerateRuns(" ".repeat(200), 200)[0]?.char, " ");
});

test("find: empty input / minRun < 2 → no runs", () => {
  assert.deepEqual(findDegenerateRuns("", 200), []);
  assert.deepEqual(findDegenerateRuns("x".repeat(500), 1), []);
  assert.deepEqual(findDegenerateRuns("x".repeat(500), Number.NaN), []);
});

test("pre-screen: large clean block takes the fast path and stays clean", () => {
  const s = "abcdefghij".repeat(20_000); // 200k chars, longest run = 1
  assert.deepEqual(findDegenerateRuns(s, 200), []);
  assert.equal(collapseDegenerateRuns(s, 200), s, "clean input returned unchanged");
});

test("pre-screen: sub-threshold runs scattered through a large block stay undetected", () => {
  let s = "";
  for (let i = 0; i < 500; i++) s += "a".repeat(199) + String.fromCharCode(66 + (i % 25)); // B..Z filler, never 'a'
  assert.equal(s.length, 500 * 200);
  assert.deepEqual(findDegenerateRuns(s, 200), [], "199-runs miss both the pre-screen and the scan");
});

test("pre-screen: astral and line-terminator runs still detected through the fast path", () => {
  assert.equal(findDegenerateRuns("🚀".repeat(250), 200).length, 1, "/u keeps surrogate pairs whole");
  assert.equal(findDegenerateRuns("\n".repeat(300), 200).length, 1, "/s matches line terminators");
  assert.equal(findDegenerateRuns("\u0000".repeat(200), 200).length, 1, "/s matches NUL");
});

// ---------- collapseDegenerateRuns ----------

test("collapse: no-op returns input unchanged when clean", () => {
  const s = "normal text with --- hrules and some 「【」 emphasis";
  assert.equal(collapseDegenerateRuns(s, 200), s);
});

test("collapse: replaces the run with a short marker, keeps surroundings", () => {
  const s = "prefix " + "【".repeat(4655) + " suffix";
  const out = collapseDegenerateRuns(s, 200);
  assert.ok(out.startsWith("prefix 【【【"), `marker keeps up to 3 copies: ${out.slice(0, 20)}`);
  assert.ok(out.endsWith(" suffix"));
  assert.ok(out.includes("[4655× identical chars cut — degenerate repeat]"));
  assert.ok(!out.includes("【".repeat(4)), "no long run survives");
  assert.ok(out.length < 100, `marker is compact (${out.length} chars vs 4700 original)`);
});

test("collapse: idempotent — collapsing twice yields the same result", () => {
  const s = "a" + "【".repeat(4655) + "b" + "\n".repeat(300) + "c";
  const once = collapseDegenerateRuns(s, 200);
  assert.equal(collapseDegenerateRuns(once, 200), once);
});

test("collapse: idempotent at the minimum threshold (marker is re-scan safe)", () => {
  const s = "z" + "q".repeat(10) + "w";
  const once = collapseDegenerateRuns(s, 8);
  assert.equal(collapseDegenerateRuns(once, 8), once);
});

test("collapse: whitespace runs are handled like any other character", () => {
  const out = collapseDegenerateRuns("head\n" + "\n".repeat(499) + "tail", 200);
  assert.ok(out.includes("[500× identical chars cut — degenerate repeat]"));
  assert.ok(!out.includes("\n".repeat(4)), "no long newline run survives");
});

test("collapse: control-char runs collapse without throwing", () => {
  const out = collapseDegenerateRuns("\u0000".repeat(201), 200);
  assert.ok(out.includes("[201× identical chars cut — degenerate repeat]"));
  assert.ok(!out.includes("\u0000".repeat(4)));
});

// ---------- collapseAssistantDegeneration ----------

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] , timestamp: 0 } as unknown as AgentMessage;
}

function assistant(parts: unknown[]): AgentMessage {
  return { role: "assistant", content: parts, timestamp: 0 } as unknown as AgentMessage;
}

function toolResult(text: string): AgentMessage {
  return { role: "toolResult", toolName: "bash", toolCallId: "t1", content: [{ type: "text", text }], isError: false, timestamp: 0 } as unknown as AgentMessage;
}

test("pass: collapses thinking AND text blocks of assistant messages", () => {
  const msgs = [
    user("go"),
    assistant([
      { type: "thinking", thinking: "let me think " + "【".repeat(4655) },
      { type: "text", text: "done " + "=".repeat(300) },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ]),
    toolResult("ok"),
  ];
  const { messages, evidence } = collapseAssistantDegeneration(msgs);
  assert.notEqual(messages, msgs, "returns a new array when changed");
  const a = messages[1] as { content: Array<{ type?: string; thinking?: string; text?: string }> };
  assert.ok(a.content[0]!.thinking!.includes("[4655× identical chars cut — degenerate repeat]"));
  assert.ok(!a.content[0]!.thinking!.includes("【".repeat(4)));
  assert.ok(a.content[1]!.text!.includes("[300× identical chars cut — degenerate repeat]"));
  assert.deepEqual(evidence, [{ msgIndex: 1, blocks: ["thinking", "text"], runs: [{ char: "【", count: 4655, index: 13 }, { char: "=", count: 300, index: 5 }] }]);
});

test("pass: toolCall arguments are never touched", () => {
  const argText = "x".repeat(500);
  const msgs = [assistant([{ type: "toolCall", id: "t1", name: "write", arguments: { content: argText } }])];
  const { messages, evidence } = collapseAssistantDegeneration(msgs);
  assert.equal(messages, msgs, "no change → same reference");
  assert.deepEqual(evidence, []);
});

test("pass: non-assistant roles untouched even with huge runs", () => {
  const msgs = [user("-".repeat(5000)), toolResult("=".repeat(5000))];
  const { messages, evidence } = collapseAssistantDegeneration(msgs);
  assert.equal(messages, msgs);
  assert.deepEqual(evidence, []);
});

test("pass: string content form is collapsed too", () => {
  const msgs = [{ role: "assistant", content: "y".repeat(300), timestamp: 0 } as unknown as AgentMessage];
  const { messages } = collapseAssistantDegeneration(msgs);
  const c = (messages[0] as { content: unknown }).content;
  assert.equal(typeof c, "string");
  assert.ok((c as string).includes("[300× identical chars cut — degenerate repeat]"));
});

test("pass: below-threshold drift (≤199) is left alone", () => {
  const msgs = [assistant([{ type: "thinking", thinking: "【".repeat(199) }])];
  const { messages } = collapseAssistantDegeneration(msgs);
  assert.equal(messages, msgs);
});

test("pass: disabled via boolean shorthand or enabled:false", () => {
  const msgs = [assistant([{ type: "thinking", thinking: "【".repeat(4655) }])];
  assert.equal(collapseAssistantDegeneration(msgs, false).messages, msgs);
  assert.equal(collapseAssistantDegeneration(msgs, { enabled: false }).messages, msgs);
});

test("pass: fail-safe on malformed messages (never throws)", () => {
  const junk = [null, { role: "assistant" }, { role: "assistant", content: null }, { role: "assistant", content: "ok" }, 42, "str"] as unknown as AgentMessage[];
  const { messages, evidence } = collapseAssistantDegeneration(junk);
  assert.equal(messages, junk);
  assert.deepEqual(evidence, []);
});

// ---------- lastAssistantRuns ----------

test("tail: finds the LAST assistant message only (not earlier ones)", () => {
  const msgs = [
    assistant([{ type: "thinking", thinking: "【".repeat(4655) }]),
    assistant([{ type: "text", text: "clean" }]),
  ];
  assert.equal(lastAssistantRuns(msgs, 200), null, "earlier degen must not fire the notice once a newer turn exists");
});

test("tail: fires while the degenerated turn is the most recent assistant turn", () => {
  const msgs = [
    user("task"),
    assistant([{ type: "thinking", thinking: "【".repeat(4655) }]),
  ];
  const runs = lastAssistantRuns(msgs, 200);
  assert.ok(runs && runs.length === 1 && runs[0]!.count === 4655);
});

test("tail: fires even when a fresh user message follows the degenerated turn", () => {
  const msgs = [
    assistant([{ type: "thinking", thinking: "【".repeat(4655) }]),
    user("continue please"),
  ];
  assert.ok(lastAssistantRuns(msgs, 200), "the model's previous turn was degenerated — notice belongs on its next attempt");
  assert.equal(lastAssistantRuns([user("only users")], 200), null);
  assert.equal(lastAssistantRuns([], 200), null);
});

// ---------- degenerationNotice ----------

test("notice: user-role message names count and char, carries no raw run", () => {
  const msg = degenerationNotice([{ char: "【", count: 4655, index: 0 }]) as { role: string; content: Array<{ type: string; text: string }> };
  assert.equal(msg.role, "user");
  const text = msg.content[0]!.text;
  assert.ok(text.startsWith("[ACP recovery notice]"));
  assert.ok(text.includes("4655 consecutive repetitions of \"【\""));
  assert.ok(text.includes("Resume your task from your last valid step."));
  assert.ok(!text.includes("【".repeat(4)), "the notice itself must not carry a repeat run");
});

test("notice: multiple runs are summarized, largest first", () => {
  const msg = degenerationNotice([
    { char: "a", count: 210, index: 0 },
    { char: "\n", count: 500, index: 10 },
  ]) as { content: Array<{ text: string }> };
  const text = msg.content[0]!.text;
  assert.ok(text.includes("500 consecutive repetitions of newline"));
  assert.ok(text.includes("and 1 other repeated segment(s)"));
});

// ---------- wiring: context transform end-to-end ----------

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
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

async function makeCtx(entries: any[], sessionId: string) {
  const dir = await mkdtemp(join(tmpdir(), "acp-degen-test-"));
  const stateFile = join(dir, `${sessionId}.session.json`);
  return {
    dir,
    ctx: {
      mode: "rpc",
      hasUI: false,
      ui: { notify: () => {} },
      model: { contextWindow: 200_000 },
      sessionManager: {
        // buildContextEntries marks this as a pi host (isPiHost), so the
        // handler reads entries from the branch and ignores event.messages —
        // exactly how real pi behaves. Without it the OMP merge path would
        // fold event.messages into the view and corrupt the assertions.
        buildContextEntries: () => entries,
        getBranch: () => entries,
        getSessionId: () => sessionId,
        getSessionFile: () => stateFile,
      },
    },
  };
}

function entry(id: string, message: Record<string, unknown>) {
  return { type: "message", id, parentId: null, timestamp: "", message: { ...message, timestamp: Date.now() } };
}

function textsOf(m: any): string[] {
  const c = m.content;
  const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
  return blocks.filter((b: any) => b.type === "text").map((b: any) => b.text);
}

test("wire: degenerate thinking in the outgoing view is collapsed + recovery notice appended", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const entries = [
    entry("e1", { role: "user", content: "do the task" }),
    entry("e2", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "analyzing " + "【".repeat(4655) },
        { type: "text", text: "working on it" },
      ],
    }),
  ];
  const { dir, ctx } = await makeCtx(entries, "sess-wire-1");
  try {
    const result = await handlers.get("context")![0]!({ type: "context", messages: entries.map(() => ({ role: "user", content: "x", timestamp: 0 })) }, ctx);
    const out = result.messages as any[];
    const asst = out.find((m) => m.role === "assistant");
    assert.ok(asst, "assistant message must survive in the sent view");
    const thinking = asst.content.find((b: any) => b.type === "thinking");
    assert.ok(thinking, "thinking block present");
    assert.ok(thinking.thinking.includes("[4655× identical chars cut — degenerate repeat]"), "run collapsed in outgoing view");
    assert.ok(!thinking.thinking.includes("【".repeat(4)), "no long run reaches the wire");
    const notice = out[out.length - 1];
    assert.equal(notice.role, "user");
    assert.ok(textsOf(notice).some((t) => t.includes("[ACP recovery notice]")), "recovery notice appended last");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wire: thinking-only aborted turn (dropped from sent view) still triggers the notice", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const entries = [
    entry("e1", { role: "user", content: "do the task" }),
    entry("e2", { role: "assistant", content: [{ type: "thinking", thinking: "【".repeat(4655) }] }),
    entry("e3", { role: "user", content: "continue" }),
  ];
  const { dir, ctx } = await makeCtx(entries, "sess-wire-2");
  try {
    const result = await handlers.get("context")![0]!({ type: "context", messages: entries.map(() => ({ role: "user", content: "x", timestamp: 0 })) }, ctx);
    const out = result.messages as any[];
    // The thinking-only turn is dropped upstream (projectMessage) — nothing
    // degenerate rides along on the wire...
    assert.ok(out.every((m) => !JSON.stringify(m).includes("【".repeat(4))), "no raw run anywhere in the sent view");
    // ...but the notice still fires: the model's previous turn WAS degenerated.
    const notice = out[out.length - 1];
    assert.ok(textsOf(notice).some((t) => t.includes("[ACP recovery notice]")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wire: once a clean assistant turn exists, the notice stops appearing", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const entries = [
    entry("e1", { role: "user", content: "do the task" }),
    entry("e2", { role: "assistant", content: [{ type: "thinking", thinking: "【".repeat(4655) }] }),
    entry("e3", { role: "user", content: "continue" }),
    entry("e4", { role: "assistant", content: [{ type: "text", text: "back to work" }] }),
  ];
  const { dir, ctx } = await makeCtx(entries, "sess-wire-3");
  try {
    const result = await handlers.get("context")![0]!({ type: "context", messages: entries.map(() => ({ role: "user", content: "x", timestamp: 0 })) }, ctx);
    const out = result.messages as any[];
    assert.ok(out.every((m) => !textsOf(m).some((t) => t.includes("[ACP recovery notice]"))), "self-limiting: no notice after a fresh turn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wire: degenerationGuard:false kills both the collapse and the notice", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, degenerationGuard: false })(api as unknown as ExtensionAPI);
  const entries = [
    entry("e1", { role: "user", content: "do the task" }),
    entry("e2", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "【".repeat(4655) },
        { type: "text", text: "working" },
      ],
    }),
  ];
  const { dir, ctx } = await makeCtx(entries, "sess-wire-4");
  try {
    const result = await handlers.get("context")![0]!({ type: "context", messages: entries.map(() => ({ role: "user", content: "x", timestamp: 0 })) }, ctx);
    const out = result.messages as any[];
    const asst = out.find((m) => m.role === "assistant");
    const thinking = asst.content.find((b: any) => b.type === "thinking");
    assert.ok(thinking.thinking.includes("【".repeat(4)), "kill-switch: raw run passes through unmodified");
    assert.ok(out.every((m) => !textsOf(m).some((t) => t.includes("[ACP recovery notice]"))), "kill-switch: no notice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wire: custom minRun above the run length disables collapsing", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, degenerationGuard: { minRun: 5000 } })(api as unknown as ExtensionAPI);
  const entries = [
    entry("e1", { role: "user", content: "do the task" }),
    entry("e2", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "【".repeat(4655) },
        { type: "text", text: "working" },
      ],
    }),
  ];
  const { dir, ctx } = await makeCtx(entries, "sess-wire-5");
  try {
    const result = await handlers.get("context")![0]!({ type: "context", messages: entries.map(() => ({ role: "user", content: "x", timestamp: 0 })) }, ctx);
    const out = result.messages as any[];
    const asst = out.find((m) => m.role === "assistant");
    const thinking = asst.content.find((b: any) => b.type === "thinking");
    assert.ok(thinking.thinking.includes("【".repeat(4)), "4655 < minRun 5000 → untouched");
    assert.ok(out.every((m) => !textsOf(m).some((t) => t.includes("[ACP recovery notice]"))), "no notice under the threshold");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
