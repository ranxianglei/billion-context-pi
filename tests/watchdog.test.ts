import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachWatchdogs } from "../src/delegate-watchdog.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  stdout: EventEmitter;
  kills: NodeJS.Signals[];
  reasons: string[];
  eofGraceCount: number;
  settled: () => boolean;
  settle: () => void;
  watchdog: ReturnType<typeof attachWatchdogs>;
}

function setup(overrides?: { idleMs?: number; timeoutMs?: number; killGraceMs?: number; eofGraceMs?: number; initiallySettled?: boolean }): Harness {
  const stdout = new EventEmitter();
  const kills: NodeJS.Signals[] = [];
  const reasons: string[] = [];
  let eofGraceCount = 0;
  let settledFlag = overrides?.initiallySettled ?? false;
  const watchdog = attachWatchdogs(
    {
      kill: (sig) => {
        kills.push(sig);
        return true;
      },
      stdout,
    },
    {
      isSettled: () => settledFlag,
      onKill: (reason) => reasons.push(reason),
      onEofGrace: () => {
        eofGraceCount += 1;
      },
    },
    {
      eofGraceMs: overrides?.eofGraceMs ?? 1_000,
      idleMs: overrides?.idleMs ?? 1_000,
      timeoutMs: overrides?.timeoutMs ?? 60_000,
      killGraceMs: overrides?.killGraceMs ?? 1_000,
    },
  );
  return {
    stdout,
    kills,
    reasons,
    get eofGraceCount() {
      return eofGraceCount;
    },
    settled: () => settledFlag,
    settle: () => {
      settledFlag = true;
    },
    watchdog,
  };
}

test("idle watchdog kills with SIGTERM after idleMs without output", async () => {
  const h = setup({ idleMs: 30, killGraceMs: 200 });
  await sleep(60);
  assert.deepEqual(h.kills, ["SIGTERM"], "SIGTERM fired once");
  assert.equal(h.reasons.length, 1, "onKill called once");
  assert.ok(h.reasons[0].includes("no output"), `reason names idle: ${h.reasons[0]}`);
  h.watchdog.dispose();
});

test("idle watchdog escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const h = setup({ idleMs: 20, killGraceMs: 30 });
  await sleep(100);
  assert.deepEqual(h.kills, ["SIGTERM", "SIGKILL"], "SIGTERM then SIGKILL");
  h.watchdog.dispose();
});

test("poke resets the idle timer (continuous output never triggers)", async () => {
  const h = setup({ idleMs: 200 });
  for (let i = 0; i < 10; i++) {
    await sleep(50);
    h.watchdog.poke();
  }
  assert.equal(h.kills.length, 0, "no kill while output keeps flowing");
  h.watchdog.dispose();
});

test("EOF grace force-finalizes when stdout ended but the child lives", async () => {
  const h = setup({ eofGraceMs: 30 });
  h.stdout.emit("end");
  await sleep(60);
  assert.equal(h.eofGraceCount, 1, "onEofGrace fired once");
  h.watchdog.dispose();
});

test("hard time limit kills regardless of output", async () => {
  const h = setup({ timeoutMs: 40 });
  await sleep(80);
  assert.deepEqual(h.kills, ["SIGTERM"], "time limit fired");
  assert.ok(h.reasons[0].includes("limit"), `reason names limit: ${h.reasons[0]}`);
  h.watchdog.dispose();
});

test("dispose stops all watchdogs", async () => {
  const h = setup({ idleMs: 30, eofGraceMs: 30 });
  h.watchdog.dispose();
  h.stdout.emit("end");
  await sleep(80);
  assert.equal(h.kills.length, 0, "no kill after dispose");
  assert.equal(h.eofGraceCount, 0, "no EOF grace after dispose");
});

test("settled runs never get killed or grace-finalized", async () => {
  const h = setup({ idleMs: 20, eofGraceMs: 20, initiallySettled: true });
  h.stdout.emit("end");
  await sleep(60);
  assert.equal(h.kills.length, 0, "settled run not killed");
  assert.equal(h.eofGraceCount, 0, "settled run not grace-finalized");
});

test("settledGrace kills with SIGTERM when the process does not exit in time", async () => {
  const h = setup({ killGraceMs: 200 });
  h.watchdog.settledGrace(30, 200, "agent settled but process did not exit");
  await sleep(60);
  assert.deepEqual(h.kills, ["SIGTERM"], "SIGTERM fired once");
  assert.equal(h.reasons.length, 1, "onKill called once");
  assert.equal(h.reasons[0], "agent settled but process did not exit", "reason forwarded");
  h.watchdog.dispose();
});

test("settledGrace escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const h = setup({ killGraceMs: 30 });
  h.watchdog.settledGrace(20, 30, "agent settled but process did not exit");
  await sleep(100);
  assert.deepEqual(h.kills, ["SIGTERM", "SIGKILL"], "SIGTERM then SIGKILL");
  h.watchdog.dispose();
});

test("settledGrace does nothing when the run is already settled", async () => {
  const h = setup({ initiallySettled: true, killGraceMs: 200 });
  h.watchdog.settledGrace(20, 200, "agent settled but process did not exit");
  await sleep(60);
  assert.equal(h.kills.length, 0, "settled run not killed");
  h.watchdog.dispose();
});

test("settledGrace is idempotent (only one timer is armed)", async () => {
  const h = setup({ killGraceMs: 200 });
  h.watchdog.settledGrace(30, 200, "first");
  h.watchdog.settledGrace(30, 200, "second");
  await sleep(60);
  assert.deepEqual(h.kills, ["SIGTERM"], "single SIGTERM despite double call");
  assert.equal(h.reasons.length, 1, "single onKill");
  assert.equal(h.reasons[0], "first", "first reason wins");
  h.watchdog.dispose();
});

test("dispose clears a pending settledGrace timer", async () => {
  const h = setup({ killGraceMs: 200 });
  h.watchdog.settledGrace(30, 200, "agent settled but process did not exit");
  h.watchdog.dispose();
  await sleep(80);
  assert.equal(h.kills.length, 0, "no kill after dispose");
});

test("settle before the grace fires stops the kill (normal exit path)", async () => {
  const h = setup({ killGraceMs: 200 });
  h.watchdog.settledGrace(200, 200, "agent settled but process did not exit");
  await sleep(30);
  h.settle();
  await sleep(220);
  assert.equal(h.kills.length, 0, "no kill once settled before grace");
  h.watchdog.dispose();
});
