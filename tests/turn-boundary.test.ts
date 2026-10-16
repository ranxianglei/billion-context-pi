import { test } from "node:test";
import assert from "node:assert/strict";
import { ACP_STATUS_CUSTOM_TYPE, isCustomMessageEntry } from "../src/messages.js";
import {
  isTurnBoundary,
  lastTurnBoundaryId,
  lastTurnBoundaryIndex,
  type TurnBoundaryEntry,
} from "../src/turn-boundary.js";

const user = (id: string): TurnBoundaryEntry => ({ type: "message", id, message: { role: "user" } });
const assistant = (id: string): TurnBoundaryEntry => ({ type: "message", id, message: { role: "assistant" } });
const toolResult = (id: string): TurnBoundaryEntry => ({ type: "message", id, message: { role: "toolResult" } });
const custom = (id: string, content = "injected agent turn"): TurnBoundaryEntry => ({ type: "custom_message", id, content });
const statusPanel = (id: string): TurnBoundaryEntry => ({ type: "custom_message", id, customType: ACP_STATUS_CUSTOM_TYPE, content: "panel" });

test("isTurnBoundary: user-role entries always start a turn", () => {
  assert.equal(isTurnBoundary(user("m00001")), true);
  assert.equal(isTurnBoundary(user("m00001"), { countCustomMessages: true }), true);
});

test("isTurnBoundary: assistant/toolResult entries never start a turn", () => {
  assert.equal(isTurnBoundary(assistant("m00002")), false);
  assert.equal(isTurnBoundary(toolResult("m00003"), { countCustomMessages: true }), false);
});

test("isTurnBoundary: injected custom_message starts a turn only under policy", () => {
  assert.equal(isTurnBoundary(custom("m00004")), false, "default = pi-native");
  assert.equal(isTurnBoundary(custom("m00004"), { countCustomMessages: false }), false);
  assert.equal(isTurnBoundary(custom("m00004"), { countCustomMessages: true }), true);
});

test("isTurnBoundary: acp-status panels never start a turn, even under policy", () => {
  assert.equal(isTurnBoundary(statusPanel("m00005")), false);
  assert.equal(isTurnBoundary(statusPanel("m00005"), { countCustomMessages: true }), false);
});

test("isTurnBoundary: non-message entries without a message field are not boundaries", () => {
  assert.equal(isTurnBoundary({ type: "compaction", id: "x" }, { countCustomMessages: true }), false);
});

test("isCustomMessageEntry: matches the context-projection condition exactly", () => {
  assert.equal(isCustomMessageEntry(custom("a")), true);
  assert.equal(isCustomMessageEntry(statusPanel("b")), false);
  assert.equal(isCustomMessageEntry(user("c")), false);
});

test("isCustomMessageEntry: empty content never enters context, so never counts (#364 c)", () => {
  assert.equal(isCustomMessageEntry(custom("e1", "")), false);
  assert.equal(isCustomMessageEntry(custom("e2", [{ type: "image" }])), false);
  assert.equal(isTurnBoundary(custom("e1", ""), { countCustomMessages: true }), false, "empty control signal starts no turn even under policy");
});

// Interleaved battery covering every entry kind, used for the cross-view
// consistency assertions below (acceptance: the three former call sites must
// agree on where the current turn starts).
const BATTERY: TurnBoundaryEntry[] = [
  user("u1"),
  assistant("a1"),
  custom("c1"),
  toolResult("t1"),
  statusPanel("s1"),
  user("u2"),
  custom("c2"),
];

// The pre-#364 rule, kept verbatim as the regression oracle: pi-native
// behavior counts only genuine user-role messages.
function legacyLastUserId(entries: readonly TurnBoundaryEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.message?.role === "user") return entries[i]!.id;
  }
  return undefined;
}

function legacyLastUserIndex(entries: readonly TurnBoundaryEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.message?.role === "user") return i;
  }
  return -1;
}

test("consistency: id view and index view of the boundary agree for both policies", () => {
  for (const policy of [undefined, { countCustomMessages: true }] as const) {
    const idx = lastTurnBoundaryIndex(BATTERY, policy);
    const id = lastTurnBoundaryId(BATTERY, policy);
    assert.ok(idx >= 0);
    assert.equal(id, BATTERY[idx]?.id, `policy=${JSON.stringify(policy)}: id/index views must agree`);
  }
});

