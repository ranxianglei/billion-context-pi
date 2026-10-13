import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "../src/index.js";
import {
  CONTEXT_VIEW_CHANNEL,
  CONTEXT_VIEW_PROVIDER,
  wireContextView,
  type ContextViewResult,
} from "../src/context-view.js";
import { tmpPath } from "./tmp-path.js";

// Cross-extension context view (protocol v1). Two halves are covered here:
//  1. the integration half drives the REAL extension — real context transform,
//     real compress tool, real sidecar — and asks for a view the way the
//     advisor does;
//  2. the unit half pins the hand-off contract with a stub builder (rejection
//     propagation, stand-down answers, malformed payloads, capability probe).

type Entry = { type: string; id: string; parentId: string | null; timestamp: string; message: Record<string, unknown> };

function captureApi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const eventHandlers = new Map<string, ((data: unknown) => unknown)[]>();
  const api = {
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: {
      on(channel: string, handler: (data: unknown) => unknown) {
        const list = eventHandlers.get(channel) ?? [];
        list.push(handler);
        eventHandlers.set(channel, list);
      },
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) void h(data);
      },
    },
    tools: [] as { name: string; execute?: (...args: unknown[]) => unknown }[],
    commands: new Map<string, unknown>(),
    registerTool(tool: { name: string }) { this.tools.push(tool); },
    registerCommand(name: string, options: unknown) { this.commands.set(name, options); },
  };
  return { api, handlers, eventHandlers };
}

const message = (id: string, body: Record<string, unknown>): Entry => ({
  type: "message", id, parentId: null, timestamp: "", message: { timestamp: Date.now(), ...body },
});

const userMsg = (id: string, text: string) => message(id, { role: "user", content: text });
const assistantMsg = (id: string, content: unknown[]) => message(id, { role: "assistant", content });
const toolResultMsg = (id: string, toolCallId: string, toolName: string, text: string) =>
  message(id, { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }] });

/** Only the surface the extension actually touches; cast once at the boundary. */
function fakeCtx(entries: Entry[], stateFile: string | undefined, sessionId = "context-view-it") {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 10_000_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => stateFile,
      getLeafId: () => entries.at(-1)?.id ?? null,
    },
  };
}

const asCtx = (ctx: ReturnType<typeof fakeCtx>) => ctx as unknown as ExtensionContext;

/** Ask for a view exactly the way the advisor's consumer does: emit, require a
 *  synchronous claim, then await the provider's promise. */
async function askView(api: ReturnType<typeof captureApi>["api"], ctx: ReturnType<typeof fakeCtx>, sessionId?: string) {
  let claimed: Promise<ContextViewResult> | undefined;
  api.events.emit(CONTEXT_VIEW_CHANNEL, {
    version: 1,
    sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
    ctx: asCtx(ctx),
    claim: (result: Promise<ContextViewResult>) => { claimed = result; },
  });
  assert.ok(claimed, "provider claimed the request synchronously");
  return claimed;
}

/** Tool results reach the harness as text blocks or as plain strings, depending
 *  on the round; the panel text is what the assertions care about. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(flatten).join("\n");
  return String(value);
}

/** Every toolResult must answer a toolCall still present, and every toolCall
 *  must still have its result — ACP's pairing sanitizer must not leave orphans.
 *  Accepts both shapes it is called with: session entries (`{message: …}`) and
 *  the flat AgentMessages a projection returns. */
function pairingValid(messages: unknown[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const raw of messages) {
    const outer = raw as { role?: string; toolCallId?: string; content?: unknown; message?: { role?: string; toolCallId?: string; content?: unknown } };
    const body = outer.message ?? outer;
    if (body.role === "toolResult" && typeof body.toolCallId === "string") results.add(body.toolCallId);
    if (!Array.isArray(body.content)) continue;
    for (const c of body.content) {
      const part = c as { type?: string; id?: string };
      if (part.type === "toolCall" && typeof part.id === "string") calls.add(part.id);
    }
  }
  return [...calls].every((c) => results.has(c)) && [...results].every((r) => calls.has(r));
}

// ─── integration: the real transform, the real compress tool ───────────────

