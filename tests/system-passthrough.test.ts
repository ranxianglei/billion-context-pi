import { test } from "node:test";
import assert from "node:assert/strict";
import { carryHostSystemMessages } from "../src/system-passthrough.js";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionMessageEntry["message"];

const TOOL = { name: "bash", description: "run a command", parameters: { type: "object" } };

function system(content: string, extra: Record<string, unknown> = {}): object {
  return { role: "system", content, timestamp: 0, ...extra };
}
function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function assistant(text: string): object {
  return { role: "assistant", content: text, timestamp: Date.now() };
}

test("input without system messages is a strict no-op (same reference)", () => {
  const rebuilt: AgentMessage[] = [user("q"), assistant("a")] as AgentMessage[];
  assert.equal(carryHostSystemMessages(rebuilt, [user("q"), assistant("a")] as AgentMessage[]), rebuilt);
});

test("empty arrays are a no-op", () => {
  const empty: AgentMessage[] = [];
  assert.equal(carryHostSystemMessages(empty, []), empty);
});

test("rebuild without a system message gets the input's prepended verbatim (#477)", () => {
  const sys = system("You are pi.", { toolsAdded: [TOOL], sections: { skills: "s" } });
  const input = [sys, user("q")] as AgentMessage[];
  const rebuilt = [user("q"), assistant("a")] as AgentMessage[];
  const out = carryHostSystemMessages(rebuilt, input) as object[];
  assert.equal(out.length, 3);
  assert.equal(out[0], sys);
  assert.deepEqual((out[0] as Record<string, unknown>).toolsAdded, [TOOL]);
  assert.deepEqual((out[0] as Record<string, unknown>).sections, { skills: "s" });
  assert.equal(out[1], rebuilt[0]);
  assert.equal(out[2], rebuilt[1]);
});

test("multiple input system messages are all prepended, in order", () => {
  const s1 = system("base prompt", { toolsAdded: [TOOL] });
  const s2 = system("", { sections: { diff: "x" } });
  const out = carryHostSystemMessages([user("q")] as AgentMessage[], [s1, user("u"), s2] as AgentMessage[]) as object[];
  assert.equal(out.length, 3);
  assert.equal(out[0], s1);
  assert.equal(out[1], s2);
  assert.equal((out[2] as Record<string, unknown>).role, "user");
});

test("rebuilt system message gets missing host fields filled, existing values kept", () => {
  const inputSys = system("host prompt", { toolsAdded: [TOOL], toolsRemoved: [], sections: { a: "1" }, timestamp: 123 });
  const rebuiltSys: Record<string, unknown> = { role: "system", content: "entry prompt", timestamp: 999 };
  const u = user("q");
  const out = carryHostSystemMessages(
    [rebuiltSys, u] as unknown as AgentMessage[],
    [inputSys, u] as AgentMessage[],
  ) as object[];
  assert.notEqual(out[0], rebuiltSys);
  const head = out[0] as Record<string, unknown>;
  assert.equal(head.content, "entry prompt");
  assert.equal(head.timestamp, 999);
  assert.deepEqual(head.toolsAdded, [TOOL]);
  assert.deepEqual(head.toolsRemoved, []);
  assert.deepEqual(head.sections, { a: "1" });
  assert.equal(rebuiltSys.toolsAdded, undefined);
  assert.equal(out[1], u);
});

test("rebuilt system message already carrying all host fields is untouched (same reference)", () => {
  const sys = system("p", { toolsAdded: [TOOL] });
  const rebuilt = [sys, user("q")] as AgentMessage[];
  assert.equal(carryHostSystemMessages(rebuilt, [sys, user("q")] as AgentMessage[]), rebuilt);
});

test("unpaired rebuilt system messages beyond the input count stay unchanged", () => {
  const r1 = { role: "system", content: "r1" };
  const r2 = { role: "system", content: "r2", toolsAdded: [TOOL] };
  const out = carryHostSystemMessages(
    [r1, r2, user("q")] as unknown as AgentMessage[],
    [system("i1", { toolsAdded: [TOOL] }), user("q")] as AgentMessage[],
  ) as object[];
  assert.notEqual(out[0], r1);
  assert.equal(out[1], r2);
  assert.equal(out[2].role === "user", true);
});

test("non-system message order and identity are preserved when carrying", () => {
  const u1 = user("q1");
  const a1 = assistant("a1");
  const u2 = user("q2");
  const sys = system("p", { toolsAdded: [TOOL] });
  const out = carryHostSystemMessages([u1, a1, u2] as AgentMessage[], [sys, u1, a1, u2] as AgentMessage[]) as object[];
  assert.deepEqual(out.slice(1), [u1, a1, u2]);
});
