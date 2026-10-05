import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { isCompressSuccessText } from "../src/compress-tool.js";

// #433: acp_rule record tool — opt-in (`rules: true`), plain add/list surface,
// zero system-prompt footprint, hard-protected from compression by the kernel.

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
    registerShortcut(_key: any, _opts: any) {},
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function ruleCall(id: string, args: Record<string, unknown>) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", name: "acp_rule", id: "call1", arguments: args }], timestamp: Date.now() } };
}

function ruleResult(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: "call1", toolName: "acp_rule", content: [{ type: "text", text }], isError: false, timestamp: Date.now() } };
}

interface BootOpts {
  dir: string;
  sessionId: string;
  entries?: any[];
  adapter?: Record<string, unknown>;
}

async function boot({ dir, sessionId, entries = [], adapter }: BootOpts) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false, ...adapter })(api as any);
  const stateFile = join(dir, "session.json");
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: dir,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => stateFile,
    },
  };
  await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
  return { api, handlers, ctx, stateFile };
}

async function execRule(api: any, ctx: any, params: Record<string, unknown>): Promise<string> {
  const tool = api.tools.find((t: any) => t.name === "acp_rule");
  assert.ok(tool, "acp_rule is registered");
  const out = await tool.execute("tc-rule", params, undefined, undefined, ctx);
  return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
}

