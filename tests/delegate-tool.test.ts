import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildArgs, delegateSpawnOptions, injectedWaitMessage, buildWaitResult, buildCancelResult, getDelegateUsage, resetDelegateUsage, injectResult, effectiveExitCode, formatRunResult, resolveWaitTimeoutMs, findUndeliveredRuns, undeliveredNoticeFrom, buildRecoveryNotice, makeDelegateTool, exitLabel, cancelledFileNote, delegateStdinText, readActivityTail, scheduleRunNotification, flushDelegateNotifications, formatBatchRunSection, setDelegatePolicy, delegateChildEnv, asyncWatchdogDescription, ConcurrencyGate, setDelegateDefaults, resetDelegateDefaults, isValidThinkingLevel } from "../src/delegate-tool.js";
import { DEFAULT_DELEGATE_POLICY } from "../src/config.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Minimal ctx mock - buildChildArgs reads ctx.model and sessionManager. */
function mockCtx(host: "pi" | "omp" = "pi"): ExtensionContext {
  const sessionManager =
    host === "pi"
      ? { buildContextEntries: () => [] }
      : { getBranch: () => [] };
  return { model: { provider: "test", id: "test-model" }, sessionManager } as unknown as ExtensionContext;
}

const RESTRICTED_ROLES = ["reviewer", "researcher", "planner", "oracle"] as const;
const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status"];

test("delegate spawn bypasses the shell for Windows executable paths", () => {
  const options = delegateSpawnOptions("C:\\workspace", { TEST: "1" });
  assert.equal(options.shell, false);
  assert.equal(options.cwd, "C:\\workspace");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
});

/** Parse the --tools value from cliArgs, or null if absent. */
function getToolsValue(cliArgs: string[]): string | null {
  const idx = cliArgs.indexOf("--tools");
  if (idx < 0) return null;
  return cliArgs[idx + 1] ?? null;
}

// ─── Restricted roles: --tools present with base tools + ACP ───────────────

for (const role of RESTRICTED_ROLES) {
  test(`buildChildArgs includes --tools with ACP append for ${role}`, async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: role, task: "test task" },
      "prompt",
      mockCtx(),
      "del_test",
    );
    const toolsStr = getToolsValue(cliArgs);
    assert.ok(toolsStr, `--tools flag present for ${role}`);
    const tools = toolsStr!.split(",");

    // Base tools present
    for (const bt of ["read", "bash", "grep", "find", "ls"]) {
      assert.ok(tools.includes(bt), `${role} tools include ${bt}`);
    }
    // ACP tools present
    for (const at of ACP_TOOLS) {
      assert.ok(tools.includes(at), `${role} tools include ACP tool ${at}`);
    }
    // No edit/write
    assert.ok(!tools.includes("edit"), `${role} tools do NOT include edit`);
    assert.ok(!tools.includes("write"), `${role} tools do NOT include write`);
    // No glob (not a Pi core tool)
    assert.ok(!tools.includes("glob"), `${role} tools do NOT include glob`);
    // No duplicates
    assert.equal(tools.length, new Set(tools).size, `${role} tools have no duplicates`);
    // Expected order: base tools first, then ACP tools
    const expected = ["read", "bash", "grep", "find", "ls", ...ACP_TOOLS];
    assert.deepEqual(tools, expected, `${role} tools in expected order`);
  });
}

// ─── Worker: no --tools, full default toolset ─────────────────────────────

test("buildChildArgs omits --tools for worker role", async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: "worker", task: "fix bug" },
      "You are a worker.",
      mockCtx(),
      "del_test",
    );
  assert.equal(getToolsValue(cliArgs), null, "worker does NOT receive --tools");
});

test("buildChildArgs worker still inherits provider/model from ctx", async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: "worker", task: "fix bug" },
      "prompt",
      mockCtx(),
      "del_test",
    );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0, "worker has --provider from ctx.model");
  assert.equal(cliArgs[providerIdx + 1], "test");
  assert.ok(modelIdx >= 0, "worker has --model from ctx.model");
  assert.equal(cliArgs[modelIdx + 1], "test-model");
});

// ─── Unknown agent: no --tools ─────────────────────────────────────────────

test("buildChildArgs omits --tools for unknown agent name", async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: "nonexistent-role", task: "test" },
      "prompt",
      mockCtx(),
      "del_test",
    );
  assert.equal(getToolsValue(cliArgs), null, "--tools not added for unknown agent");
});

// ─── --tools comes before --provider/--model ───────────────────────────────

test("buildChildArgs places --tools before --provider/--model", async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: "reviewer", task: "test", model: "openai/gpt-5" },
      "prompt",
      mockCtx(),
      "del_test",
    );
  const toolsIdx = cliArgs.indexOf("--tools");
  const providerIdx = cliArgs.indexOf("--provider");
  assert.ok(toolsIdx >= 0 && providerIdx >= 0);
  assert.ok(toolsIdx < providerIdx, "--tools comes before --provider");
});

// ─── ctx.model inheritance (no explicit model) ────────────────────────────

test("buildChildArgs inherits model from ctx when model not specified", async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: "reviewer", task: "test" },
      "prompt",
      mockCtx(),
      "del_test",
    );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0, "--provider present from ctx.model");
  assert.equal(cliArgs[providerIdx + 1], "test");
  assert.ok(modelIdx >= 0, "--model present from ctx.model");
  assert.equal(cliArgs[modelIdx + 1], "test-model");
});

// ─── explicit model override ──────────────────────────────────────────────

test("buildChildArgs uses explicit model override when provided", async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: "worker", task: "test", model: "anthropic/claude-5" },
      "prompt",
      mockCtx(),
      "del_test",
    );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0);
  assert.equal(cliArgs[providerIdx + 1], "anthropic");
  assert.ok(modelIdx >= 0);
  assert.equal(cliArgs[modelIdx + 1], "claude-5");
});

// ─── per-role model + thinking level (issue #117) ─────────────────────────

function flagVal(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx >= 0 ? (args[idx + 1] ?? null) : null;
}