test("context view is the projection the executor's model saw, rebuilt per request", async () => {
  const stateFile = tmpPath("pai-acp-context-view-fresh.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 10_000_000 })(api as unknown as ExtensionAPI);

  // Enough history to clear the kernel's protected tail, so a real range can be
  // folded; each entry carries a unique marker the assertions key off.
  const entries: Entry[] = Array.from({ length: 30 }, (_, i) =>
    userMsg(`e${i + 1}`, `turn${i + 1} ` + "x".repeat(3000)),
  );
  const ctx = fakeCtx(entries, stateFile);
  const runContext = handlers.get("context")?.[0];
  assert.ok(runContext, "the extension registered a context handler");

  await runContext({ type: "context", messages: entries.map((e) => e.message) }, asCtx(ctx));

  const SUMMARY =
    "SUMMARY-MARKER-ALPHA: the first five turns were folded away, preserving only this digest of what they contained";
  const compressTool = api.tools.find((t) => t.name === "compress");
  assert.ok(compressTool?.execute, "the extension registered the compress tool");
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00005", summary: SUMMARY }] },
    undefined, undefined, asCtx(ctx),
  );
  assert.match(flatten(out), /blocks: b1=m00001–m00005/, `compress folded a real block: ${flatten(out)}`);

  // Pi persists the call and its result; that is how the summary reaches the
  // model, so the fixture has to carry it or it is not modelling a real session.
  entries.push(assistantMsg("e31", [
    { type: "text", text: "folding the early turns now" },
    // >2048 chars to clear the reasoning-drop threshold, but not a single-codepoint
    // run — that would trip the #351 degeneration collapse, which the view does not
    // apply (internal recovery machinery), and muddy what this assertion pins down.
    { type: "thinking", thinking: "COMPRESS-THINKING-" + "ab".repeat(1500) },
    { type: "toolCall", id: "tc1", name: "compress", arguments: { content: [{ startId: "m00001", endId: "m00005", summary: SUMMARY }] } },
  ]));
  entries.push(toolResultMsg("e32", "tc1", "compress", "▣ ACP | folded 5 messages"));

  const transformed = await runContext({ type: "context", messages: entries.map((e) => e.message) }, asCtx(ctx));
  const tText = JSON.stringify(transformed.messages);
  assert.ok(tText.includes(SUMMARY), "the transform kept the full summary");
  assert.doesNotMatch(tText, /turn2 /, "the transform pruned the compressed range");
  assert.match(tText, /turn30 /, "the transform kept the surviving range");
  assert.ok(pairingValid(transformed.messages), "the transform left no orphan tool call or result");

  const first = await askView(api, ctx);
  assert.equal(first.status, "available");
  const firstMessages = (first as { messages: unknown[] }).messages;
  assert.deepEqual(firstMessages, transformed.messages, "the view IS the projection the transform produced");
  assert.ok(JSON.stringify(firstMessages).includes(SUMMARY), "the summary survives into the view");
  assert.ok(pairingValid(firstMessages), "the view leaves no orphan tool call or result");
  assert.ok(
    JSON.stringify(firstMessages).includes("COMPRESS-THINKING"),
    "an in-flight compress round keeps its thinking ([#348]: its result is still the last message)",
  );

  // Mid-turn: the assistant message carrying the consumer's own advisor() call
  // lands, a sibling read() finishes, and the advisor call is still in flight.
  // None of that existed when the previous projection was produced.
  entries.push(assistantMsg("e33", [
    { type: "text", text: "ESCALATION-RATIONALE" },
    { type: "toolCall", id: "tc-read", name: "read", arguments: { path: "a.ts" } },
    { type: "toolCall", id: "tc-adv", name: "advisor", arguments: {} },
  ]));
  entries.push(toolResultMsg("e34", "tc-read", "read", "LATEST-TOOL-EVIDENCE"));

  const second = await askView(api, ctx);
  assert.equal(second.status, "available");
  const secondMessages = (second as { messages: unknown[] }).messages;
  const sText = JSON.stringify(secondMessages);
  assert.match(sText, /ESCALATION-RATIONALE/, "the in-flight assistant message is visible");
  assert.match(sText, /LATEST-TOOL-EVIDENCE/, "evidence produced after the first view is visible");
  assert.ok(sText.includes(SUMMARY), "the summary still survives in the later view");
  assert.doesNotMatch(sText, /turn2 /, "the compressed range stays folded in the later view");
  assert.doesNotMatch(
    sText,
    /COMPRESS-THINKING/,
    "the closed-round compress thinking is dropped from the view too ([#336]: view shaping, not a side effect)",
  );
  assert.ok(pairingValid(secondMessages), "the later view leaves no orphan tool call or result");
  assert.deepEqual(
    secondMessages,
    (await runContext({ type: "context", messages: entries.map((e) => e.message) }, asCtx(ctx))).messages,
    "the later view matches a fresh transform of the same branch",
  );

  await rm(`${stateFile}.acp.json`, { force: true });
});

