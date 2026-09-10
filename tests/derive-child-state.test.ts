import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { activeBlocks, blockById, createInitialState, type CompressionBlock, type CompressionState } from "acp-kernel";
import { SessionStateStore, deriveChildState } from "../src/state.js";
import { createRuntime } from "../src/runtime.js";

function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "acp-child-"));
}

function makeBlock(id: string, active = true): CompressionBlock {
  return { blockId: id, runId: 0, tier: 1, generation: "young", active, summary: `summary ${id}`, directMessageIds: ["msg-a"], effectiveMessageIds: ["msg-a"], survivedCount: 1, createdAt: Date.now() };
}

function makeParentState(): CompressionState {
  const s = createInitialState();
  s.blocks.push(makeBlock("b0"), makeBlock("b1", false));
  s.nextBlockId = 3;
  s.nextRunId = 7;
  s.messageRefs.byRaw["msg-a"] = "m00001";
  s.messageRefs.byRef["m00001"] = "msg-a";
  s.tokenSnapshot["m00001"] = 1234;
  s.nudge.baselineTokens = 5000;
  s.nudge.lastShownByTier[1] = 4000;
  s.stats.tokensCompressed = 999;
  s.stats.compressionCount = 2;
  return s;
}

test("deriveChildState inherits blocks deep-copied (no shared mutation)", () => {
  const parent = makeParentState();
  const child = deriveChildState(parent);

  assert.equal(child.blocks.length, 2);
  assert.deepEqual(child.blocks.map((b) => b.blockId), ["b0", "b1"]);
  assert.equal(child.blocks[0]!.summary, "summary b0");
  assert.notEqual(child.blocks[0], parent.blocks[0], "blocks must be copied, not shared");
  child.blocks[0]!.survivedCount = 99;
  assert.equal(parent.blocks[0]!.survivedCount, 1, "child mutation must not leak into parent");
  parent.blocks[1]!.active = false;
  assert.equal(child.blocks[1]!.active, false);
});

test("deriveChildState inherits message refs and token snapshot as copies", () => {
  const parent = makeParentState();
  const child = deriveChildState(parent);

  assert.equal(child.messageRefs.byRaw["msg-a"], "m00001");
  assert.equal(child.messageRefs.byRef["m00001"], "msg-a");
  assert.equal(child.tokenSnapshot["m00001"], 1234);
  assert.notEqual(child.messageRefs, parent.messageRefs);
  assert.notEqual(child.tokenSnapshot, parent.tokenSnapshot);
  child.messageRefs.byRaw["msg-x"] = "m00002";
  assert.equal(parent.messageRefs.byRaw["msg-x"], undefined, "ref-map mutation must not leak into parent");
});

test("deriveChildState carries the id counters so new blocks cannot collide", () => {
  const child = deriveChildState(makeParentState());
  assert.equal(child.nextBlockId, 3);
  assert.equal(child.nextRunId, 7);
});

test("deriveChildState resets every rhythm ledger", () => {
  const child = deriveChildState(makeParentState());
  const fresh = createInitialState();
  assert.deepEqual(child.nudge, fresh.nudge, "nudge cadence baseline must restart");
  assert.deepEqual(child.stats, fresh.stats, "stats counters must restart");
  assert.deepEqual(child.absorbed, []);
});

test("inherited blocks stay usable by kernel lookups (decompress/search viability)", () => {
  const child = deriveChildState(makeParentState());
  assert.deepEqual(activeBlocks(child).map((b) => b.blockId), ["b0"], "only inherited ACTIVE blocks surface");
  assert.equal(blockById(child, "b1")?.summary, "summary b1");
});

test("empty parent derives to a pristine initial state", () => {
  assert.deepEqual(deriveChildState(createInitialState()), createInitialState());
});

// ── Runtime orchestration (marker + guards + persistence) ──────────────────

async function writeSessionHeader(file: string, opts: { parentSession?: string } = {}) {
  const header = { type: "session", version: 3, id: "test-sid", timestamp: new Date().toISOString(), cwd: "/tmp", ...opts };
  await writeFile(file, JSON.stringify(header) + "\n", "utf8");
}

test("runtime.deriveChildState: derives, persists marker, resets rhythm on disk", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");
  await writeSessionHeader(parentJsonl);
  await writeSessionHeader(childJsonl);

  const store = new SessionStateStore();
  await store.save(makeParentState(), parentJsonl, "parent-sid");
  const runtime = createRuntime({});

  const derived = await runtime.deriveChildState(
    { sessionId: "child-sid", sessionFile: childJsonl },
    { sessionId: "parent-sid", sessionFile: parentJsonl },
  );
  assert.equal(derived, true);

  const raw = JSON.parse(await readFile(`${childJsonl}.acp.json`, "utf8")) as {
    blocks: unknown[];
    nextBlockId: number;
    nudge: { baselineTokens: number };
    stats: { tokensCompressed: number };
    derivedFrom?: { parentSessionId: string; derivedAt: number };
  };
  assert.equal(raw.blocks.length, 2, "blocks persisted into the independent child sidecar");
  assert.equal(raw.nextBlockId, 3);
  assert.equal(raw.nudge.baselineTokens, 0, "rhythm baseline reset in persisted state");
  assert.equal(raw.stats.tokensCompressed, 0);
  assert.ok(raw.derivedFrom, "one-time derivation marker persisted");
  assert.equal(raw.derivedFrom.parentSessionId, "parent-sid");
  assert.equal(typeof raw.derivedFrom.derivedAt, "number");

  const reloaded = new SessionStateStore();
  const state = await reloaded.load(childJsonl, "child-sid");
  assert.equal(state.blocks.length, 2);
  assert.equal(state.nudge.baselineTokens, 0);
  assert.equal(reloaded.getDerivedFrom(childJsonl, "child-sid")?.parentSessionId, "parent-sid");
  await rm(dir, { recursive: true, force: true });
});