/** ctx mock with a live modelRegistry whose find() knows `knownModels`. */
function ctxWithRegistry(
  model: { provider: string; id: string } | undefined,
  knownModels: string[] = [],
): ExtensionContext {
  const registry = {
    find: (p: string, mid: string) =>
      knownModels.includes(`${p}/${mid}`) ? { provider: p, id: mid } : undefined,
  };
  return {
    model,
    sessionManager: { buildContextEntries: () => [] },
    modelRegistry: registry,
  } as unknown as ExtensionContext;
}

test("buildChildArgs model: per-call overrides role config", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ agents: { worker: { model: "rolecfg/role-model" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t", model: "call/call-model" },
    "prompt", ctxWithRegistry({ provider: "parent", id: "parent-model" }, ["rolecfg/role-model"]), "del_m1",
  );
  assert.equal(flagVal(cliArgs, "--provider"), "call");
  assert.equal(flagVal(cliArgs, "--model"), "call-model");
});

test("buildChildArgs model: role config used when no per-call model", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ agents: { reviewer: { model: "openai/gpt-5" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "reviewer", task: "t" },
    "prompt", ctxWithRegistry({ provider: "parent", id: "parent-model" }, ["openai/gpt-5"]), "del_m2",
  );
  assert.equal(flagVal(cliArgs, "--provider"), "openai");
  assert.equal(flagVal(cliArgs, "--model"), "gpt-5");
});

test("buildChildArgs model: inherits parent when neither per-call nor role config", async () => {
  resetDelegateDefaults();
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t" },
    "prompt", ctxWithRegistry({ provider: "parent", id: "parent-model" }), "del_m3",
  );
  assert.equal(flagVal(cliArgs, "--provider"), "parent");
  assert.equal(flagVal(cliArgs, "--model"), "parent-model");
});

test("buildChildArgs model: missing role model falls back to parent (never fails)", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ agents: { oracle: { model: "ghost/nonexistent" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "oracle", task: "t" },
    "prompt", ctxWithRegistry({ provider: "parent", id: "parent-model" }), "del_m4",
  );
  assert.equal(flagVal(cliArgs, "--provider"), "parent");
  assert.equal(flagVal(cliArgs, "--model"), "parent-model");
});

test("buildChildArgs model: malformed role model (no slash) ignored -> inherit parent", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ agents: { planner: { model: "just-a-name" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "planner", task: "t" },
    "prompt", ctxWithRegistry({ provider: "parent", id: "parent-model" }), "del_m5",
  );
  assert.equal(flagVal(cliArgs, "--provider"), "parent");
  assert.equal(flagVal(cliArgs, "--model"), "parent-model");
});

test("buildChildArgs model: slash in model id splits on first slash only", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ agents: { researcher: { model: "prov/a/b" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "researcher", task: "t" },
    "prompt", ctxWithRegistry({ provider: "parent", id: "parent-model" }, ["prov/a/b"]), "del_m6",
  );
  assert.equal(flagVal(cliArgs, "--provider"), "prov");
  assert.equal(flagVal(cliArgs, "--model"), "a/b");
});

test("buildChildArgs thinking: per-call wins over role and global", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ thinkingLevel: "low", agents: { worker: { thinkingLevel: "medium" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t", thinkingLevel: "high" },
    "prompt", ctxWithRegistry({ provider: "p", id: "m" }), "del_t1",
  );
  assert.equal(flagVal(cliArgs, "--thinking"), "high");
});

test("buildChildArgs thinking: role level wins over global", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ thinkingLevel: "low", agents: { worker: { thinkingLevel: "medium" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t" },
    "prompt", ctxWithRegistry({ provider: "p", id: "m" }), "del_t2",
  );
  assert.equal(flagVal(cliArgs, "--thinking"), "medium");
});

test("buildChildArgs thinking: global used when no per-call or role level", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ thinkingLevel: "xhigh" });
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t" },
    "prompt", ctxWithRegistry({ provider: "p", id: "m" }), "del_t3",
  );
  assert.equal(flagVal(cliArgs, "--thinking"), "xhigh");
});

test("buildChildArgs thinking: no flag when nothing configured (Pi default preserved)", async () => {
  resetDelegateDefaults();
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t" },
    "prompt", ctxWithRegistry({ provider: "p", id: "m" }), "del_t4",
  );
  assert.equal(flagVal(cliArgs, "--thinking"), null);
});

test("buildChildArgs thinking: invalid value dropped without cascading to global", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ thinkingLevel: "low", agents: { worker: { thinkingLevel: "bogus" } } });
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t" },
    "prompt", ctxWithRegistry({ provider: "p", id: "m" }), "del_t5",
  );
  assert.equal(flagVal(cliArgs, "--thinking"), null);
});

test("buildChildArgs thinking: invalid per-call dropped even if global is valid", async () => {
  resetDelegateDefaults();
  setDelegateDefaults({ thinkingLevel: "low" });
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "t", thinkingLevel: "not-a-level" },
    "prompt", ctxWithRegistry({ provider: "p", id: "m" }), "del_t6",
  );
  assert.equal(flagVal(cliArgs, "--thinking"), null);
});

for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
  test(`isValidThinkingLevel accepts ${lvl}`, () => {
    assert.equal(isValidThinkingLevel(lvl), true);
  });
}

test("isValidThinkingLevel rejects invalid values", () => {
  assert.equal(isValidThinkingLevel("bogus"), false);
  assert.equal(isValidThinkingLevel("HIGH"), false);
  assert.equal(isValidThinkingLevel(""), false);
  assert.equal(isValidThinkingLevel(undefined), false);
});

// ─── wait() dedup: already-injected run returns "already delivered" ───────
// Race scenario: the delegate finishes quickly, the close handler injects the
// result as a system notification, and THEN the model calls acp_delegate_wait.
// Without dedup the model sees the same result twice (notification + tool
// result). injectedWaitMessage is the pure helper that short-circuits this.

test("injectedWaitMessage returns null when run was NOT injected", () => {
  assert.equal(injectedWaitMessage({ injected: false }, "del_x", ""), null);
  assert.equal(injectedWaitMessage({}, "del_x", ""), null);
});

