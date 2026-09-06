import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OUT_DIR, fleetRunsSnapshot, orderRunsForFleet, makeDelegateTool, makeDelegateCancelTool } from "../src/delegate-tool.js";
import {
  formatDuration, formatToolLabel, statusIcon, usageSummary, buildListRows, renderListBody, renderTranscriptBlocks, parseSessionJsonl, readTailSync, readHeadSync, buildSnapshotText,
  type InspectorTheme, type ListRow, type TranscriptBlock,
} from "../src/fleet-inspector.js";

const plainTheme: InspectorTheme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };

function mkView(over: Record<string, unknown> = {}): any {
  return {
    runId: "del_x", agent: "worker", task: "do the thing", cwd: "/tmp/proj",
    startedAt: Date.now() - 30_000, status: "running", exitLabel: "exit ?",
    replyFile: "/tmp/acp-delegate/del_x.out", ...over,
  };
}

function assertWidthSafe(lines: string[], width: number): void {
  for (const l of lines) assert.ok(visibleWidth(l) <= width, `line exceeds width ${width}: ${JSON.stringify(l)}`);
}

// ─── pure formatters ────────────────────────────────────────────────────────

test("formatDuration buckets seconds/minutes/hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-5_000), "0s");
  assert.equal(formatDuration(59_999), "59s");
  assert.equal(formatDuration(61_500), "1m01s");
  assert.equal(formatDuration(3_723_000), "1h02m");
});

test("statusIcon maps each run status", () => {
  assert.equal(statusIcon("queued"), "○");
  assert.equal(statusIcon("running"), "●");
  assert.equal(statusIcon("completed"), "✓");
  assert.equal(statusIcon("failed"), "✗");
  assert.equal(statusIcon("cancelled"), "⊘");
});