test("asking for a view writes nothing: cached state and sidecar bytes are untouched", async () => {
  const stateFile = tmpPath("pai-acp-context-view-readonly.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 10_000_000 })(api as unknown as ExtensionAPI);

  const entries: Entry[] = Array.from({ length: 30 }, (_, i) =>
    userMsg(`e${i + 1}`, `turn${i + 1} ` + "x".repeat(3000)),
  );
  const ctx = fakeCtx(entries, stateFile);
  const runContext = handlers.get("context")?.[0];
  assert.ok(runContext);
  await runContext({ type: "context", messages: entries.map((e) => e.message) }, asCtx(ctx));

  const compressTool = api.tools.find((t) => t.name === "compress");
  assert.ok(compressTool?.execute);
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00005", summary: "folded away, digest preserved for the assertions to come" }] },
    undefined, undefined, asCtx(ctx),
  );
  await runContext({ type: "context", messages: entries.map((e) => e.message) }, asCtx(ctx));

  const sidecar = `${stateFile}.acp.json`;
  const before = await readFile(sidecar, "utf8");
  const firstView = await askView(api, ctx);
  const secondView = await askView(api, ctx);
  const after = await readFile(sidecar, "utf8");

  assert.equal(after, before, "the sidecar is byte-identical after two view requests");
  // `builtAt` is a fresh timestamp per answer; the projection itself must not drift.
  assert.deepEqual(
    (secondView as { messages: unknown[] }).messages,
    (firstView as { messages: unknown[] }).messages,
    "repeated requests project the same branch, so no cached state leaked between them",
  );

  // Mutate the answer the way a careless consumer would: the array AND the
  // nested content. `coreOutToAgentMessages` returns the session's own message
  // objects for anything it did not have to patch, so a shallow copy would let
  // this reach the session log and the next projection.
  const messages = (firstView as { messages: { content?: unknown }[] }).messages;
  const pristine = structuredClone(messages);
  const entriesBefore = JSON.stringify(entries);
  messages[0].content = [{ type: "text", text: "TAMPERED" }];
  messages.length = 0;

  assert.equal(JSON.stringify(entries), entriesBefore, "session entries are untouched by consumer mutation");
  assert.equal(await readFile(sidecar, "utf8"), before, "the sidecar is untouched by consumer mutation");
  const third = await askView(api, ctx);
  assert.deepEqual(
    (third as { messages: unknown[] }).messages,
    pristine,
    "a later view is unaffected by the consumer's mutation",
  );

  await rm(sidecar, { force: true });
});

// ─── unit: the hand-off contract ───────────────────────────────────────────

function stubApi() {
  const eventHandlers = new Map<string, ((data: unknown) => unknown)[]>();
  return {
    events: {
      on(channel: string, handler: (data: unknown) => unknown) {
        const list = eventHandlers.get(channel) ?? [];
        list.push(handler);
        eventHandlers.set(channel, list);
      },
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) void h(data);
      },
    },
  };
}

type StubCtx = ReturnType<typeof stubCtx>;
const stubCtx = (sessionId: string, leafId: string | null = "leaf-1") =>
  ({
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      // The path the provider checks the requesting leaf against. Tests that
      // care about branch movement replace both this and `getLeafId`.
      getBranch: () => (leafId === null ? [] : [{ id: leafId }]),
    },
  }) as unknown as ExtensionContext;

function wireStub(opts: {
  buildView: (ctx: ExtensionContext) => Promise<never[] | Record<string, unknown>[]>;
  refused?: boolean;
  standDown?: boolean;
}) {
  const api = stubApi();
  wireContextView(
    api as unknown as ExtensionAPI,
    { refused: opts.refused ?? false } as never,
    () => opts.standDown ?? false,
    opts.buildView as never,
  );
  return api;
}

function request(api: ReturnType<typeof stubApi>, ctx: StubCtx, sessionId = ctx.sessionManager.getSessionId()) {
  let claimed: Promise<ContextViewResult> | undefined;
  api.events.emit(CONTEXT_VIEW_CHANNEL, {
    version: 1,
    sessionId,
    ctx,
    claim: (result: Promise<ContextViewResult>) => { claimed = result; },
  });
  return claimed;
}

test("context view provider reports a broken hand-off instead of a silent no-op", async () => {
  const api = wireStub({ buildView: async () => { throw new Error("state unreadable"); } });
  const claimed = request(api, stubCtx("s1"));
  assert.ok(claimed);
  await assert.rejects(claimed, /state unreadable/, "a builder failure rejects the claim");
});