async function runContext(handlers: Map<string, any[]>, ctx: any) {
  return handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

test("default off: no acp_rule tool after session_start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-off-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api } = await boot({ dir, sessionId: "sess-off" });
    assert.ok(api.tools.some((t: any) => t.name === "compress"), "always-on tools still registered");
    assert.ok(!api.tools.some((t: any) => t.name === "acp_rule"), "acp_rule absent by default");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("rules:true registers acp_rule with zero system-prompt surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-reg-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api } = await boot({ dir, sessionId: "sess-reg", adapter: { rules: true } });
    const tool = api.tools.find((t: any) => t.name === "acp_rule");
    assert.ok(tool, "registered when rules:true");
    assert.equal(tool.label, "ACP Rule");
    assert.equal(tool.promptSnippet, undefined, "no promptSnippet (zero system-prompt changes)");
    assert.equal(tool.promptGuidelines, undefined, "no promptGuidelines (zero system-prompt changes)");
    assert.match(tool.description, /Omit the rule argument to list/, "usage guidance lives in the description");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("add records and echoes; omitting the argument lists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-add-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api, ctx } = await boot({ dir, sessionId: "sess-add", adapter: { rules: true } });
    assert.equal(await execRule(api, ctx, { rule: "always run the test suite before committing" }), "Recorded rule1: always run the test suite before committing");
    assert.equal(await execRule(api, ctx, { rule: "keep diffs minimal" }), "Recorded rule2: keep diffs minimal");
    assert.equal(
      await execRule(api, ctx, {}),
      "1. [rule1] always run the test suite before committing\n2. [rule2] keep diffs minimal",
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("listing an empty state says No rules recorded.", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-empty-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api, ctx } = await boot({ dir, sessionId: "sess-empty", adapter: { rules: true } });
    assert.equal(await execRule(api, ctx, {}), "No rules recorded.");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("kernel validation errors come back verbatim (informative, not thrown)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-err-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api, ctx } = await boot({ dir, sessionId: "sess-err", adapter: { rules: true } });
    // #555: an empty/blank rule argument is a no-op, not a validation error —
    // aligned with billion-context executeRule, where it falls through to list.
    assert.equal(await execRule(api, ctx, { rule: "" }), "No rules recorded.");
    assert.equal(await execRule(api, ctx, { rule: "   " }), "No rules recorded.");
    assert.match(await execRule(api, ctx, { rule: "x".repeat(301) }), /exceeds the 300-char limit/);
    assert.equal(await execRule(api, ctx, { rule: "first" }), "Recorded rule1: first");
    assert.match(await execRule(api, ctx, { rule: "first" }), /identical rule already exists \(rule1\)/);
    for (let i = 2; i <= 50; i++) {
      assert.match(await execRule(api, ctx, { rule: `filler ${i}` }), /^Recorded rule\d+:/);
    }
    assert.match(await execRule(api, ctx, { rule: "one too many" }), /rule limit reached \(50\)/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("delete removes one rule by id and echoes like the command/bili path (#555)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-del-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api, ctx } = await boot({ dir, sessionId: "sess-del", adapter: { rules: true } });
    assert.equal(await execRule(api, ctx, { rule: "prefer pnpm" }), "Recorded rule1: prefer pnpm");
    assert.equal(await execRule(api, ctx, { rule: "always typecheck" }), "Recorded rule2: always typecheck");
    assert.equal(await execRule(api, ctx, { delete: "rule1" }), "Removed rule1: prefer pnpm");
    assert.equal(await execRule(api, ctx, {}), "1. [rule2] always typecheck", "list reflects the removal");
    const sidecar = JSON.parse(await readFile(`${join(dir, "session.json")}.acp.json`, "utf8")) as { rules?: unknown[] };
    assert.deepEqual(sidecar.rules, [{ id: "rule2", text: "always typecheck" }], "removal persisted to the sidecar");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("delete with an unknown id returns the kernel error verbatim without mutating (#555)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-delmiss-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api, ctx } = await boot({ dir, sessionId: "sess-delmiss", adapter: { rules: true } });
    assert.equal(await execRule(api, ctx, { rule: "keep types strict" }), "Recorded rule1: keep types strict");
    assert.equal(
      await execRule(api, ctx, { delete: "rule99" }),
      'no rule with id "rule99" — list current rules first (omit the text argument).',
      "kernel error passed through verbatim, not thrown or marked FAILED",
    );
    assert.match(await execRule(api, ctx, { delete: "not-an-id" }), /^no rule with id "not-an-id"/);
    assert.equal(await execRule(api, ctx, {}), "1. [rule1] keep types strict", "existing rule untouched by the failed removal");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("clear removes all rules and reports the count; empty clear is honest (#555)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-clear-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api, ctx } = await boot({ dir, sessionId: "sess-clear", adapter: { rules: true } });
    assert.equal(await execRule(api, ctx, { rule: "prefer pnpm" }), "Recorded rule1: prefer pnpm");
    assert.equal(await execRule(api, ctx, { rule: "always typecheck" }), "Recorded rule2: always typecheck");
    assert.equal(await execRule(api, ctx, { clear: true }), "Cleared 2 rule(s).");
    const sidecar = JSON.parse(await readFile(`${join(dir, "session.json")}.acp.json`, "utf8")) as { rules?: unknown[] };
    assert.deepEqual(sidecar.rules, [], "sidecar emptied after clear");
    assert.equal(await execRule(api, ctx, { clear: true }), "No rules to clear.", "honest empty clear, no false success");
    assert.equal(await execRule(api, ctx, {}), "No rules recorded.");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("mixed operations are rejected without executing or recording (#555)", async () => {
  const ONE_OP = "Use one operation per call: record (rule), remove one (delete), remove all (clear: true), or list (no arguments).";
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-conflict-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api, ctx } = await boot({ dir, sessionId: "sess-conflict", adapter: { rules: true } });
    assert.equal(await execRule(api, ctx, { rule: "prefer pnpm" }), "Recorded rule1: prefer pnpm");
    assert.equal(await execRule(api, ctx, { rule: "always typecheck" }), "Recorded rule2: always typecheck");
    assert.equal(await execRule(api, ctx, { rule: "new rule", delete: "rule1" }), ONE_OP);
    assert.equal(await execRule(api, ctx, { rule: "new rule", clear: true }), ONE_OP);
    assert.equal(await execRule(api, ctx, { delete: "rule1", clear: true }), ONE_OP);
    assert.equal(
      await execRule(api, ctx, {}),
      "1. [rule1] prefer pnpm\n2. [rule2] always typecheck",
      "state unmutated after rejected mixed calls",
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("parameter schema mirrors the cross-host shape: rule/delete/clear (#555)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-schema-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { api } = await boot({ dir, sessionId: "sess-schema", adapter: { rules: true } });
    const tool = api.tools.find((t: any) => t.name === "acp_rule");
    const props = tool.parameters.properties as Record<string, any>;
    assert.deepEqual(Object.keys(props).sort(), ["clear", "delete", "rule"], "same param names as billion-context's RULE_PARAM_SCHEMA");
    assert.equal(props.rule.type, "string");
    assert.equal(props.delete.type, "string");
    assert.equal(props.clear.type, "boolean");
    assert.match(tool.description, /use one operation per call/, "description teaches the exclusivity contract");
    assert.match(tool.description, /pass delete with its id/, "description teaches when/how to delete");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("rules persist in the .acp.json sidecar and survive a runtime restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-persist-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const a = await boot({ dir, sessionId: "sess-persist", adapter: { rules: true } });
    assert.equal(await execRule(a.api, a.ctx, { rule: "pin dependencies to exact versions" }), "Recorded rule1: pin dependencies to exact versions");
    const sidecar = JSON.parse(await readFile(`${a.stateFile}.acp.json`, "utf8"));
    assert.equal(sidecar.rules[0].id, "rule1");
    assert.equal(sidecar.rules[0].text, "pin dependencies to exact versions");
    const b = await boot({ dir, sessionId: "sess-persist", adapter: { rules: true } });
    assert.equal(await execRule(b.api, b.ctx, {}), "1. [rule1] pin dependencies to exact versions");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("acp_rule call+result survive a compress covering them (hard protection)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-rule-protect-"));
  const home = await mkdtemp(join(tmpdir(), "acp-rule-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Fixture shaped by three kernel render rules: the first user message is
    // pinned (rebuildMessages firstUserIndex), the last 5 messages form the
    // recent zone, and compress rejects <5000 compressible chars per range.
    // The acp_rule pair sits BETWEEN those zones so its survival can only come
    // from ALWAYS_PROTECTED_TOOLS, not from recency.
    const big = "中".repeat(2000);
    const oldBulk = "老".repeat(6000);
    const recentBulk = "新".repeat(2000);
    const entries = [
      userMsg("u0", "start the task"),
      ruleCall("a1", { rule: "always run tests" }),
      ruleResult("t1", "Recorded rule1: always run tests"),
      userMsg("o1", oldBulk),
      userMsg("o2", recentBulk),
      userMsg("e1", big),
      userMsg("e2", big),
      userMsg("e3", big),
      userMsg("e4", big),
    ];
    const { api, handlers, ctx } = await boot({ dir, sessionId: "sess-protect", entries, adapter: { rules: true } });
    await runContext(handlers, ctx);
    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const out = await compressTool.execute(
      "tc-c",
      { content: [{ startId: "m00002", endId: "m00005", summary: "older filler exchange around a recorded rule, nothing else worth keeping" }] },
      undefined, undefined, ctx,
    );
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.ok(isCompressSuccessText(text), `compress failed: ${text}`);
    const turned = await runContext(handlers, ctx);
    const sent = JSON.stringify(turned ?? {});
    assert.ok(sent.includes("call1"), "protected tool-result survives compression");
    assert.ok(sent.includes("always run tests"), "rule payload stays visible");
    assert.ok(!sent.includes(oldBulk), "unprotected older bulk was compressed away");
    assert.ok(sent.includes(recentBulk), "recent-zone message stays untouched");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
