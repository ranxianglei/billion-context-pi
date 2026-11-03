import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

// Regression (#674): release used to run `locks.delete(sid)` unconditionally,
// wiping the queued successor's chain entry; a caller arriving afterwards saw
// no chain to wait on and entered alongside the current holder.
test("acquireLock: a late arrival waits for the current holder, not a wiped map", async () => {
  const runtime = createRuntime({});
  const sid = "sid-674-interleave";

  const aRelease = await runtime.acquireLock(sid);
  const bAcquire = runtime.acquireLock(sid);
  await tick();
  aRelease();
  const bRelease = await bAcquire;

  const events: string[] = [];
  const cAcquire = runtime.acquireLock(sid).then(async (release) => {
    events.push("c-in");
    await tick();
    events.push("c-out");
    release();
  });
  await tick();
  assert.deepEqual(events, [], "C entered while B still held the lock");

  events.push("b-out");
  bRelease();
  await withTimeout(cAcquire, 2000, "C never acquired the lock");
  assert.deepEqual(events, ["b-out", "c-in", "c-out"], "C must enter only after B released");
});

test("acquireLock: same-tick acquirers run FIFO, one at a time", async () => {
  const runtime = createRuntime({});
  const sid = "sid-674-fifo";
  const order: string[] = [];
  let holders = 0;
  let maxHolders = 0;
  const enter = async (name: string) => {
    const release = await runtime.acquireLock(sid);
    holders += 1;
    maxHolders = Math.max(maxHolders, holders);
    order.push(name);
    await tick();
    holders -= 1;
    release();
  };
  await withTimeout(Promise.all([enter("A"), enter("B"), enter("C")]), 2000, "lock cycle hung");
  assert.deepEqual(order, ["A", "B", "C"]);
  assert.equal(maxHolders, 1);
});

test("acquireLock: repeated queue cycles stay usable (no dead chain left behind)", async () => {
  const runtime = createRuntime({});
  const sid = "sid-674-cycles";
  for (let round = 0; round < 3; round++) {
    const first = await runtime.acquireLock(sid);
    const second = runtime.acquireLock(sid);
    first();
    const secondRelease = await withTimeout(second, 2000, `round ${round}: queued caller hung`);
    const third = runtime.acquireLock(sid);
    secondRelease();
    const thirdRelease = await withTimeout(third, 2000, `round ${round}: late caller hung`);
    thirdRelease();
  }
  const fresh = await withTimeout(runtime.acquireLock(sid), 2000, "fresh acquire hung after cycles");
  fresh();
});