test("injectedWaitMessage dedup message names the runId and the result file", () => {
  const msg = injectedWaitMessage(
    { injected: true, result: { file: "/tmp/acp-delegate/del_x.out" } },
    "del_x",
    "",
  );
  assert.ok(msg, "returns a message for an injected run");
  assert.ok(msg!.includes("del_x"), "names the runId");
  assert.ok(msg!.includes("/tmp/acp-delegate/del_x.out"), "points at the result file");
  assert.ok(msg!.includes("already delivered"), "states it was already delivered");
  assert.ok(msg!.includes("no need to wait"), "tells the model not to wait again");
});

test("injectedWaitMessage surfaces remaining delegates and tolerates a missing file", () => {
  const msg = injectedWaitMessage(
    { injected: true, result: {} },
    "del_x",
    " 2 delegates are still running.",
  );
  assert.ok(msg!.includes("2 delegates are still running"), "passes through the remaining line");
  assert.ok(!msg!.includes("read the result file"), "omits the file line when file is absent");
});

// ─── host detection: --mode json (pi) vs -p fallback (omp) ──────────────────

test("buildChildArgs uses --mode json on pi for async delegates", async () => {
  const { cliArgs, isAsync, useJsonStream } = await buildChildArgs(
    { agent: "worker", task: "test" },
    "prompt",
    mockCtx("pi"),
    "del_test",
  );
  assert.equal(isAsync, true);
  assert.equal(useJsonStream, true);
  assert.deepEqual(cliArgs.slice(0, 2), ["--mode", "json"]);
});

test("buildChildArgs falls back to -p on omp for async delegates", async () => {
  const { cliArgs, isAsync, useJsonStream } = await buildChildArgs(
    { agent: "worker", task: "test" },
    "prompt",
    mockCtx("omp"),
    "del_test",
  );
  assert.equal(isAsync, true);
  assert.equal(useJsonStream, false);
  assert.equal(cliArgs[0], "-p");
});

test("buildChildArgs keeps -p for sync delegates even on pi", async () => {
  const ctx = mockCtx("pi") as ExtensionContext & { mode: string };
  ctx.mode = "print";
  const { cliArgs, isAsync, useJsonStream } = await buildChildArgs(
    { agent: "worker", task: "test" },
    "prompt",
    ctx,
    "del_test",
  );
  assert.equal(isAsync, false);
  assert.equal(useJsonStream, false);
  assert.equal(cliArgs[0], "-p");
});

test("buildWaitResult returns usage in merged mode", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test", usage: { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } } };
  const result = buildWaitResult(run as any, "content", "merged");
  assert.ok(result.usage, "usage is present in merged mode");
  assert.equal(result.usage!.input, 150);
  assert.equal(run.usageReported, true, "sets usageReported");
});

test("buildWaitResult accumulates usage in separate mode (default)", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test", usage: { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } } };
  const result = buildWaitResult(run as any, "content");
  assert.equal(result.usage, undefined, "usage not returned in separate mode");
  assert.equal(run.usageReported, true, "sets usageReported");
  const total = getDelegateUsage();
  assert.ok(total, "delegate usage accumulated");
  assert.equal(total!.input, 150);
  assert.equal(total!.output, 80);
});

test("buildWaitResult returns plain result when usage already reported", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test", usage: { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } }, usageReported: true };
  const result = buildWaitResult(run as any, "content");
  assert.equal(result.usage, undefined, "usage omitted on second call");
  assert.equal(getDelegateUsage(), undefined, "no accumulation when already reported");
});

test("buildWaitResult returns plain result when no usage", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test" };
  const result = buildWaitResult(run as any, "content");
  assert.equal(result.usage, undefined, "usage omitted when absent");
  assert.equal(getDelegateUsage(), undefined, "no accumulation when no usage");
});

test("buildCancelResult returns usage in merged mode", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test", usage: { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } } };
  const result = buildCancelResult(run as any, "content", "merged");
  assert.ok(result.usage, "usage is present in merged mode");
  assert.equal(result.usage!.input, 150);
  assert.equal(run.usageReported, true, "sets usageReported");
});

test("buildCancelResult accumulates usage in separate mode", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test", usage: { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } } };
  const result = buildCancelResult(run as any, "content");
  assert.equal(result.usage, undefined, "usage not returned in separate mode");
  assert.equal(run.usageReported, true, "sets usageReported");
  const total = getDelegateUsage();
  assert.ok(total, "delegate usage accumulated");
  assert.equal(total!.input, 150);
});

test("buildCancelResult returns plain result when no usage", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test" };
  const result = buildCancelResult(run as any, "content");
  assert.equal(result.usage, undefined, "usage omitted when absent");
  assert.equal(getDelegateUsage(), undefined, "no accumulation when no usage");
});

// ─── injectResult usage accumulation ───────────────────────────────────────

const USAGE_FIXTURE = { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } };

test("injectResult accumulates usage in separate mode when unreported", () => {
  resetDelegateUsage();
  const pi = { sendUserMessage: () => {} };
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", "completed", 0, "/tmp/del_x.out", undefined, USAGE_FIXTURE, "separate", false);
  assert.equal(ok, true, "injection succeeds");
  const total = getDelegateUsage();
  assert.ok(total, "usage accumulated into session total");
  assert.equal(total!.input, 150);
  assert.equal(total!.output, 80);
});

test("injectResult does not double-accumulate when usage already reported", () => {
  resetDelegateUsage();
  const pi = { sendUserMessage: () => {} };
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", "completed", 0, "/tmp/del_x.out", undefined, USAGE_FIXTURE, "separate", true);
  assert.equal(ok, true, "injection succeeds");
  assert.equal(getDelegateUsage(), undefined, "no accumulation when already reported");
});

test("injectResult merged mode injects without accumulating", () => {
  resetDelegateUsage();
  const pi = { sendUserMessage: () => {} };
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", "completed", 0, "/tmp/del_x.out", undefined, USAGE_FIXTURE, "merged", false);
  assert.equal(ok, true, "injection succeeds");
  assert.equal(getDelegateUsage(), undefined, "merged mode never accumulates");
});

