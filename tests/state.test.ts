import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStateStore, pruneStaleRefs } from "../src/state.js";
import { createInitialState, assignRefs, highestUsedIndex } from "acp-kernel";

function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "acp-state-"));
}

test("load returns fresh state when no file exists", async () => {
  const dir = await tempDir();
  const store = new SessionStateStore();
  const state = await store.load(path.join(dir, "session.json"), "sid-1");
  assert.deepEqual(state.blocks, []);
  assert.equal(state.nextBlockId, 1, "fresh state starts nextBlockId at 1");
  await rm(dir, { recursive: true, force: true });
});

test("save then load round-trips state", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "session.json");
  const store = new SessionStateStore();
  const before = createInitialState();
  before.blocks.push({
    blockId: "b0",
    runId: 0,
    tier: 1,
    generation: "young",
    active: true,
    summary: "alpha",
    directMessageIds: ["a", "b"],
    effectiveMessageIds: ["a", "b"],
    survivedCount: 1,
    createdAt: 100,
  });
  before.nextBlockId = 1;
  before.messageRefs.nextRef = 2;
  before.messageRefs.byRaw.a = "m00000";
  before.messageRefs.byRef.m00000 = "a";

  await store.save(before, file, "sid");
  const store2 = new SessionStateStore();
  const after = await store2.load(file, "sid");

  assert.equal(after.blocks.length, 1);
  assert.equal(after.blocks[0]!.blockId, "b0");
  assert.equal(after.nextBlockId, 1);
  assert.equal(after.messageRefs.byRef.m00000, "a");
  await rm(dir, { recursive: true, force: true });
});

test("load merges forward-compat: missing fields filled from fresh state", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "session.json");
  // The store persists to `{sessionFile}.acp.json`; write a minimal legacy file there.
  const minimal = { blocks: [{ blockId: "b0", active: true }], nextBlockId: 1 };
  const { promises: fs } = await import("node:fs");
  await fs.writeFile(`${file}.acp.json`, JSON.stringify(minimal), "utf8");

  const store = new SessionStateStore();
  const state = await store.load(file, "sid");
  assert.equal(state.blocks.length, 1);
  assert.equal(state.nudge.lastPerMessageNudgeTokens, 0, "nudge backfilled");
  assert.ok(state.messageRefs.byRaw, "messageRefs backfilled");
  await rm(dir, { recursive: true, force: true });
});

test("pruneStaleRefs drops dead mappings but keeps block-referenced refs", () => {
  const state = createInitialState();
  state.messageRefs.byRaw = {
    alive: "m00001",
    dead: "m00002",
    inBlock: "m00003",
  };
  state.messageRefs.byRef = { m00001: "alive", m00002: "dead", m00003: "inBlock" };
  state.blocks = [{ blockId: "b0", effectiveMessageIds: ["inBlock"] }] as CompressionState["blocks"];
  const nextRefBefore = state.messageRefs.nextRef;

  pruneStaleRefs(state, ["alive"]);

  assert.deepEqual(state.messageRefs.byRaw, { alive: "m00001", inBlock: "m00003" });
  assert.deepEqual(state.messageRefs.byRef, { m00001: "alive", m00003: "inBlock" });
  assert.equal(state.messageRefs.nextRef, nextRefBefore, "ref numbering stays monotonic");
});

test("pruneStaleRefs keeps the highest ref so new refs stay monotonic", () => {
  const state = createInitialState();
  state.messageRefs.byRaw = { alive: "m00001", staleMid: "m00005", staleHigh: "m00009" };
  state.messageRefs.byRef = { m00001: "alive", m00005: "staleMid", m00009: "staleHigh" };
  pruneStaleRefs(state, ["alive"]);
  assert.deepEqual(state.messageRefs.byRaw, { alive: "m00001", staleHigh: "m00009" });
  const result = assignRefs([{ id: "fresh", role: "user", contentType: "text" }], {
    existing: state.messageRefs,
    nextIndex: highestUsedIndex(state.messageRefs) + 1,
  });
  assert.equal(result.map.byRaw.fresh, "m00010", "new ref never reuses a dropped number");
});

test("invalidate forces a fresh read after save", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "session.json");
  const store = new SessionStateStore();
  const s1 = createInitialState();
  s1.nextBlockId = 5;
  await store.save(s1, file, "sid");

  store.invalidate();
  const reloaded = await store.load(file, "sid");
  assert.equal(reloaded.nextBlockId, 5);
  await rm(dir, { recursive: true, force: true });
});
