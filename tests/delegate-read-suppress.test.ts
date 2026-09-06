import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldSuppressRead,
  applyReadSuppression,
  markDelegateResultRead,
  markDelegateRunReadByCommand,
  injectedWaitMessage,
  resetDelegateUsage,
  getDelegateUsage,
  setDelegateDisplayUsage,
  makeDelegateTool,
  makeDelegateWaitTool,
  runningRunsSnapshot,
  flushDelegateNotifications,
} from "../src/delegate-tool.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const OUT_DIR = join(tmpdir(), "acp-delegate");
const USAGE_FIXTURE = { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } };

/** Minimal ctx mock (same shape as delegate-tool.test.ts). */
function mockCtx(): ExtensionContext {
  const sessionManager = { buildContextEntries: () => [] };
  return { model: { provider: "test", id: "test-model" }, sessionManager } as unknown as ExtensionContext;
}

// ─── shouldSuppressRead: pure decision ──────────────────────────────────────

test("shouldSuppressRead: skip mode + read at/after finish → suppressed", () => {
  assert.equal(shouldSuppressRead({ readAt: 100, finishedAt: 100 }, "skip"), true, "read exactly at finish counts");
  assert.equal(shouldSuppressRead({ readAt: 200, finishedAt: 100 }, "skip"), true, "read after finish counts");
});

test("shouldSuppressRead: read while running (partial output) → not suppressed", () => {
  assert.equal(shouldSuppressRead({ readAt: 50, finishedAt: 100 }, "skip"), false);
});

test("shouldSuppressRead: no read or no finish → not suppressed", () => {
  assert.equal(shouldSuppressRead({}, "skip"), false);
  assert.equal(shouldSuppressRead({ readAt: 100 }, "skip"), false, "read with unknown finish time is not provably final");
  assert.equal(shouldSuppressRead({ finishedAt: 100 }, "skip"), false);
});

test("shouldSuppressRead: always mode never suppresses", () => {
  assert.equal(shouldSuppressRead({ readAt: 200, finishedAt: 100 }, "always"), false);
});

// ─── applyReadSuppression: delivered marking + usage accounting ─────────────

test("applyReadSuppression marks delivered and accumulates usage in separate mode", () => {
  resetDelegateUsage();
  setDelegateDisplayUsage("separate");
  const run: any = { runId: "del_x", usage: USAGE_FIXTURE };
  applyReadSuppression(run, "del_x");
  assert.equal(run.readSuppressed, true);
  assert.equal(run.injected, true, "treated as delivered so wait/recovery never re-surface it");
  assert.equal(run.usageReported, true);
  assert.equal(getDelegateUsage()?.input, 150, "usage still accounted in separate mode");
});

test("applyReadSuppression does not double-count already-reported usage", () => {
  resetDelegateUsage();
  setDelegateDisplayUsage("separate");
  const run: any = { runId: "del_x", usage: USAGE_FIXTURE, usageReported: true };
  applyReadSuppression(run, "del_x");
  assert.equal(getDelegateUsage(), undefined, "no accumulation when already reported");
});

test("applyReadSuppression without usage leaves the total undefined", () => {
  resetDelegateUsage();
  setDelegateDisplayUsage("separate");
  const run: any = { runId: "del_x" };
  applyReadSuppression(run, "del_x");
  assert.equal(getDelegateUsage(), undefined);
});

// ─── injectedWaitMessage: readSuppressed branch ─────────────────────────────

test("injectedWaitMessage: readSuppressed run explains the skipped notification", () => {
  const msg = injectedWaitMessage(
    { readSuppressed: true, injected: true, result: { file: "/tmp/acp-delegate/del_x.out" } },
    "del_x",
    "",
  );
  assert.ok(msg, "returns a message for a read-suppressed run");
  assert.ok(msg!.includes("del_x"), "names the runId");
  assert.ok(msg!.includes("read its result file"), "explains why no notification arrived");
  assert.ok(msg!.includes("/tmp/acp-delegate/del_x.out"), "points at the result file");
  assert.ok(!msg!.includes("already delivered"), "does not claim a notification was delivered");
});

test("injectedWaitMessage: readSuppressed takes precedence over plain injected", () => {
  const msg = injectedWaitMessage(
    { readSuppressed: true, injected: true, result: {} },
    "del_x",
    " 2 delegates are still running.",
  );
  assert.ok(msg!.includes("2 delegates are still running"), "passes through the remaining line");
  assert.ok(!msg!.includes("already delivered"), "suppressed wording wins");
});