test("injectResult without usage leaves cumulative total undefined", () => {
  resetDelegateUsage();
  const pi = { sendUserMessage: () => {} };
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", "completed", 0, "/tmp/del_x.out", undefined, undefined, "separate", false);
  assert.equal(ok, true, "injection succeeds");
  assert.equal(getDelegateUsage(), undefined, "no usage, no accumulation");
});

test("injectResult returns false when sendUserMessage unavailable", () => {
  const ok = injectResult({} as any, "reviewer", "del_x", "test", "completed", 0, "/tmp/del_x.out");
  assert.equal(ok, false, "no sendUserMessage means no injection");
});

test("buildWaitResult merged mode does not accumulate delegateUsageTotal", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test", usage: USAGE_FIXTURE };
  const result = buildWaitResult(run as any, "content", "merged");
  assert.ok(result.usage, "usage present in merged mode");
  assert.equal(getDelegateUsage(), undefined, "merged mode never accumulates");
});

// ─── resolveWaitTimeoutMs: small values treated as seconds (ISSUE-1) ──────

test("resolveWaitTimeoutMs returns the default when undefined", () => {
  assert.equal(resolveWaitTimeoutMs(undefined), 10_000);
});

test("resolveWaitTimeoutMs rescales sub-1000 values as seconds", () => {
  assert.equal(resolveWaitTimeoutMs(180), 180_000);
  assert.equal(resolveWaitTimeoutMs(60), 60_000);
  assert.equal(resolveWaitTimeoutMs(1), 1_000);
});

test("resolveWaitTimeoutMs passes through values >= 1000 as ms, clamped to [1000, 300000]", () => {
  assert.equal(resolveWaitTimeoutMs(1_000), 1_000);
  assert.equal(resolveWaitTimeoutMs(45_000), 45_000);
  assert.equal(resolveWaitTimeoutMs(300_000), 300_000);
  assert.equal(resolveWaitTimeoutMs(500_000), 300_000);
});

test("resolveWaitTimeoutMs boundary: 999 → 300000 (seconds→clamp), 0/negative → 1000 floor", () => {
  // The <1000 → seconds rescale means 999 becomes 999000 then clamps to the
  // 300000 max — a sharp edge at the 999/1000 boundary, documented here.
  assert.equal(resolveWaitTimeoutMs(999), 300_000);
  assert.equal(resolveWaitTimeoutMs(0), 1_000);
  assert.equal(resolveWaitTimeoutMs(-5), 1_000);
});

// ─── failure notification visibility (#16): loud FAILED + recovery ─────────

function capturePi(sent: string[]): { sendUserMessage: (text: string) => void } {
  return { sendUserMessage: (text: string) => sent.push(text) };
}

test("injectResult failed run uses a loud FAILED header and carries the error excerpt", () => {
  const sent: string[] = [];
  const ok = injectResult(capturePi(sent) as any, "reviewer", "del_x", "review auth", "failed", 1, "/tmp/del_x.out", undefined, undefined, "separate", false, "Error: provider 429");
  assert.equal(ok, true, "injection succeeds");
  const text = sent[0]!;
  assert.ok(text.includes("[acp_delegate FAILED"), "FAILED header");
  assert.ok(text.includes("did NOT complete"), "states the result is missing");
  assert.ok(text.includes("Error: provider 429"), "carries the error excerpt");
  assert.ok(text.includes("/tmp/del_x.out"), "points at the result file");
  assert.ok(text.includes("NOT a user message"), "marked automated, not a user message");
});

test("injectResult completed run keeps the completed header and no body", () => {
  const sent: string[] = [];
  const ok = injectResult(capturePi(sent) as any, "reviewer", "del_x", "review auth", "completed", 0, "/tmp/del_x.out", undefined, undefined, "separate", false, "must not appear");
  assert.equal(ok, true, "injection succeeds");
  const text = sent[0]!;
  assert.ok(text.includes("[acp_delegate completed]"), "completed header unchanged");
  assert.ok(!text.includes("FAILED"), "no FAILED marker");
  assert.ok(!text.includes("must not appear"), "completed runs carry no body");
});

// ─── #244: watchdog null-code finalize must not misreport FAILED ───────────
// The watchdog/EOF grace kills the child (or it never exits), so close fires
// with code === null even when the .out result is complete. finalize derives
// run.status from the effective exit code; the notification must follow
// run.status, never re-derive failure from the raw null code.

test("effectiveExitCode: null code with delivered output counts as completed", () => {
  assert.equal(effectiveExitCode(null, "full report", ""), 0, "non-empty output → 0");
  assert.equal(effectiveExitCode(null, "", "stderr text"), 0, "non-empty stderr → 0");
  assert.equal(effectiveExitCode(null, "", ""), null, "no output at all → null (genuine failure)");
  assert.equal(effectiveExitCode(0, "", ""), 0, "real exit 0 untouched");
  assert.equal(effectiveExitCode(1, "partial", ""), 1, "real non-zero code untouched");
});

test("injectResult null code + completed status: completed header, exit ?, no missing-result warning", () => {
  const sent: string[] = [];
  const ok = injectResult(capturePi(sent) as any, "reviewer", "del_x", "review auth", "completed", null, "/tmp/del_x.out", "output ended but process did not exit", undefined, "separate", false);
  assert.equal(ok, true, "injection succeeds");
  const text = sent[0]!;
  assert.ok(text.includes("[acp_delegate completed]"), "completed header despite null code");
  assert.ok(text.includes("exit ?"), "raw null code kept as diagnostic");
  assert.ok(text.includes("output ended but process did not exit"), "watchdog reason kept as diagnostic");
  assert.ok(!text.includes("FAILED"), "no FAILED marker");
  assert.ok(!text.includes("did NOT complete"), "no result-missing warning");
  assert.ok(!text.includes("re-dispatch"), "no re-dispatch pressure");
});

test("injectResult null code + failed status: still a loud FAILED", () => {
  const sent: string[] = [];
  const ok = injectResult(capturePi(sent) as any, "reviewer", "del_x", "review auth", "failed", null, "/tmp/del_x.out", undefined, undefined, "separate", false, "(no output)");
  assert.equal(ok, true, "injection succeeds");
  const text = sent[0]!;
  assert.ok(text.includes("[acp_delegate FAILED"), "FAILED header for genuine failure");
  assert.ok(text.includes("exit ?"), "null code shown as ?");
  assert.ok(text.includes("did NOT complete"), "result-missing warning kept for real failures");
});