test("usageSummary hides zero-usage and formats tokens", () => {
  assert.equal(usageSummary(undefined), undefined);
  assert.equal(usageSummary({ input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }), undefined);
  const s = usageSummary({ input: 1234, output: 56, totalTokens: 1290, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.ok(s!.includes("1,234") && s!.includes("56"), s);
});

// ─── readTailSync ───────────────────────────────────────────────────────────

test("readTailSync returns whole small file, bounded tail with line boundary, '' when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-test-"));
  try {
    const small = join(dir, "small.txt");
    await writeFile(small, "abc\ndef\n");
    assert.equal(readTailSync(small, 4096), "abc\ndef\n");

    const big = join(dir, "big.txt");
    let content = "";
    for (let i = 0; i < 200; i++) content += `line-${i}\n`;
    await writeFile(big, content);
    const tail = readTailSync(big, 20);
    assert.ok(tail.length <= 20, `tail within bound: ${tail.length}`);
    assert.ok(tail.startsWith("line-"), `partial leading line dropped: ${JSON.stringify(tail.slice(0, 8))}`);
    assert.ok(tail.endsWith("\n"));

    assert.equal(readTailSync(join(dir, "nope.txt"), 100), "");
    assert.equal(readTailSync(undefined, 100), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── list building + rendering ──────────────────────────────────────────────

test("buildListRows shows live duration for running, terminal label + tokens otherwise", () => {
  const now = Date.now();
  const rows = buildListRows([
    mkView({ startedAt: now - 5_000 }),
    mkView({ runId: "del_y", status: "failed", finishedAt: now - 1_000, exitLabel: "exit 1", usage: { input: 10, output: 2, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, task: "x".repeat(80) }),
  ], now);
  assert.match(rows[0]!.label, /● worker · running 5s/);
  assert.match(rows[1]!.label, /✗ worker · failed exit 1/);
  assert.ok(!rows[1]!.detail.includes("x".repeat(49)), "long task truncated");
  assert.ok(rows[1]!.detail.includes("↑10 ↓2"), "token summary appended");
});

test("renderListBody is width-safe, marks selection, handles empty list", () => {
  const rows: ListRow[] = buildListRows([mkView(), mkView({ runId: "del_y", agent: "oracle" })], Date.now());
  const lines = renderListBody(rows, 1, plainTheme, 30);
  assertWidthSafe(lines, 30);
  assert.equal(lines.length, rows.length);
  assert.ok(!lines[0]!.startsWith("> "), "first row not selected");
  assert.ok(lines[1]!.startsWith("> "), "selected row has marker");

  const empty = renderListBody([], 0, plainTheme, 30);
  assertWidthSafe(empty, 30);
  assert.ok(empty.some((l) => l.includes("no delegate runs yet")));
});

test("parseSessionJsonl extracts user/thinking/text/toolCall/toolResult from a pi session", () => {
  const raw = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" }),
    JSON.stringify({ type: "model_change", provider: "vllm", modelId: "qwen" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "do it" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a\nb" }], isError: false } }),
    "not-json-line",
  ].join("\n");
  const blocks = parseSessionJsonl(raw);
  assert.deepEqual(blocks.map((b) => b.kind), ["meta", "user", "thinking", "text", "toolCall", "toolResult"]);
  assert.equal(blocks.find((b) => b.kind === "toolCall")?.name, "bash");
  assert.equal(blocks.find((b) => b.kind === "toolResult")?.isError, false);
});

test("renderTranscriptBlocks renders conversation+thinking+tools and is width-safe", () => {
  const blocks: TranscriptBlock[] = parseSessionJsonl([
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello world" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning here" }, { type: "text", text: "the answer" }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: true } }),
  ].join("\n"));
  const lines = renderTranscriptBlocks(blocks, plainTheme, 40);
  assertWidthSafe(lines, 40);
  assert.ok(lines.some((l) => l.trim() === "hello world"), "user message rendered as its own line");
  assert.ok(lines.some((l) => l.includes("reasoning here")), "thinking shown");
  assert.ok(lines.some((l) => l.includes("the answer")));
  assert.ok(lines.some((l) => l.includes("✗ read")), "error tool marked");
});

test("renderTranscriptBlocks shows placeholder when empty", () => {
  assert.ok(renderTranscriptBlocks([], plainTheme, 40).some((l) => l.includes("(no session content yet)")));
});

test("readHeadSync returns whole small file, bounded head, '' when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-head-"));
  try {
    const small = join(dir, "small.txt");
    await writeFile(small, "abc\ndef\n");
    assert.equal(readHeadSync(small, 4096), "abc\ndef\n");
    const big = join(dir, "big.txt");
    let content = "";
    for (let i = 0; i < 200; i++) content += `line-${i}\n`;
    await writeFile(big, content);
    const head = readHeadSync(big, 20);
    assert.ok(head.startsWith("line-0"), `head starts at beginning: ${JSON.stringify(head.slice(0, 8))}`);
    assert.equal(readHeadSync(join(dir, "nope.txt"), 100), "");
    assert.equal(readHeadSync(undefined, 100), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildSnapshotText lists runs, tails running activity, points at files dir", () => {
  assert.equal(buildSnapshotText([], Date.now()), "acp_delegate: no runs recorded this session.");
  const dir = tmpdir();
  const actFile = join(dir, "acp-delegate", "del_snap.activity");
  const text = buildSnapshotText([mkView({ activityFile: actFile })], Date.now());
  assert.ok(text.includes("1 run(s)"));
  assert.ok(text.includes("● worker · running"));
  assert.ok(text.includes(actFile ? OUT_DIR : ""));
});

// ─── ordering ───────────────────────────────────────────────────────────────