test("context view provider answers inactive for stand-down, mismatch and refusal", async () => {
  const cases: Array<[string, () => Promise<ContextViewResult | undefined>, string]> = [];
  const refusedApi = wireStub({ refused: true, buildView: async () => [] });
  cases.push(["refused", () => request(refusedApi, stubCtx("s1")), "refused"]);
  const stoodDownApi = wireStub({ standDown: true, buildView: async () => [] });
  cases.push(["stood-down", () => request(stoodDownApi, stubCtx("s1")), "stood-down"]);
  const mismatchApi = wireStub({ buildView: async () => [] });
  cases.push(["session-mismatch", () => request(mismatchApi, stubCtx("s1"), "s2"), "session-mismatch"]);
  const emptyApi = wireStub({ buildView: async () => [] });
  cases.push(["empty", () => request(emptyApi, stubCtx("s1")), "empty"]);

  for (const [label, ask, reason] of cases) {
    const result = await ask();
    assert.equal(result?.status, "inactive", label);
    assert.equal((result as { reason: string }).reason, reason, label);
    assert.equal((result as { provider: string }).provider, CONTEXT_VIEW_PROVIDER, label);
  }
});

/** A session manager whose branch is a mutable path, so a test can rewind it
 *  or append to it from inside `buildView`. */
function branchCtx(sessionId: string, path: string[]) {
  let branch = path.map((id) => ({ id }));
  const ctx = stubCtx(sessionId, branch.at(-1)?.id ?? null);
  const sessionManager = ctx.sessionManager as unknown as {
    getLeafId: () => string | null;
    getBranch: () => { id: string }[];
  };
  sessionManager.getLeafId = () => branch.at(-1)?.id ?? null;
  sessionManager.getBranch = () => branch;
  return {
    ctx,
    rewind: (to: string[]) => { branch = to.map((id) => ({ id })); },
    append: (id: string) => { branch = [...branch, { id }]; },
  };
}

test("context view provider stands down when the branch is rewound while it is building", async () => {
  const { ctx, rewind } = branchCtx("s1", ["root", "leaf-1"]);
  const api = wireStub({
    buildView: async () => {
      rewind(["root"]); // a rewind past leaf-1: the caller is no longer on it
      return [{ role: "user", content: "x" }];
    },
  });

  const result = await request(api, ctx);
  assert.equal(result?.status, "inactive");
  assert.equal((result as { reason: string }).reason, "branch-moved");
});

test("context view provider still answers when the branch only grows while it is building", async () => {
  // A sibling tool result landing mid-build is ordinary turn progress, not a
  // branch move; refusing here would starve the consumer of the view it asked
  // for. The projection covers the branch as it stood when the caller asked.
  const { ctx, append } = branchCtx("s1", ["root", "leaf-1"]);
  const api = wireStub({
    buildView: async () => {
      append("leaf-2");
      return [{ role: "user", content: "x" }];
    },
  });

  const result = await request(api, ctx);
  assert.equal(result?.status, "available");
});

test("context view provider ignores malformed payloads without claiming", () => {
  const api = wireStub({ buildView: async () => [{ role: "user", content: "x" }] });
  const ctx = stubCtx("s1");
  const claimed: string[] = [];
  const claimSpy = () => { claimed.push("claimed"); };

  const malformed: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["wrong version", { version: 2, sessionId: "s1", ctx, claim: claimSpy }],
    ["missing claim", { version: 1, sessionId: "s1", ctx }],
    ["missing ctx", { version: 1, sessionId: "s1", claim: claimSpy }],
    ["non-string sessionId", { version: 1, sessionId: 7, ctx, claim: claimSpy }],
  ];
  for (const [label, payload] of malformed) {
    api.events.emit(CONTEXT_VIEW_CHANNEL, payload);
    assert.equal(claimed.length, 0, `${label} was not claimed`);
  }

  // Control: the same spy on a well-formed payload does fire, so the loop above
  // proves rejection of the malformed fields and not an unreachable counter.
  api.events.emit(CONTEXT_VIEW_CHANNEL, { version: 1, sessionId: "s1", ctx, claim: claimSpy });
  assert.equal(claimed.length, 1, "a well-formed payload is claimed");
});

test("context view provider is not installed without an event bus", () => {
  const api = { events: undefined } as unknown as ExtensionAPI;
  wireContextView(api, { refused: false } as never, () => false, (async () => []) as never);
  assert.equal((api as { events?: unknown }).events, undefined, "no bus, no provider, no throw");
});
