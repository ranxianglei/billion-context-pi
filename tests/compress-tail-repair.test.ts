import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { normalizeRanges, tailRepair } from "../src/compress-tool.js";
import { tmpPath } from "./tmp-path.js";

// issue #253: Qwen-family non-strict tool calls drop the last entry's closing
// `}` (tail `"]` instead of `"}]`). The kernel parser then drops the last range
// (or every range, when it is the only one) and reports a misleading
// "truncated"/"no-valid-ranges" + "must be an ARRAY" diagnostic. The adapter
// repairs the brace before delegating and, when the input is array-shaped but
// still unparseable, reports the parser's own diagnostic instead.

// Build a content-array string, then drop the last entry's closing `}`.
function dropLastBrace(arr: unknown[]): string {
  const s = JSON.stringify(arr);
  return s.slice(0, s.length - 2) + "]";
}

// ─── unit: tailRepair (the deterministic repair) ────────────────────────────

test("tailRepair recovers a single entry missing its closing `}`", () => {
  const broken = dropLastBrace([{ startId: "m00001", endId: "m00010", summary: "s" }]);
  assert.ok(broken.endsWith('"]') && !broken.endsWith('"}]'), "precondition: tail is `\"]`");
  const repaired = tailRepair(broken);
  assert.equal(repaired, JSON.stringify([{ startId: "m00001", endId: "m00010", summary: "s" }]));
});

test("tailRepair recovers a multi-entry array whose LAST entry is missing `}`", () => {
  const arr = [
    { startId: "m00001", endId: "m00010", summary: "a" },
    { startId: "m00011", endId: "m00020", summary: "b" },
    { startId: "m00021", endId: "m00030", summary: "c" },
  ];
  const repaired = tailRepair(dropLastBrace(arr));
  assert.deepEqual(JSON.parse(repaired!), arr);
});

test("tailRepair has no false positives on well-formed inputs", () => {
  // A valid object array ends in `}]` → body ends in `}`, not `"`.
  assert.equal(tailRepair('[{"startId":"m1","endId":"m2","summary":"x"}]'), undefined);
  // A valid string array: appending `}` yields invalid JSON.
  assert.equal(tailRepair('["a"]'), undefined);
  // Empty array: body `[` does not end in `"`.
  assert.equal(tailRepair("[]"), undefined);
  // Not array-shaped at all.
  assert.equal(tailRepair('{"content": []}'), undefined);
  assert.equal(tailRepair("not json"), undefined);
  // A genuine mid-array defect (missing brace between entries) is NOT the tail
  // case — left untouched for the accurate error path to report.
  assert.equal(tailRepair('[{"startId":"m1","endId":"m2","summary":"a"{"startId":"m3","endId":"m4","summary":"b"}]'), undefined);
});

test("tailRepair tolerates trailing whitespace after the `]`", () => {
  const broken = dropLastBrace([{ startId: "m1", endId: "m2", summary: "s" }]) + "  \n";
  assert.equal(tailRepair(broken), JSON.stringify([{ startId: "m1", endId: "m2", summary: "s" }]));
});

// ─── unit: normalizeRanges (repair wired in + accurate errors) ──────────────

test("normalizeRanges repairs a single-entry missing-`}` payload (the #253 failure)", () => {
  const summary = "Auth exploration: src/auth/login.ts:12, src/auth/token.ts:45. Chose JWT over session because stateless. saved at /home/dog/tmp/comments_early.json.";
  const broken = dropLastBrace([{ startId: "m00001", endId: "m00010", summary }]);
  const out = normalizeRanges({ content: broken });
  assert.ok(Array.isArray(out), `expected ranges, got error: ${out}`);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { startId: "m00001", endId: "m00010", summary, topic: undefined });
});

test("normalizeRanges recovers ALL ranges when the last entry is missing `}`", () => {
  const broken = dropLastBrace([
    { startId: "m00001", endId: "m00010", summary: "first" },
    { startId: "m00011", endId: "m00020", summary: "second" },
    { startId: "m00021", endId: "m00030", summary: "third" },
  ]);
  const out = normalizeRanges({ content: broken });
  assert.ok(Array.isArray(out), `expected ranges, got error: ${out}`);
  assert.equal(out.length, 3, "the previously-dropped last range is recovered");
  assert.deepEqual(out.map((r) => `${r.startId}..${r.endId}`), ["m00001..m00010", "m00011..m00020", "m00021..m00030"]);
});

test("normalizeRanges applies the top-level topic to repaired ranges", () => {
  const broken = dropLastBrace([{ startId: "m00001", endId: "m00005", summary: "s" }]);
  const out = normalizeRanges({ topic: "Auth", content: broken });
  assert.ok(Array.isArray(out));
  assert.equal(out[0].topic, "Auth");
});

test("normalizeRanges leaves a well-formed string array untouched", () => {
  const s = JSON.stringify([{ startId: "m1", endId: "m2", summary: "x" }]);
  const out = normalizeRanges({ content: s });
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 1);
  assert.equal(out[0].startId, "m1");
});

test("array-shaped but unparseable (non-tail defect) → parser diagnostic, not 'must be an ARRAY'", () => {
  const broken = '[{"startId": "m1", "endId": "m2", "summary": "unterminated';
  const out = normalizeRanges({ content: broken });
  assert.equal(typeof out, "string", `expected an error string, got: ${JSON.stringify(out)}`);
  assert.match(out, /failed to parse/);
  assert.doesNotMatch(out, /must be an ARRAY/);
});

test("non-array-shaped garbage still reports 'must be an ARRAY' (unchanged)", () => {
  const out = normalizeRanges({ content: "not json {" });
  assert.equal(typeof out, "string");
  assert.match(out, /must be an ARRAY/);
});

// ─── integration: the repaired payload actually compresses end-to-end ───────

test("compress tool succeeds on a missing-`}` string payload (end-to-end)", async () => {
  const handlers = new Map<string, ((e: any, ctx: any) => any)[]>();
  const api: any = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  createAcpExtension({ modelContextLimit: 200_000 })(api);
  const stateFile = tmpPath("pai-acp-tail-repair-e2e.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });

  const ZH = "中".repeat(6000);
  const userMsg = (id: string, text: string) =>
    ({ type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } });
  const entries = [userMsg("e1", ZH)];
  const ctx: any = {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "tail-repair-session",
      getSessionFile: () => stateFile,
    },
  };
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx); // assign refs

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const broken = dropLastBrace([{ startId: "m00001", endId: "m00001", summary: "compressed via tail repair" }]);
  // Before the fix this REJECTED with "no-valid-ranges ... must be an ARRAY"
  // (the single entry's missing `}` made the kernel parser drop it). After the
  // fix the payload parses, so the tool resolves with a panel — never the
  // misleading parse error.
  const out = await compressTool.execute("tc1", { content: broken }, undefined, undefined, ctx);
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.match(text, /▣ ACP \|/, `expected a panel (payload accepted), got: ${text}`);
  assert.doesNotMatch(text, /must be an ARRAY|no-valid-ranges/, `misleading parse error regressed: ${text}`);
  await rm(`${stateFile}.acp.json`, { force: true });
});