test("watchdog null-code completed run: direct, wait, and recovery paths agree", () => {
  const run = mkRun("del_w", "completed", {
    exitCode: null,
    result: { code: null, file: "/tmp/del_w.out", body: "full report" },
  });
  // direct notification path
  const sent: string[] = [];
  injectResult(capturePi(sent) as any, run.agent, run.runId, run.task, run.status, run.exitCode, run.result.file, "output ended but process did not exit", undefined, "separate", false);
  const direct = sent[0]!;
  assert.ok(direct.includes("[acp_delegate completed]"), "direct: completed");
  assert.ok(!direct.includes("FAILED"), "direct: no FAILED");
  assert.ok(!direct.includes("did NOT complete"), "direct: no missing-result warning");

  // wait path
  const waitText = formatRunResult(run);
  assert.ok(waitText.includes("completed"), "wait: completed");
  assert.ok(!waitText.includes("FAILED"), "wait: no FAILED");

  // recovery path
  const { text: recText } = buildRecoveryNotice([run], undefined);
  assert.ok(recText.includes("completed"), "recovery: completed");
  assert.ok(!recText.includes("FAILED"), "recovery: no FAILED");
  assert.ok(!recText.includes("missing"), "recovery: no missing-work warning");
});

// ─── undelivered recovery (#16) ─────────────────────────────────────────────

function mkRun(runId: string, status: "completed" | "failed" | "running", over: Record<string, unknown> = {}): any {
  return {
    runId,
    agent: "reviewer",
    task: "review X",
    cwd: "/tmp",
    startedAt: 0,
    status,
    result: { code: 1, file: `/tmp/${runId}.out`, body: "boom" },
    ...over,
  };
}

test("findUndeliveredRuns selects terminal runs never delivered to the model", () => {
  const undelivered = mkRun("del_a", "failed");
  const all = [
    undelivered,
    mkRun("del_b", "failed", { injected: true }),
    mkRun("del_c", "completed", { consumed: true }),
    mkRun("del_d", "failed", { waiter: () => {} }),
    mkRun("del_e", "running"),
    mkRun("del_self", "failed"),
  ];
  const found = findUndeliveredRuns(all, "del_self");
  assert.deepEqual(found.map((r: any) => r.runId), ["del_a"], "only del_a is undelivered");
});

test("undeliveredNoticeFrom formats a recovery notice and marks covered runs delivered", () => {
  const undelivered = mkRun("del_a", "failed");
  const text = undeliveredNoticeFrom(
    [undelivered, mkRun("del_b", "failed", { injected: true }), mkRun("del_c", "running")],
    undefined,
  );
  assert.ok(text.includes("Recovery notice"), "recovery header");
  assert.ok(text.includes("del_a"), "names the undelivered run");
  assert.ok(text.includes("FAILED"), "failed status visible");
  assert.ok(text.includes("missing"), "warns work is missing");
  assert.ok(!text.includes("del_b"), "already-injected runs excluded");
  assert.ok(!text.includes("del_c"), "running runs excluded");
  assert.equal(undelivered.injected, true, "covered run marked delivered");
  assert.equal(undeliveredNoticeFrom([]), "", "empty registry yields no notice");
});

test("buildRecoveryNotice computes without committing the delivered marking", () => {
  const undelivered = mkRun("del_a", "failed");
  const { text, covered } = buildRecoveryNotice([undelivered], undefined);
  assert.ok(text.includes("Recovery notice"), "recovery text built");
  assert.deepEqual(covered.map((r: any) => r.runId), ["del_a"], "covered run reported");
  assert.equal(undelivered.injected, undefined, "not marked before the carrier send commits");
  const empty = buildRecoveryNotice([mkRun("del_b", "completed", { injected: true })], undefined);
  assert.equal(empty.text, "", "no undelivered runs yields empty carrier");
  assert.equal(empty.covered.length, 0);
});

test("async delegate with missing cwd injects FAILED instead of crashing the host", async () => {
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const ctx = { ...mockCtx("pi"), mode: "tui", cwd: process.cwd() } as unknown as ExtensionContext;
  const res = await tool.execute(
    "tc-spawn-enoent",
    { agent: "oracle", task: "e2e", cwd: "/nonexistent-e2e-cwd", async: true },
    undefined,
    undefined,
    ctx,
  );
  const launch = (res.content[0] as { text?: string }).text ?? "";
  const runId = /`(del_[a-z0-9_]+)`/.exec(launch)?.[1];
  assert.ok(runId, `runId in launch message: ${launch}`);
  const deadline = Date.now() + 5000;
  while (!sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1, `one injected message, got ${JSON.stringify(sent)}`);
  assert.match(sent[0]!, /FAILED/);
  assert.ok(sent[0]!.includes(runId!), "injection names the failed runId");
  assert.match(sent[0]!, /spawn error/);
  // #235: spawn errors no longer delete the reply file — the error is written
  // into it so the run points at a file like any other.
  const outFile = join(tmpdir(), "acp-delegate", `${runId}.out`);
  assert.ok(existsSync(outFile), "reply file retained after spawn error");
  const outContent = await readFile(outFile, "utf8");
  assert.match(outContent, /spawn error/);
  assert.ok(sent[0]!.includes(outFile), "injection points at the retained file");
  await rm(outFile, { force: true });
});

// ─── session flags: pi persists, omp does not (#235) ────────────────────────

test("buildChildArgs pi host uses --session with a deterministic path (no --no-session)", async () => {
  const { cliArgs, sessionFile } = await buildChildArgs(
    { agent: "worker", task: "test" },
    "prompt",
    mockCtx("pi"),
    "del_sess",
  );
  assert.ok(sessionFile, "sessionFile returned");
  assert.ok(sessionFile!.endsWith("del_sess.session.jsonl"), "session file named after runId");
  const idx = cliArgs.indexOf("--session");
  assert.ok(idx >= 0, "--session present");
  assert.equal(cliArgs[idx + 1], sessionFile);
  const dirIdx = cliArgs.indexOf("--session-dir");
  assert.ok(dirIdx >= 0, "--session-dir present");
  assert.ok(!cliArgs.includes("--no-session"), "no --no-session on pi");
});