test("runtime.deriveChildState is one-time: second call refused", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");
  await writeSessionHeader(parentJsonl);
  await writeSessionHeader(childJsonl);

  const store = new SessionStateStore();
  await store.save(makeParentState(), parentJsonl, "parent-sid");
  const runtime = createRuntime({});
  const child = { sessionId: "child-sid", sessionFile: childJsonl };
  const parent = { sessionId: "parent-sid", sessionFile: parentJsonl };

  assert.equal(await runtime.deriveChildState(child, parent), true);
  assert.equal(await runtime.deriveChildState(child, parent), false, "marker present → no re-derivation");
  const state = await runtime.store.load(childJsonl, "child-sid");
  assert.equal(state.blocks.length, 2, "state untouched by the refused call");
  await rm(dir, { recursive: true, force: true });
});

test("runtime.deriveChildState refuses when the child owns real blocks", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");
  await writeSessionHeader(parentJsonl);
  await writeSessionHeader(childJsonl);

  const store = new SessionStateStore();
  await store.save(makeParentState(), parentJsonl, "parent-sid");
  const own = createInitialState();
  own.blocks.push(makeBlock("b-own"));
  own.nextBlockId = 2;
  await store.save(own, childJsonl, "child-sid");

  const runtime = createRuntime({});
  const derived = await runtime.deriveChildState(
    { sessionId: "child-sid", sessionFile: childJsonl },
    { sessionId: "parent-sid", sessionFile: parentJsonl },
  );
  assert.equal(derived, false, "never clobber real self-compressed history");
  const state = await runtime.store.load(childJsonl, "child-sid");
  assert.deepEqual(state.blocks.map((b) => b.blockId), ["b-own"]);
  assert.equal(runtime.store.getDerivedFrom(childJsonl, "child-sid"), null);
  await rm(dir, { recursive: true, force: true });
});

test("runtime.deriveChildState refuses when the parent has no blocks", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");
  await writeSessionHeader(parentJsonl);
  await writeSessionHeader(childJsonl);

  const store = new SessionStateStore();
  await store.save(createInitialState(), parentJsonl, "parent-sid");
  const runtime = createRuntime({});
  const derived = await runtime.deriveChildState(
    { sessionId: "child-sid", sessionFile: childJsonl },
    { sessionId: "parent-sid", sessionFile: parentJsonl },
  );
  assert.equal(derived, false);
  assert.equal(runtime.store.getDerivedFrom(childJsonl, "child-sid"), null);
  await rm(dir, { recursive: true, force: true });
});

test("runtime.deriveChildState refuses file-less (in-memory) children", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  await writeSessionHeader(parentJsonl);

  const store = new SessionStateStore();
  await store.save(makeParentState(), parentJsonl, "parent-sid");
  const runtime = createRuntime({});
  const derived = await runtime.deriveChildState(
    { sessionId: "in-memory-child" },
    { sessionId: "parent-sid", sessionFile: parentJsonl },
  );
  assert.equal(derived, false, "in-memory sessions have no sidecar to persist the derivation into");
  await rm(dir, { recursive: true, force: true });
});

// The Prime RLM case: pi writes a parentSession header into inline sub-agent
// session files too, so load() auto-inherits the parent VERBATIM (old behavior,
// rhythm included). An explicit derivation must upgrade that implicit state to
// inherit-blocks/reset-rhythm semantics exactly once.
test("explicit derivation upgrades implicit header inheritance (inline sub-agent case)", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");
  await writeSessionHeader(parentJsonl);
  await writeSessionHeader(childJsonl, { parentSession: parentJsonl });

  const store = new SessionStateStore();
  await store.save(makeParentState(), parentJsonl, "parent-sid");

  const implicit = await store.load(childJsonl, "child-sid");
  assert.equal(implicit.blocks.length, 2, "header inheritance kicks in first (pi-native path)");
  assert.equal(implicit.nudge.baselineTokens, 5000, "verbatim inheritance carries parent rhythm — the #364 gap");

  const runtime = createRuntime({});
  const derived = await runtime.deriveChildState(
    { sessionId: "child-sid", sessionFile: childJsonl },
    { sessionId: "parent-sid", sessionFile: parentJsonl },
  );
  assert.equal(derived, true, "explicit derivation wins over implicit header inheritance");

  store.invalidate();
  const after = await store.load(childJsonl, "child-sid");
  assert.equal(after.blocks.length, 2, "blocks still inherited");
  assert.equal(after.nudge.baselineTokens, 0, "rhythm restarted");
  assert.equal(store.getDerivedFrom(childJsonl, "child-sid")?.parentSessionId, "parent-sid");
  await rm(dir, { recursive: true, force: true });
});