test("regression: default policy is byte-for-byte the legacy user-role-only scan", () => {
  assert.equal(lastTurnBoundaryId(BATTERY), legacyLastUserId(BATTERY));
  assert.equal(lastTurnBoundaryIndex(BATTERY), legacyLastUserIndex(BATTERY));
  assert.equal(lastTurnBoundaryId([], undefined), undefined);
  assert.equal(lastTurnBoundaryIndex([], undefined), -1);
});

test("policy on: the latest injected custom_message becomes the boundary", () => {
  assert.equal(lastTurnBoundaryId(BATTERY, { countCustomMessages: true }), "c2");
  assert.equal(lastTurnBoundaryIndex(BATTERY, { countCustomMessages: true }), BATTERY.findIndex((e) => e.id === "c2"));
});

// Prime's genuine host-turn injection types (#578).
const PRIME_TURN_TYPES = ["agent_message", "async_bash_completion", "rlm_child_terminal_notice", "heartbeat_prompt"];
const typed = (id: string, customType: string, content = "injected"): TurnBoundaryEntry => ({ type: "custom_message", id, customType, content });

test("isTurnBoundary: customMessageTypes allowlist refines the opt-in (#578)", () => {
  const policy = { countCustomMessages: true, customMessageTypes: PRIME_TURN_TYPES };
  for (const t of PRIME_TURN_TYPES) {
    assert.equal(isTurnBoundary(typed("a1", t), policy), true, `${t} is a real host turn`);
  }
  assert.equal(isTurnBoundary(typed("d1", "harness_digest"), policy), false, "metadata injection starts no turn");
  assert.equal(isTurnBoundary(typed("s1", "ipython_state"), policy), false);
  assert.equal(isTurnBoundary(custom("b1"), policy), false, "entry without customType never matches an allowlist");
});

test("isTurnBoundary: allowlist alone does not opt in (#578)", () => {
  assert.equal(isTurnBoundary(typed("a1", "agent_message"), { customMessageTypes: PRIME_TURN_TYPES }), false);
});

test("isTurnBoundary: UI-only types stay excluded even when listed in the allowlist (#578)", () => {
  assert.equal(isTurnBoundary(statusPanel("p1"), { countCustomMessages: true, customMessageTypes: [ACP_STATUS_CUSTOM_TYPE] }), false);
});

test("issue #578 repro: harness_digest no longer resets the boundary", () => {
  const entries: TurnBoundaryEntry[] = [user("u1"), typed("a1", "agent_message"), typed("d1", "harness_digest")];
  assert.equal(lastTurnBoundaryId(entries, { countCustomMessages: true }), "d1", "pre-#578 behavior: every non-empty injection counts");
  assert.equal(lastTurnBoundaryId(entries, { countCustomMessages: true, customMessageTypes: PRIME_TURN_TYPES }), "a1");
  assert.equal(lastTurnBoundaryIndex(entries, { countCustomMessages: true, customMessageTypes: PRIME_TURN_TYPES }), 1);
});

test("consistency: id view and index view agree under an allowlist policy (#578)", () => {
  const policy = { countCustomMessages: true, customMessageTypes: ["agent_message"] };
  const idx = lastTurnBoundaryIndex(BATTERY, policy);
  assert.ok(idx >= 0);
  assert.equal(lastTurnBoundaryId(BATTERY, policy), BATTERY[idx]?.id);
});

test("lastTurnBoundaryId: migrated legacy expectations hold under default policy", () => {
  const entries: TurnBoundaryEntry[] = [
    { id: "a", message: { role: "user" } },
    { id: "b", message: { role: "assistant" } },
    { id: "c", message: { role: "user" } },
    { id: "d", message: { role: "toolResult" } },
  ];
  assert.equal(lastTurnBoundaryId(entries), "c", "last user message is c");

  const noUser: TurnBoundaryEntry[] = [
    { id: "a", message: { role: "assistant" } },
    { id: "b", message: { role: "toolResult" } },
  ];
  assert.equal(lastTurnBoundaryId(noUser), undefined);
  assert.equal(lastTurnBoundaryId([]), undefined);

  const sparse: TurnBoundaryEntry[] = [
    { id: "a" },
    { id: "b", message: { role: "user" } },
  ];
  assert.equal(lastTurnBoundaryId(sparse), "b", "skips entries without message");
});