test("buildChildArgs omp host keeps --no-session and no sessionFile", async () => {
  const { cliArgs, sessionFile } = await buildChildArgs(
    { agent: "worker", task: "test" },
    "prompt",
    mockCtx("omp"),
    "del_sess",
  );
  assert.equal(sessionFile, null, "no sessionFile on omp");
  assert.ok(cliArgs.includes("--no-session"), "--no-session kept on omp");
  assert.ok(!cliArgs.includes("--session"), "no --session on omp");
});

test("buildChildArgs resumeFrom targets the new run's session file", async () => {
  const { cliArgs, sessionFile } = await buildChildArgs(
    { agent: "worker", resumeFrom: "del_orig" },
    "prompt",
    mockCtx("pi"),
    "del_new",
  );
  assert.ok(sessionFile?.endsWith("del_new.session.jsonl"), "resume targets the new run's own session file");
  const idx = cliArgs.indexOf("--session");
  assert.equal(cliArgs[idx + 1], sessionFile);
});

// ─── exit label + cancel note (#235) ────────────────────────────────────────

test("exitLabel shows the signal when the child was killed without an exit code", () => {
  assert.equal(exitLabel(0), "exit 0");
  assert.equal(exitLabel(1), "exit 1");
  assert.equal(exitLabel(null, "SIGTERM"), "exit SIGTERM");
  assert.equal(exitLabel(null, null), "exit ?");
  assert.equal(exitLabel(null), "exit ?");
});

test("cancelledFileNote points at the retained file and offers resumeFrom", () => {
  const note = cancelledFileNote("del_x", "/tmp/acp-delegate/del_x.out");
  assert.ok(note.includes("/tmp/acp-delegate/del_x.out"), "names the retained file");
  assert.ok(note.includes('resumeFrom: "del_x"'), "offers resume");
});

// ─── resume stdin text (#235) ───────────────────────────────────────────────

test("delegateStdinText passes the task through unchanged for fresh runs", () => {
  assert.equal(delegateStdinText(false, "do the thing"), "do the thing");
});

test("delegateStdinText resumes with the instruction, optionally plus guidance", () => {
  const bare = delegateStdinText(true, undefined);
  assert.match(bare, /RESUMES a previously interrupted delegate run/);
  assert.ok(!bare.includes("Additional guidance"), "no guidance section without a task");
  const guided = delegateStdinText(true, "focus on the flaky test");
  assert.match(guided, /RESUMES a previously interrupted delegate run/);
  assert.ok(guided.includes("Additional guidance for this attempt:\nfocus on the flaky test"), "guidance appended");
});

// ─── failure diagnostics: activity log in the notification (#235) ───────────

test("injectResult failed run includes the activity log path and exit signal", () => {
  const sent: string[] = [];
  const ok = injectResult(capturePi(sent) as any, "reviewer", "del_x", "review auth", "failed", null, "/tmp/del_x.out", undefined, undefined, "separate", false, "stderr:\nbang", "/tmp/del_x.activity", "SIGTERM");
  assert.equal(ok, true, "injection succeeds");
  const text = sent[0]!;
  assert.ok(text.includes("Activity log: `/tmp/del_x.activity`"), "activity log path present");
  assert.ok(text.includes("exit SIGTERM"), "signal shown in header");
  assert.ok(text.includes("stderr:\nbang"), "composed body present");
});

test("readActivityTail truncates long logs and tolerates missing files", async () => {
  const f = join(tmpdir(), `acp-tail-${Date.now()}.activity`);
  await writeFile(f, "x".repeat(1000), "utf8");
  const tail = await readActivityTail(f, 100);
  assert.equal(tail.length, 101, "cap + ellipsis");
  assert.ok(tail.startsWith("…"), "elided marker");
  assert.equal(await readActivityTail(join(tmpdir(), "no-such-file-235.activity")), "", "missing file yields empty");
  await rm(f, { force: true });
});

// ─── resume validation (#235) ───────────────────────────────────────────────

test("acp_delegate resumeFrom with a missing session file fails fast without spawning", async () => {
  const pi = {} as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const ctx = { ...mockCtx("pi"), mode: "tui", cwd: process.cwd() } as unknown as ExtensionContext;
  const res = await tool.execute(
    "tc-resume-missing",
    { agent: "oracle", resumeFrom: "del_never_ran" },
    undefined,
    undefined,
    ctx,
  );
  const text = (res.content[0] as { text?: string }).text ?? "";
  assert.match(text, /Cannot resume del_never_ran/);
  assert.match(text, /no session file/);
});

test("acp_delegate resumeFrom is rejected on non-pi hosts", async () => {
  const pi = {} as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const ctx = { ...mockCtx("omp"), mode: "tui", cwd: process.cwd() } as unknown as ExtensionContext;
  const res = await tool.execute(
    "tc-resume-omp",
    { agent: "oracle", task: "x", resumeFrom: "del_x" },
    undefined,
    undefined,
    ctx,
  );
  const text = (res.content[0] as { text?: string }).text ?? "";
  assert.match(text, /only supported on pi hosts/);
});

