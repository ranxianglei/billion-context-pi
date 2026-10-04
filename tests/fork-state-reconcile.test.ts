import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { SessionStateStore } from "../src/state.js";
import { reconcileBlocksAgainstBranch, compressEvidenceIds } from "../src/state-reconcile.js";
import { createInitialState } from "acp-kernel";
import { setRunNpmForTest } from "../src/update.js";

// issue #603: a fork branched BEFORE some of the parent's compressions ran
// inherits the parent's CURRENT blocks via the parentSession chain; the kernel
// prunes raw messages those blocks cover while Pi carries summaries only via
// compress toolResults in the branch's own log — so the request silently loses
// both raw text and summary. These regressions pin the branch-evidence filter:
// a block survives only when its creating compress call succeeded on THIS
// branch; unevidenced blocks are removed (and their consumed predecessors
// resurrected by kernel syncBlocks); explicitly derived children (#364) are
// exempt; healthy clones see zero churn.

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;

function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "acp-fork-reconcile-"));
}

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

function makeBlock(blockId: string, over: Record<string, unknown> = {}): any {
  return {
    blockId, runId: 0, tier: 1, generation: "young", active: true,
    summary: `summary ${blockId}`, directMessageIds: ["a1"], effectiveMessageIds: ["a1"],
    directBlockIds: [], survivedCount: 0, createdAt: 1, ...over,
  };
}

function msg(id: string, message: Record<string, unknown>): any {
  return { type: "message", id, parentId: null, timestamp: "", message };
}

const userE = (id: string, text: string) => msg(id, { role: "user", content: text, timestamp: 0 });
const asstE = (id: string, text: string) => msg(id, { role: "assistant", content: text, timestamp: 0 });
const callE = (id: string, callId: string) => msg(id, { role: "assistant", content: [{ type: "toolCall", name: "compress", id: callId, arguments: {} }], timestamp: 0 });
const resultE = (id: string, callId: string, isError = false) => msg(id, { role: "toolResult", toolName: "compress", toolCallId: callId, isError, content: `Compressed block via ${callId}.`, timestamp: 0 });

async function writeHeader(file: string, opts: { parentSession?: string } = {}) {
  const header = { type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: "/tmp", ...(opts.parentSession ? { parentSession: opts.parentSession } : {}) };
  await writeFile(file, JSON.stringify(header) + "\n", "utf8");
}

async function writeSidecar(sessionFile: string, blocks: any[], extra: Record<string, unknown> = {}) {
  const state = createInitialState();
  state.blocks.push(...blocks);
  state.nextBlockId = blocks.length + 1;
  await writeFile(`${sessionFile}.acp.json`, JSON.stringify({ ...state, ...extra }), "utf8");
}

async function readSidecar(sessionFile: string): Promise<any> {
  return JSON.parse(await readFile(`${sessionFile}.acp.json`, "utf8"));
}

function piCtx(getEntries: () => any[], stateFile: string): any {
  return {
    mode: "rpc",
    cwd: "/tmp",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => getEntries(),
      getSessionId: () => "fork-reconcile-sid",
      getSessionFile: () => stateFile,
    },
  };
}

function forkCtx(getBranch: () => any[], stateFile: string): any {
  return {
    mode: "rpc",
    cwd: "/tmp",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      getBranch: () => getBranch(),
      getSessionId: () => "fork-reconcile-sid",
      getSessionFile: () => stateFile,
    },
  };
}

const RAW = "raw-marker-alpha ".repeat(40);

// ─── unit: pure filter ──────────────────────────────────────────────────────

test("compressEvidenceIds collects successful compress results only", () => {
  const entries = [
    resultE("r1", "c1"),
    resultE("r2", "c2", true),
    msg("r3", { role: "toolResult", toolName: "read", toolCallId: "c3", content: "" }),
    userE("u1", "hi"),
  ];
  assert.deepEqual([...compressEvidenceIds(entries)], ["c1"]);
});

test("reconcile keeps evidenced and legacy-null-callId blocks, drops unevidenced", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock("b0", { compressCallId: "c1" }), makeBlock("b1"), makeBlock("b2", { compressCallId: "cX" }));
  const rec = reconcileBlocksAgainstBranch(state, [resultE("r1", "c1")], "sid");
  assert.equal(rec.removed, 1);
  assert.deepEqual(rec.state.blocks.map((b: any) => b.blockId), ["b0", "b1"]);
  assert.notEqual(rec.state, state, "changed state is a new object");
});

