import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatCompactTokens,
  initFooterStatus,
  updateFooterStatus,
  disposeFooterStatus,
} from "../src/footer-status.js";
import { addDelegateUsage, resetDelegateUsage } from "../src/delegate-tool.js";
import type { Usage } from "../src/delegate-events.js";

const USAGE: Usage = {
  input: 11549,
  output: 31,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 11580,
  cost: { input: 0.001, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.0016 },
};

interface MockUi {
  calls: Array<[string, string | undefined]>;
  ctx: ExtensionContext;
}

function makeMock(): MockUi {
  const calls: Array<[string, string | undefined]> = [];
  const ui = {
    setStatus: (key: string, text: string | undefined) => {
      calls.push([key, text]);
    },
  };
  return { calls, ctx: { ui, mode: "tui" } as unknown as ExtensionContext };
}

test("formatCompactTokens matches pi formatTokens at every boundary", () => {
  assert.equal(formatCompactTokens(999), "999");
  assert.equal(formatCompactTokens(1000), "1.0k");
  assert.equal(formatCompactTokens(9999), "10.0k");
  assert.equal(formatCompactTokens(10000), "10k");
  assert.equal(formatCompactTokens(999999), "1000k");
  assert.equal(formatCompactTokens(1000000), "1.0M");
  assert.equal(formatCompactTokens(9999999), "10.0M");
  assert.equal(formatCompactTokens(10000000), "10M");
});

test("updateFooterStatus renders cumulative delegate usage and dedupes", () => {
  const mock = makeMock();
  resetDelegateUsage();
  addDelegateUsage(USAGE);
  initFooterStatus(mock.ctx);
  updateFooterStatus();
  assert.deepEqual(mock.calls, [["billion-context-pi", "sub-agents \u219112k \u219331 ($0.0016)"]]);
  updateFooterStatus();
  assert.equal(mock.calls.length, 1, "unchanged text does not re-set status");
  disposeFooterStatus();
});

test("updateFooterStatus clears the status when there is no usage", () => {
  const mock = makeMock();
  resetDelegateUsage();
  initFooterStatus(mock.ctx);
  updateFooterStatus();
  assert.deepEqual(mock.calls, [["billion-context-pi", undefined]]);
  disposeFooterStatus();
});

test("updateFooterStatus clears the status when totalTokens is zero", () => {
  const mock = makeMock();
  resetDelegateUsage();
  addDelegateUsage({ ...USAGE, totalTokens: 0 });
  initFooterStatus(mock.ctx);
  updateFooterStatus();
  assert.deepEqual(mock.calls, [["billion-context-pi", undefined]]);
  disposeFooterStatus();
});

test("disposeFooterStatus clears the status and detaches ui", () => {
  const mock = makeMock();
  resetDelegateUsage();
  addDelegateUsage(USAGE);
  initFooterStatus(mock.ctx);
  disposeFooterStatus();
  assert.deepEqual(mock.calls, [["billion-context-pi", undefined]], "dispose clears the status");
  updateFooterStatus();
  assert.equal(mock.calls.length, 1, "no setStatus after dispose");
});

test("updateFooterStatus does not churn setStatus across repeated empty ticks", () => {
  const mock = makeMock();
  resetDelegateUsage();
  initFooterStatus(mock.ctx);
  updateFooterStatus();
  updateFooterStatus();
  updateFooterStatus();
  assert.equal(mock.calls.length, 1, "repeated empty ticks setStatus once (dedup)");
  assert.deepEqual(mock.calls[0], ["billion-context-pi", undefined]);
  addDelegateUsage(USAGE);
  updateFooterStatus();
  updateFooterStatus();
  assert.equal(mock.calls.length, 2, "usage change fires once more then dedups");
  assert.deepEqual(mock.calls[1], ["billion-context-pi", "sub-agents \u219112k \u219331 ($0.0016)"]);
  disposeFooterStatus();
});
