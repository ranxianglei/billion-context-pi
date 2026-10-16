import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSyncResult, genuineNoOutput } from "../src/delegate-tool.js";

function result(over: Partial<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }>) {
  return { code: 0, signal: null as NodeJS.Signals | null, stdout: "", stderr: "", timedOut: false, ...over };
}

test("genuineNoOutput: true only for a real exit-0 run with zero reply text", () => {
  assert.equal(genuineNoOutput(0, false, ""), true);
  assert.equal(genuineNoOutput(0, false, "   \n\t"), true);
  assert.equal(genuineNoOutput(0, false, "done"), false);
  assert.equal(genuineNoOutput(1, false, ""), false);
  assert.equal(genuineNoOutput(null, false, ""), false, "watchdog kill (code null) is owned by the existing failure path");
  assert.equal(genuineNoOutput(0, true, ""), false, "timeouts keep their own 'timed out' label");
});

test("formatSyncResult: exit 0 + empty stdout is FAILED with the no-final-output diagnostic", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ stdout: "" }), "/out.out");
  assert.match(out, /FAILED ⚠️/);
  assert.match(out, /NO final reply text/);
  assert.doesNotMatch(out, /completed/);
});

test("formatSyncResult: normal completed run keeps the plain payload", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ stdout: "the answer" }), "/out.out");
  assert.match(out, /completed/);
  assert.doesNotMatch(out, /FAILED/);
  assert.doesNotMatch(out, /NO final reply text/);
});

test("formatSyncResult: nonzero exit stays on the stderr failure path", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ code: 1, stderr: "boom" }), "/out.out");
  assert.match(out, /FAILED ⚠️/);
  assert.match(out, /boom/);
  assert.doesNotMatch(out, /NO final reply text/);
});

test("formatSyncResult: watchdog timeout label is untouched by the no-output rule", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ code: null, timedOut: true }), "/out.out");
  assert.match(out, /timed out/);
  assert.doesNotMatch(out, /NO final reply text/);
});