test("reconcile is a zero-churn identity no-op when every block is evidenced", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock("b0", { compressCallId: "c1" }));
  const rec = reconcileBlocksAgainstBranch(state, [resultE("r1", "c1")], "sid");
  assert.equal(rec.removed, 0);
  assert.equal(rec.state, state, "same object returned → no save churn on healthy sessions");
});

// ─── integration: pi host, implicit parentSession inheritance ──────────────

test("#603: fork before the first compression — raw text survives, future block dropped", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [makeBlock("b0", { compressCallId: "c1", summary: "future-summary-marker" })]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    // Child branch = prefix up to just before the compression + a new turn.
    const entries = [userE("u1", "hello"), asstE("a1", RAW)];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const out = await handlers.get("context")![0]!({
      type: "context",
      messages: [{ role: "user", content: "hello", timestamp: 0 }, { role: "assistant", content: RAW, timestamp: 0 }, { role: "user", content: "new question", timestamp: 0 }],
    }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks.map((b: any) => b.blockId), [], "inherited future block removed and repair persisted");
    const text = JSON.stringify(out.messages);
    assert.ok(text.includes("raw-marker-alpha"), "raw text still present in the outgoing request");
    assert.ok(!text.includes("future-summary-marker"), "no future summary injected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: fork between two compressions — earlier applies, later dropped", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [
      makeBlock("b0", { compressCallId: "c0" }),
      makeBlock("b1", { compressCallId: "c1", directMessageIds: ["a2"], effectiveMessageIds: ["a2"] }),
    ]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    const entries = [userE("u1", "hello"), asstE("a1", RAW), callE("ac0", "c0"), resultE("r0", "c0"), asstE("a2", "mid"), userE("u2", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const out = await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks.map((b: any) => b.blockId), ["b0"], "only the branch-local compression survives");
    const text = JSON.stringify(out.messages);
    assert.ok(text.includes("Compressed block via c0."), "summary carrier of the shared compression is in the request");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: nested fold — removing the consumer resurrects the folded predecessor", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [
      makeBlock("b0", { compressCallId: "c0", active: false }),
      makeBlock("b1", { compressCallId: "c1", active: true, directBlockIds: ["b0"] }),
    ]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    const entries = [userE("u1", "hello"), asstE("a1", RAW), callE("ac0", "c0"), resultE("r0", "c0"), userE("u2", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks.map((b: any) => b.blockId), ["b0"], "consumer b1 removed, predecessor b0 kept");
    assert.equal(sidecar.blocks[0]!.active, true, "syncBlocks resurrects b0 once its consumer is gone and its raws are in view");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: full clone (all compress events shared) — nothing dropped", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [
      makeBlock("b0", { compressCallId: "c0" }),
      makeBlock("b1", { compressCallId: "c1", directMessageIds: ["a2"], effectiveMessageIds: ["a2"] }),
    ]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    const entries = [userE("u1", "hello"), asstE("a1", RAW), callE("ac0", "c0"), resultE("r0", "c0"), asstE("a2", "mid"), callE("ac1", "c1"), resultE("r1", "c1"), userE("u3", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks.map((b: any) => b.blockId), ["b0", "b1"], "clone shares full history → zero removals");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: already-persisted bad child sidecar is repaired and stable across restart", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [makeBlock("b0", { compressCallId: "c0" }), makeBlock("b1", { compressCallId: "c1", directMessageIds: ["a2"], effectiveMessageIds: ["a2"] })]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });
    // What a pre-fix version persisted into the child's own sidecar:
    await writeSidecar(childJsonl, [makeBlock("b0", { compressCallId: "c0" }), makeBlock("b1", { compressCallId: "c1", directMessageIds: ["a2"], effectiveMessageIds: ["a2"] })]);

    const entries = [userE("u1", "hello"), asstE("a1", RAW), callE("ac0", "c0"), resultE("r0", "c0"), asstE("a2", "mid"), userE("u2", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const after = await readSidecar(childJsonl);
    assert.deepEqual(after.blocks.map((b: any) => b.blockId), ["b0"], "own bad sidecar repaired in place");

    const restarted = new SessionStateStore();
    const loaded = await restarted.load(childJsonl, "fork-reconcile-sid");
    assert.deepEqual(loaded.blocks.map((b: any) => b.blockId), ["b0"], "repair survives restart (no re-inheritance loop)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: a FAILED compress does not authorize pruning", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [makeBlock("b1", { compressCallId: "c1" })]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    const entries = [userE("u1", "hello"), asstE("a1", RAW), callE("ac1", "c1"), resultE("r1", "c1", true), userE("u2", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const out = await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks, [], "failed call carries no evidence");
    assert.ok(JSON.stringify(out.messages).includes("raw-marker-alpha"), "raw text kept when its only covering block is unauthorized");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: a compress call WITHOUT a result does not authorize pruning", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [makeBlock("b1", { compressCallId: "c1" })]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    const entries = [userE("u1", "hello"), asstE("a1", RAW), callE("ac1", "c1"), userE("u2", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const out = await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks, [], "missing result carries no evidence");
    assert.ok(JSON.stringify(out.messages).includes("raw-marker-alpha"), "raw text kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: legacy block without compressCallId is kept (fail open)", async () => {
  const dir = await tempDir();
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [makeBlock("bL")]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    const entries = [userE("u1", "hello"), asstE("a1", RAW), userE("u2", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks.map((b: any) => b.blockId), ["bL"], "unverifiable legacy block keeps old behavior");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: declared fork host — live-tail evidence prevents false drop; stale tail filters", async () => {
  const prevForkHost = process.env.PI_ACP_FORK_HOST;
  const dir = await tempDir();
  try {
    process.env.PI_ACP_FORK_HOST = "1";
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(parentJsonl);
    await writeSidecar(parentJsonl, [makeBlock("b0", { compressCallId: "c1" })]);
    await writeHeader(childJsonl, { parentSession: parentJsonl });

    // Persisted branch lags: the compress call+result exist only in the live tail.
    const persisted = [userE("u1", "hello"), asstE("a1", RAW)];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = forkCtx(() => persisted, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

    const liveWithCompress = [
      { role: "user", content: "hello", timestamp: 0 },
      { role: "assistant", content: RAW, timestamp: 0 },
      { role: "assistant", content: [{ type: "toolCall", name: "compress", id: "c1", arguments: {} }], timestamp: 0 },
      { role: "toolResult", toolCallId: "c1", toolName: "compress", isError: false, content: "Compressed block via c1.", timestamp: 0 },
    ];
    await handlers.get("context")![0]!({ type: "context", messages: liveWithCompress }, ctx);
    let sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks.map((b: any) => b.blockId), ["b0"], "block evidenced only in the live tail is NOT dropped");

    // Same branch later, tail shrank back to the prefix (no compress events anywhere):
    await handlers.get("context")![0]!({
      type: "context",
      messages: [{ role: "user", content: "hello", timestamp: 0 }, { role: "assistant", content: RAW, timestamp: 0 }, { role: "user", content: "later question", timestamp: 0 }],
    }, ctx);
    sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks, [], "without any branch-local evidence the foreign block is filtered");
  } finally {
    if (prevForkHost === undefined) delete process.env.PI_ACP_FORK_HOST;
    else process.env.PI_ACP_FORK_HOST = prevForkHost;
    await rm(dir, { recursive: true, force: true });
  }
});

test("#603: explicitly derived children (#364) are exempt from reconciliation", async () => {
  const dir = await tempDir();
  try {
    const childJsonl = path.join(dir, "child.jsonl");
    await writeHeader(childJsonl);
    await writeSidecar(childJsonl, [makeBlock("bF", { compressCallId: "cF" })], { derivedFrom: { parentSessionId: "parent-sid", derivedAt: 123 } });

    const entries = [userE("u1", "hello"), asstE("a1", RAW), userE("u2", "q")];
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const ctx = piCtx(() => entries, childJsonl);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("context")![0]!({ type: "context", messages: [{ role: "user", content: "q", timestamp: 0 }] }, ctx);

    const sidecar = await readSidecar(childJsonl);
    assert.deepEqual(sidecar.blocks.map((b: any) => b.blockId), ["bF"], "derivedFrom marker opts out of branch-evidence filtering");
    assert.ok(sidecar.derivedFrom, "marker itself untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
