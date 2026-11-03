import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../src/runtime.js";
import { SessionRegistry } from "../src/session-registry.js";
import { SessionStateStore } from "../src/state.js";

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: 0 } };
}

function liveText(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

// Fork-host shape (PI_ACP_FORK_HOST): getBranch() only, no
// buildContextEntries → isPiHost() false → live-tail caching is active.
function forkCtx(entries: unknown[], sessionId: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
    },
  };
}

function withFakeClock(startMs: number, fn: (advance: (ms: number) => void) => Promise<void>) {
  const realNow = Date.now;
  let t = startMs;
  Date.now = () => t;
  return Promise.resolve(fn((ms) => { t += ms; })).finally(() => { Date.now = realNow; });
}

test("registry evicts sessions idle past the TTL, oldest first", () => {
  const reg = new SessionRegistry({ ttlMs: 10_000, maxTracked: 100 });
  const dropped: string[] = [];
  reg.track((sid) => dropped.push(sid));
  reg.touch("a", 0);
  reg.touch("b", 5_000);
  reg.touch("c", 12_000); // a idle 12s > 10s → evicted; b idle 7s kept
  assert.deepEqual(dropped, ["a"]);
  assert.equal(reg.size, 2);
});

test("registry evicts least recently seen sessions beyond the cap", () => {
  const reg = new SessionRegistry({ ttlMs: Number.MAX_SAFE_INTEGER, maxTracked: 2 });
  const dropped: string[] = [];
  reg.track((sid) => dropped.push(sid));
  reg.touch("a", 0);
  reg.touch("b", 1);
  reg.touch("c", 2); // over cap → oldest (a) goes
  reg.touch("d", 3); // oldest now b
  assert.deepEqual(dropped, ["a", "b"]);
  assert.equal(reg.size, 2);
});

test("registry.drop releases a session once and tolerates unknown sids", () => {
  const reg = new SessionRegistry();
  let calls = 0;
  reg.track(() => { calls++; });
  reg.touch("s");
  reg.drop("s");
  reg.drop("s");
  reg.drop("never-tracked");
  assert.equal(calls, 1);
  assert.equal(reg.size, 0);
});

test("dropSession releases the fork-host live tail cache (#672)", async () => {
  const rt = createRuntime({});
  const branch = [userMsg("e1", "one"), userMsg("e2", "two")];
  const ctx = forkCtx(branch, "sid-a");
  await rt.stateFor(ctx as never, [branch[0]!.message, branch[1]!.message, liveText("three")]);
  const withTail = await rt.stateFor(ctx as never);
  assert.ok(withTail.entries.some((e) => e.id.startsWith("live-")), "tool path replays the cached live tail");
  rt.dropSession(ctx as never);
  const after = await rt.stateFor(ctx as never);
  assert.equal(after.entries.length, branch.length, "tail released after session_shutdown");
  assert.ok(!after.entries.some((e) => e.id.startsWith("live-")));
});

test("idle sessions lose their per-session bookkeeping after the TTL", async () => {
  await withFakeClock(1_000_000, async (advance) => {
    const rt = createRuntime({}, { ttlMs: 30 * 60_000, maxTracked: 1000 });
    const branchA = [userMsg("a1", "alpha")];
    const branchB = [userMsg("b1", "beta")];
    const ctxA = forkCtx(branchA, "sid-a");
    const ctxB = forkCtx(branchB, "sid-b");
    await rt.stateFor(ctxA as never, [branchA[0]!.message, liveText("a-extra")]);
    rt.markNudgeShown("sid-a", "turn-1");
    advance(31 * 60_000);
    await rt.stateFor(ctxB as never, [branchB[0]!.message, liveText("b-extra")]); // evicts A
    const aAfter = await rt.stateFor(ctxA as never);
    assert.equal(aAfter.entries.length, 1, "evicted session loses its cached live tail");
    assert.equal(rt.nudgeShownFor("sid-a", "turn-1"), false, "tracker ledger evicted too");
    const bAfter = await rt.stateFor(ctxB as never);
    assert.equal(bAfter.entries.length, 2, "recently active session keeps its bookkeeping");
  });
});

test("LRU cap bounds tracked sessions even without idle time", async () => {
  await withFakeClock(1_000_000, async (advance) => {
    const rt = createRuntime({}, { ttlMs: Number.MAX_SAFE_INTEGER, maxTracked: 2 });
    const mk = (id: string) => {
      const branch = [userMsg(`${id}-1`, id)];
      return { branch, ctx: forkCtx(branch, id), live: [branch[0]!.message, liveText(`${id}-extra`)] };
    };
    const a = mk("sid-a");
    advance(1);
    const b = mk("sid-b");
    advance(1);
    const c = mk("sid-c");
    advance(1);
    await rt.stateFor(a.ctx as never, a.live);
    advance(1);
    await rt.stateFor(b.ctx as never, b.live);
    advance(1);
    await rt.stateFor(c.ctx as never, c.live); // cap 2 → oldest (a) evicted
    const aAfter = await rt.stateFor(a.ctx as never);
    assert.equal(aAfter.entries.length, 1, "oldest session's live tail evicted by the cap");
    const cAfter = await rt.stateFor(c.ctx as never);
    assert.equal(cAfter.entries.length, 2, "recently used session keeps its tail");
  });
});

test("store.sweepIdle frees idle file-backed slots losslessly but never file-less ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-sweep-"));
  try {
    const jsonl = path.join(dir, "s.jsonl");
    const jsonlFresh = path.join(dir, "f.jsonl");
    await writeFile(jsonl, JSON.stringify({ type: "session", version: 3, id: "sid-x" }) + "\n", "utf8");
    await writeFile(jsonlFresh, JSON.stringify({ type: "session", version: 3, id: "sid-f" }) + "\n", "utf8");
    const store = new SessionStateStore();
    await withFakeClock(1_000_000, async (advance) => {
      const first = await store.load(jsonl, "sid-x");
      first.stats.tokensCompressed = 123;
      advance(31 * 60_000);
      store.sweepIdle(30 * 60_000);
      const second = await store.load(jsonl, "sid-x");
      assert.notEqual(first, second, "stale slot evicted — fresh parse on next load");
      assert.equal(second.stats.tokensCompressed, 0, "reload comes from the sidecar, not the stale copy");

      const fresh = await store.load(jsonlFresh, "sid-f");
      advance(29 * 60_000);
      store.sweepIdle(30 * 60_000);
      assert.equal(await store.load(jsonlFresh, "sid-f"), fresh, "slot under the TTL survives");

      const mem = await store.load(undefined, "mem-sid");
      mem.stats.tokensCompressed = 456;
      advance(31 * 60_000);
      store.sweepIdle(30 * 60_000);
      assert.equal(await store.load(undefined, "mem-sid"), mem, "file-less slot survives the sweep (#322)");

      await store.save(second, jsonl, "sid-x");
      store.drop(jsonl, "sid-x");
      const third = await store.load(jsonl, "sid-x");
      assert.notEqual(third, second, "explicit drop releases the slot immediately");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