test("orderRunsForFleet: running first by spawn time, then finished newest-first capped", () => {
  const t = Date.now();
  const all = [
    mkView({ runId: "f_mid", status: "failed", startedAt: t - 5000, finishedAt: t - 500 }),
    mkView({ runId: "r_new", startedAt: t - 1000 }),
    mkView({ runId: "r_old", startedAt: t - 4000 }),
    mkView({ runId: "f_new", status: "completed", startedAt: t - 3000, finishedAt: t - 100 }),
    ...Array.from({ length: 14 }, (_, i) =>
      mkView({ runId: `f_cap_${i}`, status: "completed", startedAt: t - i, finishedAt: t - 1000 - i * 100 })),
  ];
  const ordered = orderRunsForFleet(all as any[]).map((r) => r.runId);
  assert.deepEqual(ordered.slice(0, 2), ["r_old", "r_new"], "running first, oldest spawn on top");
  assert.deepEqual(ordered.slice(2, 4), ["f_new", "f_mid"], "finished newest-first by finishedAt");
  assert.ok(!ordered.includes("f_cap_13"), "oldest finished dropped by the cap");
  assert.equal(ordered.length, 2 + 12, "finished list capped at 12");
});

// ─── e2e: real spawns through PI_CLI_PATH fake scripts ─────────────────────

function mockCtx(cwd: string): ExtensionContext {
  return {
    model: { provider: "test", id: "test-model" },
    sessionManager: { buildContextEntries: () => [] },
    mode: "tui",
    cwd,
  } as unknown as ExtensionContext;
}

async function waitFor(pred: () => boolean, deadlineMs: number, what: string): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("fleetRunsSnapshot maps real spawns: failed run fields, running-first order, cancel", async () => {
  const prevCli = process.env.PI_CLI_PATH;
  const workDir = await mkdtemp(join(tmpdir(), "fleet-e2e-"));
  const scriptsDir = await mkdtemp(join(tmpdir(), "fleet-scripts-"));
  // Delegate children run `node <PI_CLI_PATH>` — fakes must be JS modules.
  const failScript = join(scriptsDir, "fail.js");
  const sleepScript = join(scriptsDir, "sleep.js");
  await writeFile(failScript, "process.exit(1);\n");
  await writeFile(sleepScript, "setInterval(() => {}, 1000);\n");
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const cancelTool = makeDelegateCancelTool(pi);
  const cleanupIds: string[] = [];
  try {
    // 1) failing child → failed run with mapped fields
    process.env.PI_CLI_PATH = failScript;
    const res = await tool.execute("tc-fleet-fail", { agent: "oracle", task: "will fail", cwd: workDir, async: true }, undefined, undefined, mockCtx(workDir));
    const launch = (res.content[0] as { text?: string }).text ?? "";
    const failId = /`(del_[a-z0-9_]+)`/.exec(launch)?.[1];
    assert.ok(failId, `runId in launch message: ${launch}`);
    cleanupIds.push(failId!);
    await waitFor(() => sent.length > 0, 15_000, "failure notification");
    assert.match(sent[0]!, /FAILED|exit 1/);

    let snap = fleetRunsSnapshot().find((r) => r.runId === failId);
    assert.ok(snap, "failed run present in snapshot");
    assert.equal(snap!.status, "failed");
    assert.equal(snap!.exitLabel, "exit 1");
    assert.equal(snap!.agent, "oracle");
    assert.equal(snap!.task, "will fail");
    assert.ok(existsSync(snap!.replyFile), `reply file retained: ${snap!.replyFile}`);
    assert.ok(snap!.activityFile && snap!.activityFile.endsWith(".activity"), "async pi host has activity file");
    assert.equal(snap!.sessionFile, join(OUT_DIR, `${failId}.session.jsonl`));

    // 2) sleeping child → running, ordered first
    process.env.PI_CLI_PATH = sleepScript;
    const res2 = await tool.execute("tc-fleet-sleep", { agent: "worker", task: "long task", cwd: workDir, async: true }, undefined, undefined, mockCtx(workDir));
    const sleepId = /`(del_[a-z0-9_]+)`/.exec((res2.content[0] as { text?: string }).text ?? "")?.[1];
    assert.ok(sleepId, "second runId extracted");
    cleanupIds.push(sleepId!);
    await waitFor(() => fleetRunsSnapshot().some((r) => r.runId === sleepId && r.status === "running"), 15_000, "running status");

    const ordered = fleetRunsSnapshot();
    assert.equal(ordered[0]?.runId, sleepId, "running run listed first");
    assert.equal(ordered[0]?.status, "running");

    // 3) cancel flips status synchronously; finalize (child close) records the result
    await cancelTool.execute("tc-fleet-cancel", { runId: sleepId! });
    assert.equal(fleetRunsSnapshot().find((r) => r.runId === sleepId)?.status, "cancelled");
    // finishedAt is the finalize marker: sync cancel only flips status; the
    // child-close handler records finishedAt + result (FleetRunView hides it).
    await waitFor(() => fleetRunsSnapshot().find((r) => r.runId === sleepId)?.finishedAt !== undefined, 15_000, "cancelled finalize");
    const after = fleetRunsSnapshot().find((r) => r.runId === sleepId);
    assert.equal(after?.replyFile, join(OUT_DIR, `${sleepId}.out`));
    assert.ok(existsSync(after!.replyFile), "cancelled run keeps its files");
  } finally {
    if (prevCli === undefined) delete process.env.PI_CLI_PATH;
    else process.env.PI_CLI_PATH = prevCli;
    for (const id of cleanupIds) {
      for (const ext of [".out", ".activity", ".session.jsonl"]) {
        await rm(join(OUT_DIR, id + ext), { force: true });
      }
    }
    await rm(workDir, { recursive: true, force: true });
    await rm(scriptsDir, { recursive: true, force: true });
  }
});

