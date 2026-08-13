import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildArgs, delegateSpawnOptions, injectedWaitMessage, buildWaitResult, buildCancelResult, getDelegateUsage, resetDelegateUsage, injectResult } from "../src/delegate-tool.js";
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
  );
  assert.equal(getToolsValue(cliArgs), null, "worker does NOT receive --tools");
});

test("buildChildArgs worker still inherits provider/model from ctx", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "fix bug" },
    "prompt",
    mockCtx(),
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
  );
  assert.equal(getToolsValue(cliArgs), null, "--tools not added for unknown agent");
});

// ─── --tools comes before --provider/--model ───────────────────────────────

test("buildChildArgs places --tools before --provider/--model", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "reviewer", task: "test", model: "openai/gpt-5" },
    "prompt",
    mockCtx(),
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
  );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0);
  assert.equal(cliArgs[providerIdx + 1], "anthropic");
  assert.ok(modelIdx >= 0);
  assert.equal(cliArgs[modelIdx + 1], "claude-5");
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
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", 0, "/tmp/del_x.out", undefined, USAGE_FIXTURE, "separate", false);
  assert.equal(ok, true, "injection succeeds");
  const total = getDelegateUsage();
  assert.ok(total, "usage accumulated into session total");
  assert.equal(total!.input, 150);
  assert.equal(total!.output, 80);
});

test("injectResult does not double-accumulate when usage already reported", () => {
  resetDelegateUsage();
  const pi = { sendUserMessage: () => {} };
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", 0, "/tmp/del_x.out", undefined, USAGE_FIXTURE, "separate", true);
  assert.equal(ok, true, "injection succeeds");
  assert.equal(getDelegateUsage(), undefined, "no accumulation when already reported");
});

test("injectResult merged mode injects without accumulating", () => {
  resetDelegateUsage();
  const pi = { sendUserMessage: () => {} };
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", 0, "/tmp/del_x.out", undefined, USAGE_FIXTURE, "merged", false);
  assert.equal(ok, true, "injection succeeds");
  assert.equal(getDelegateUsage(), undefined, "merged mode never accumulates");
});

test("injectResult without usage leaves cumulative total undefined", () => {
  resetDelegateUsage();
  const pi = { sendUserMessage: () => {} };
  const ok = injectResult(pi as any, "reviewer", "del_x", "test", 0, "/tmp/del_x.out", undefined, undefined, "separate", false);
  assert.equal(ok, true, "injection succeeds");
  assert.equal(getDelegateUsage(), undefined, "no usage, no accumulation");
});

test("injectResult returns false when sendUserMessage unavailable", () => {
  const ok = injectResult({} as any, "reviewer", "del_x", "test", 0, "/tmp/del_x.out");
  assert.equal(ok, false, "no sendUserMessage means no injection");
});

test("buildWaitResult merged mode does not accumulate delegateUsageTotal", () => {
  resetDelegateUsage();
  const run = { runId: "del_x", agent: "reviewer", task: "test", usage: USAGE_FIXTURE };
  const result = buildWaitResult(run as any, "content", "merged");
  assert.ok(result.usage, "usage present in merged mode");
  assert.equal(getDelegateUsage(), undefined, "merged mode never accumulates");
});