// ─── read marking against the live runs registry ────────────────────────────
// Seeds a real run via an ENOENT spawn (no LLM needed): the run lands in the
// module registry, then the mark functions must match it by result-file path
// and by runId-in-command.

async function seedRunId(): Promise<string> {
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const ctx = { ...mockCtx(), mode: "tui", cwd: process.cwd() } as unknown as ExtensionContext;
  const res = await tool.execute(
    "tc-read-mark",
    { agent: "oracle", task: "e2e", cwd: "/nonexistent-e2e-cwd", async: true },
    undefined,
    undefined,
    ctx,
  );
  const launch = (res.content[0] as { text?: string }).text ?? "";
  const runId = /`(del_[a-z0-9_]+)`/.exec(launch)?.[1];
  assert.ok(runId, `runId in launch message: ${launch}`);
  return runId!;
}

test("markDelegateResultRead matches the run's result file path", async () => {
  const runId = await seedRunId();
  assert.equal(markDelegateResultRead(join(OUT_DIR, `${runId}.out`)), true, "result file path matches the run");
  assert.equal(markDelegateResultRead("/tmp/unrelated-file.txt"), false, "unrelated path does not match");
  assert.equal(markDelegateResultRead(""), false, "empty path is inert");
});

test("markDelegateRunReadByCommand matches runIds referenced in a bash command", async () => {
  const runId = await seedRunId();
  assert.equal(markDelegateRunReadByCommand(`cat ${join(OUT_DIR, `${runId}.out`)}`), true, "cat of the result file matches");
  assert.equal(markDelegateRunReadByCommand("ls /tmp"), false, "command without a runId does not match");
  assert.equal(markDelegateRunReadByCommand(""), false, "empty command is inert");
});

test("markDelegateRunReadByCommand ignores runId-looking text with no matching run", async () => {
  await seedRunId();
  assert.equal(markDelegateRunReadByCommand("echo del_nosuchrun_1234"), false, "unknown runId does not match");
});

// ─── failures are loud: read-suppression never applies to FAILED runs ──────
// A failed run's result file holds only partial output — no exit status, no
// failure marker. A model polling the file after the failure cannot tell the
// run failed from the file alone, so the FAILED notification must go out even
// when readAt >= finishedAt.

test("failed run read after finish still gets its FAILED notification", async () => {
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const ctx = { ...mockCtx(), mode: "tui", cwd: process.cwd() } as unknown as ExtensionContext;
  const res = await tool.execute(
    "tc-fail-loud",
    { agent: "oracle", task: "e2e", cwd: "/nonexistent-e2e-cwd", async: true },
    undefined,
    undefined,
    ctx,
  );
  const launch = (res.content[0] as { text?: string }).text ?? "";
  const runId = /`(del_[a-z0-9_]+)`/.exec(launch)?.[1];
  assert.ok(runId, `runId in launch message: ${launch}`);
  const settleDeadline = Date.now() + 5000;
  while (runningRunsSnapshot().length > 0 && Date.now() < settleDeadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(runningRunsSnapshot().length, 0, "run settled");
  // The model reads the result file AFTER the failure (e.g. it was polling
  // for the result). readAt >= finishedAt now holds, but the run failed.
  assert.equal(markDelegateResultRead(join(OUT_DIR, `${runId}.out`)), true, "read of the failed run's file matches");
  flushDelegateNotifications();
  const deliverDeadline = Date.now() + 5000;
  while (!sent.some((t) => t.includes(runId!)) && Date.now() < deliverDeadline) await new Promise((r) => setTimeout(r, 50));
  const mine = sent.find((t) => t.includes(runId!));
  assert.ok(mine, `FAILED notification delivered despite the post-finish read, got ${JSON.stringify(sent)}`);
  assert.match(mine!, /FAILED/);
  assert.ok(!mine!.includes("no completion notification was injected"), "no suppression wording in the notification");
  const waitTool = makeDelegateWaitTool(pi);
  const waitRes = await waitTool.execute("tc-fail-loud-wait", { runId: runId! }, undefined, undefined, ctx);
  const waitText = (waitRes.content[0] as { text?: string }).text ?? "";
  assert.ok(!waitText.includes("no completion notification was injected"), `wait does not claim the notification was suppressed: ${waitText}`);
});