test("acp_delegate resumeFrom copies the original session into the new run's file", async () => {
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const ctx = { ...mockCtx("pi"), mode: "tui", cwd: process.cwd() } as unknown as ExtensionContext;
  const dir = join(tmpdir(), "acp-delegate");
  await mkdir(dir, { recursive: true });
  const origSession = join(dir, "del_orig235.session.jsonl");
  const marker = "not-a-real-pi-session\n";
  await writeFile(origSession, marker, "utf8");
  let runId: string | undefined;
  try {
    const res = await tool.execute(
      "tc-resume-copy",
      { agent: "oracle", resumeFrom: "del_orig235", async: true },
      undefined,
      undefined,
      ctx,
    );
    const launch = (res.content[0] as { text?: string }).text ?? "";
    runId = /new runId `(del_[a-z0-9_]+)`/.exec(launch)?.[1];
    assert.ok(runId, `new runId in launch message: ${launch}`);
    const newSession = join(dir, `${runId}.session.jsonl`);
    assert.ok(existsSync(newSession), "resumed run owns its own session file");
    assert.equal(await readFile(newSession, "utf8"), marker, "history copied from the original run");
    // The child (real pi CLI) rejects the invalid session content and exits 1.
    const deadline = Date.now() + 15000;
    while (!sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(sent.length, 1, `one injected message, got ${JSON.stringify(sent)}`);
    assert.match(sent[0]!, /FAILED/);
    assert.ok(sent[0]!.includes(runId!), "injection names the resumed runId");
  } finally {
    await rm(origSession, { force: true });
    if (runId) {
      await rm(join(dir, `${runId}.session.jsonl`), { force: true });
      await rm(join(dir, `${runId}.out`), { force: true });
      await rm(join(dir, `${runId}.activity`), { force: true });
    }
  }
});

// ─── coalesced completion notifications (#157) ──────────────────────────────
// N delegates finishing near-simultaneously must share ONE injected message
// (each sendUserMessage follow-up costs a model turn), and runs that were
// delivered by other means while queued (wait/cancel) drop out of the batch.

test("flushDelegateNotifications coalesces queued runs into a single message", () => {
  resetDelegateUsage();
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) };
  const a = mkRun("del_a", "completed", { result: { code: 0, file: "/tmp/del_a.out", body: "ok" } });
  const b = mkRun("del_b", "failed", { timedOut: "5m limit" });
  scheduleRunNotification(pi as any, a);
  scheduleRunNotification(pi as any, b);
  assert.equal(sent.length, 0, "nothing sent before the flush window elapses");
  flushDelegateNotifications();
  assert.equal(sent.length, 1, "exactly one coalesced message");
  const text = sent[0]!;
  assert.ok(text.includes("2 delegates finished"), "batch header names the count");
  assert.ok(text.includes("1 completed, 1 FAILED"), "per-status breakdown");
  assert.ok(text.includes("`del_a`") && text.includes("`del_b`"), "both runIds present");
  assert.ok(text.includes("[acp_delegate completed]") && text.includes("[acp_delegate FAILED"), "per-run status headers");
  assert.ok(text.includes("No delegates are currently running."), "trailing remaining line");
  assert.ok(text.includes("NOT a user message"), "closing marks it automated");
  assert.equal(a.injected, true, "del_a marked delivered");
  assert.equal(b.injected, true, "del_b marked delivered");
  assert.equal(a.notifyQueued, false, "queue flag cleared");
});

test("flush skips queued runs that gained a waiter or were consumed meanwhile", () => {
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) };
  const delivered = mkRun("del_a", "completed", { result: { code: 0, file: "/tmp/del_a.out", body: "ok" } });
  const consumedRun = mkRun("del_b", "completed", { consumed: true });
  const waitedRun = mkRun("del_c", "completed", { waiter: () => {} });
  for (const r of [delivered, consumedRun, waitedRun]) scheduleRunNotification(pi as any, r);
  flushDelegateNotifications();
  assert.equal(sent.length, 1);
  const text = sent[0]!;
  assert.ok(text.includes("`del_a`"), "the unclaimed run is delivered");
  assert.ok(!text.includes("del_b") && !text.includes("del_c"), "wait/cancel-owned runs are excluded");
});

test("failed batch send leaves runs undelivered for a later recovery carrier", () => {
  const pi = { sendUserMessage: () => { throw new Error("queue closed"); } };
  const a = mkRun("del_a", "completed");
  const b = mkRun("del_b", "failed");
  scheduleRunNotification(pi as any, a);
  scheduleRunNotification(pi as any, b);
  flushDelegateNotifications();
  assert.equal(a.injected, undefined, "not marked delivered on send failure");
  assert.equal(b.injected, undefined, "not marked delivered on send failure");
  assert.deepEqual(findUndeliveredRuns([a, b]).map((r) => r.runId), ["del_a", "del_b"], "both recoverable");
});

test("single undelivered run flushes through the legacy single-run format", () => {
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) };
  const a = mkRun("del_solo", "completed", { result: { code: 0, file: "/tmp/del_solo.out", body: "ok" } });
  scheduleRunNotification(pi as any, a);
  flushDelegateNotifications();
  assert.equal(sent.length, 1);
  const text = sent[0]!;
  assert.ok(text.includes("[acp_delegate completed] **reviewer**"), "legacy single-run header");
  assert.ok(text.includes("`del_solo`"), "names the run");
  assert.ok(!text.includes("delegates finished ("), "no batch header for a single run");
  assert.equal(a.injected, true);
});

test("findUndeliveredRuns excludes queued runs (scheduled is not lost)", () => {
  const queued = mkRun("del_q", "completed", { notifyQueued: true });
  const lost = mkRun("del_lost", "failed");
  const found = findUndeliveredRuns([queued, lost]);
  assert.deepEqual(found.map((r) => r.runId), ["del_lost"], "queued run awaits its batch, only the lost run needs recovery");
});

test("formatBatchRunSection carries the timeout note and error excerpt", () => {
  const run = mkRun("del_t", "failed", { timedOut: "no output for 5m", result: { code: 1, file: "/tmp/del_t.out", body: "Error: provider 429" } });
  const section = formatBatchRunSection(run);
  assert.ok(section.includes("[acp_delegate FAILED"), "FAILED status");
  assert.ok(section.includes("(timed out: no output for 5m)"), "timeout note");
  assert.ok(section.includes("Error: provider 429"), "error excerpt");
  assert.ok(section.includes("/tmp/del_t.out"), "result file path");
  const ok = formatBatchRunSection(mkRun("del_ok", "completed", { result: { code: 0, file: "/tmp/del_ok.out", body: "hidden" } }));
  assert.ok(ok.includes("[acp_delegate completed]"), "completed status");
  assert.ok(!ok.includes("hidden"), "completed runs carry no body");
});