test("formatToolLabel summarizes common tools pi-style", () => {
  assert.equal(formatToolLabel("bash", { command: "echo hi\nthere" }), "bash echo hi there");
  assert.equal(formatToolLabel("read", { path: "/a/b.ts", offset: 10, limit: 5 }), "read /a/b.ts:10-14");
  assert.equal(formatToolLabel("read", { path: "/a/b.ts" }), "read /a/b.ts");
  assert.equal(formatToolLabel("grep", { pattern: "foo", path: "/x" }), "grep /foo/ in /x");
  assert.equal(formatToolLabel("ls", { path: "/tmp" }), "ls /tmp");
  assert.match(formatToolLabel("custom", { a: 1 }), /^custom \{.*\}/);
});

test("renderTranscriptBlocks renders tool call (name + label) and multi-line result", () => {
  const blocks: TranscriptBlock[] = [
    { kind: "toolCall", name: "bash", text: "", args: { command: "ls -la" } },
    { kind: "toolResult", name: "bash", text: "line1\nline2\nline3", isError: false },
  ];
  const lines = renderTranscriptBlocks(blocks, plainTheme, 40);
  assertWidthSafe(lines, 40);
  assert.ok(lines.some((l) => l.includes("✓ bash")), "tool name shown");
  assert.ok(lines.some((l) => l.includes("bash ls -la")), "pi-style arg label");
  assert.ok(lines.some((l) => l.trim() === "line1"), "result body line");
  assert.ok(lines.some((l) => l.trim() === "line2"), "multi-line result body");
});

test("renderTranscriptBlocks renders assistant text as markdown (heading/list)", () => {
  const blocks: TranscriptBlock[] = [{ kind: "text", text: "# Summary\n\n- first point\n- second point" }];
  const lines = renderTranscriptBlocks(blocks, plainTheme, 40);
  assertWidthSafe(lines, 40);
  assert.ok(lines.some((l) => l.includes("Summary")), "heading text present");
  assert.ok(!lines.some((l) => l.trim().startsWith("#")), "markdown heading marker stripped");
  assert.ok(lines.some((l) => l.includes("first point")), "list item present");
});
