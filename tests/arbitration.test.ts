import test from "node:test";
import assert from "node:assert/strict";

import { providerAnchoredTokens } from "../src/arbitration.js";

function assistantEntry(usage?: { input?: number; totalTokens?: number }) {
  return { type: "message", id: "a1", message: { role: "assistant", usage } };
}
function userEntry() {
  return { type: "message", id: "u1", message: { role: "user" } };
}

test("providerAnchoredTokens: returns anchored tokens when last assistant carries usage", () => {
  const entries = [userEntry(), assistantEntry({ input: 8858, totalTokens: 8875 }), userEntry()];
  assert.equal(providerAnchoredTokens({ tokens: 134569 }, entries, false), 134569);
});

test("providerAnchoredTokens: skips non-assistant entries in the back-scan", () => {
  const entries = [assistantEntry({ input: 100 }), userEntry(), userEntry(), { type: "message", id: "t1", message: { role: "toolResult" } }];
  assert.equal(providerAnchoredTokens({ tokens: 5000 }, entries, false), 5000);
});

test("providerAnchoredTokens: usage-less assistant tail falls through to an earlier provider-backed assistant", () => {
  // Tail assistant aborted/error (no usage record) — pi anchors on the earlier
  // good one, so the number is still provider-backed.
  const entries = [assistantEntry({ input: 100 }), userEntry(), assistantEntry(undefined), userEntry()];
  assert.equal(providerAnchoredTokens({ tokens: 45000 }, entries, false), 45000);
});

test("providerAnchoredTokens: omp #18 — no assistant ever reported usage → distrust (tree-sum regime)", () => {
  const entries = [assistantEntry(undefined), userEntry(), assistantEntry({ input: 0 }), userEntry()];
  assert.equal(providerAnchoredTokens({ tokens: 999999 }, entries, false), null);
});

test("providerAnchoredTokens: empty entries → null", () => {
  assert.equal(providerAnchoredTokens({ tokens: 1000 }, [], false), null);
});

test("providerAnchoredTokens: post-compression transient turn → null regardless of anchor", () => {
  const entries = [assistantEntry({ input: 100 }), userEntry()];
  assert.equal(providerAnchoredTokens({ tokens: 134569 }, entries, true), null);
});

test("providerAnchoredTokens: null/zero/non-finite tokens → null (pi cannot anchor)", () => {
  const entries = [assistantEntry({ input: 100 })];
  assert.equal(providerAnchoredTokens(undefined, entries, false), null);
  assert.equal(providerAnchoredTokens({ tokens: null }, entries, false), null);
  assert.equal(providerAnchoredTokens({ tokens: 0 }, entries, false), null);
  assert.equal(providerAnchoredTokens({ tokens: Number.NaN }, entries, false), null);
});

test("providerAnchoredTokens: totalTokens alone counts as provider-backed (OpenAI-style usage)", () => {
  const entries = [assistantEntry({ totalTokens: 8875 })];
  assert.equal(providerAnchoredTokens({ tokens: 8875 }, entries, false), 8875);
});

test("providerAnchoredTokens: all-zero usage record does not count as provider-backed", () => {
  const entries = [assistantEntry({ input: 0, totalTokens: 0 })];
  assert.equal(providerAnchoredTokens({ tokens: 70000 }, entries, false), null);
});