// ─── #279: configurable maxDepth + timeouts ─────────────────────────────────

test("depth gate honors configured maxDepth (rejection paths, no spawn)", async () => {
  const pi = { sendUserMessage: () => {} } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const ctx = { ...mockCtx("pi"), mode: "tui", cwd: process.cwd() } as unknown as ExtensionContext;
  const prev = process.env.PI_ACP_DELEGATE_DEPTH;
  const textOf = (res: Awaited<ReturnType<typeof tool.execute>>): string => (res.content[0] as { text?: string }).text ?? "";
  try {
    setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
    process.env.PI_ACP_DELEGATE_DEPTH = "2";
    let res = await tool.execute("tc-depth-a", { agent: "oracle", task: "x" }, undefined, undefined, ctx);
    assert.match(textOf(res), /nesting limit reached \(depth 2, max 2\)/, "default maxDepth 2 rejects depth 2");

    setDelegatePolicy({ ...DEFAULT_DELEGATE_POLICY, maxDepth: 1 });
    process.env.PI_ACP_DELEGATE_DEPTH = "1";
    res = await tool.execute("tc-depth-b", { agent: "oracle", task: "x" }, undefined, undefined, ctx);
    assert.match(textOf(res), /nesting limit reached \(depth 1, max 1\)/, "maxDepth 1 rejects depth 1");

    setDelegatePolicy({ ...DEFAULT_DELEGATE_POLICY, maxDepth: 3 });
    process.env.PI_ACP_DELEGATE_DEPTH = "3";
    res = await tool.execute("tc-depth-c", { agent: "oracle", task: "x" }, undefined, undefined, ctx);
    assert.match(textOf(res), /nesting limit reached \(depth 3, max 3\)/, "maxDepth 3 rejects depth 3");
  } finally {
    if (prev === undefined) delete process.env.PI_ACP_DELEGATE_DEPTH;
    else process.env.PI_ACP_DELEGATE_DEPTH = prev;
    setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
  }
});

test("delegateChildEnv increments depth and propagates the maxDepth cap", () => {
  const env = delegateChildEnv(1, 3);
  assert.equal(env.PI_ACP_DELEGATE_DEPTH, "2", "child depth = parent + 1");
  assert.equal(env.PI_ACP_DELEGATE_MAX_DEPTH, "3", "cap follows the delegation tree");
  for (const [key, value] of Object.entries(process.env)) {
    assert.equal(env[key], value, `parent env ${key} inherited`);
  }
});

test("asyncWatchdogDescription reflects the resolved policy", () => {
  try {
    setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
    assert.equal(
      asyncWatchdogDescription(),
      "A watchdog force-finishes a hung run: no output for 5m, 10s after output ends, or a 30m hard limit — the result reflects whatever was produced.",
    );
    setDelegatePolicy({ ...DEFAULT_DELEGATE_POLICY, idleMs: 10 * 60_000, asyncTimeoutMs: 90 * 60_000 });
    assert.equal(
      asyncWatchdogDescription(),
      "A watchdog force-finishes a hung run: no output for 10m, 10s after output ends, or a 90m hard limit — the result reflects whatever was produced.",
    );
    setDelegatePolicy({ ...DEFAULT_DELEGATE_POLICY, idleMs: null, asyncTimeoutMs: null });
    assert.equal(
      asyncWatchdogDescription(),
      "A watchdog force-finishes a hung run: 10s after output ends — the result reflects whatever was produced.",
    );
  } finally {
    setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
  }
});
// ─── ConcurrencyGate: bounded / serial background delegation (#294) ────────

test("ConcurrencyGate: unlimited capacity starts every launch immediately", () => {
  const gate = new ConcurrencyGate(() => Infinity);
  assert.equal(gate.unlimited, true);
  let started = 0;
  assert.equal(gate.launchOrQueue("a", () => started++), true);
  assert.equal(gate.launchOrQueue("b", () => started++), true);
  assert.equal(started, 2, "both launch immediately");
  assert.equal(gate.queuedCount, 0);
});

test("ConcurrencyGate: capacity 1 serializes launches FIFO", () => {
  const gate = new ConcurrencyGate(() => 1);
  const order: string[] = [];
  assert.equal(gate.launchOrQueue("a", () => order.push("a")), true, "first starts");
  assert.equal(gate.launchOrQueue("b", () => order.push("b")), false, "second queues");
  assert.equal(gate.launchOrQueue("c", () => order.push("c")), false, "third queues");
  assert.deepEqual(order, ["a"]);
  assert.equal(gate.activeCount, 1);
  assert.equal(gate.queuedCount, 2);
  gate.release();
  assert.deepEqual(order, ["a", "b"], "release advances FIFO");
  assert.equal(gate.activeCount, 1);
  assert.equal(gate.queuedCount, 1);
  gate.release();
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(gate.activeCount, 1);
  assert.equal(gate.queuedCount, 0);
});

test("ConcurrencyGate: capacity N allows N concurrent before queueing", () => {
  const gate = new ConcurrencyGate(() => 2);
  const order: string[] = [];
  assert.equal(gate.launchOrQueue("a", () => order.push("a")), true);
  assert.equal(gate.launchOrQueue("b", () => order.push("b")), true);
  assert.equal(gate.launchOrQueue("c", () => order.push("c")), false);
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(gate.activeCount, 2);
  gate.release();
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(gate.activeCount, 2);
});

test("ConcurrencyGate: cancelling a queued run skips it without leaking a slot", () => {
  const gate = new ConcurrencyGate(() => 1);
  const order: string[] = [];
  assert.equal(gate.launchOrQueue("a", () => order.push("a")), true);
  assert.equal(gate.launchOrQueue("b", () => order.push("b")), false);
  assert.equal(gate.launchOrQueue("c", () => order.push("c")), false);
  assert.equal(gate.cancelQueued("b"), true, "b was queued");
  assert.equal(gate.cancelQueued("zzz"), false, "unknown id not queued");
  gate.release();
  assert.deepEqual(order, ["a", "c"], "cancelled b never launched");
  assert.equal(gate.activeCount, 1);
  assert.equal(gate.queuedCount, 0);
});

