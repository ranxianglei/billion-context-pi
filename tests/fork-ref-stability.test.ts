import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { isCompressNoopText } from "../src/compress-tool.js";
import { setRunNpmForTest } from "../src/update.js";

// Issue #459 (root fix for the #452 loop under declared fork hosts):
// live-tail ids were positional (live-N) and churned on every context fire,
// so kernel refs cited by the model went stale mid-loop. These regressions
// pin the new contract:
//   1. live ids are content-addressed and stable across fires (append-only
//      tails, duplicate content included);
//   2. refs for messages that leave the host view are pruned (no
//      cross-generation refs);
//   3. refs captured on one fire still resolve on the next — a compress
//      built from nudge-example refs succeeds end-to-end.

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
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
  return { api, handlers };
}

function roleMsg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now() } };
}

function forkCtx(getBranch: () => any[], stateFile: string): any {
  return {
    mode: "rpc",
    cwd: "/tmp",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      getBranch: () => getBranch(),
      getSessionId: () => "fork-stability-session",
      getSessionFile: () => stateFile,
    },
  };
}

const textOf = (out: any) => (typeof out === "string" ? out : out.content?.[0]?.text ?? String(out));

async function loadState(stateFile: string) {
  return JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
}

function liveKeys(state: any): string[] {
  return Object.keys(state.messageRefs?.byRaw ?? {}).filter((k) => k.startsWith("live-"));
}

const BIG = "中".repeat(2000);
const DUP = "重".repeat(800);

test("issue #459: live-tail ids are stable across context fires", async () => {
  const prevForkHost = process.env.PI_ACP_FORK_HOST;
  const stateFile = "/tmp/pai-acp-fork-stab1.session.json";
  process.env.PI_ACP_FORK_HOST = "1";
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    await rm(`${stateFile}.acp.json`, { force: true });

    const persisted = [roleMsg("p-u1", "user", "hello"), roleMsg("p-a1", "assistant", "hi there")];
    const rawU1 = { role: "user", content: "hello", timestamp: 0 };
    const rawA1 = { role: "assistant", content: "hi there", timestamp: 0 };
    const rawT = (text: string) => ({ role: "assistant", content: text, timestamp: 0 });
    const ctx = forkCtx(() => persisted, stateFile);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

    await fire([rawU1, rawA1, rawT(`t1 ${BIG}`)]);
    const s1 = await loadState(stateFile);
    const t1Id = s1.messageRefs.byRef["m00003"];
    assert.ok(t1Id?.startsWith("live-"), "first fire mints a live id for the unpersisted tail");

    await fire([rawU1, rawA1, rawT(`t1 ${BIG}`), rawT(`t2 ${BIG}`)]);
    const s2 = await loadState(stateFile);
    assert.equal(s2.messageRefs.byRef["m00003"], t1Id, "appending a newer tail message must not renumber older live ids");
    assert.ok(s2.messageRefs.byRef["m00004"]?.startsWith("live-"));

    await fire([rawU1, rawA1, rawT(`t1 ${BIG}`), rawT(`t2 ${BIG}`), rawT(`t3 ${BIG}`)]);
    const s3 = await loadState(stateFile);
    assert.equal(s3.messageRefs.byRef["m00003"], t1Id, "tail id stable across three fires");
    assert.equal(liveKeys(s3).length, 3, "exactly one live id per unpersisted tail message");
  } finally {
    process.env.PI_ACP_FORK_HOST = prevForkHost;
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("issue #459: duplicate-content tail messages keep stable ranks as the tail grows", async () => {
  const prevForkHost = process.env.PI_ACP_FORK_HOST;
  const stateFile = "/tmp/pai-acp-fork-stab2.session.json";
  process.env.PI_ACP_FORK_HOST = "1";
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    await rm(`${stateFile}.acp.json`, { force: true });

    const persisted = [roleMsg("p-u1", "user", DUP), roleMsg("p-a1", "assistant", "x")];
    const rawU1 = { role: "user", content: DUP, timestamp: 0 };
    const rawA1 = { role: "assistant", content: "x", timestamp: 0 };
    const d1 = { role: "assistant", content: DUP, timestamp: 0 };
    const d2 = { role: "assistant", content: "other", timestamp: 0 };
    const d3 = { role: "assistant", content: DUP, timestamp: 0 };
    const ctx = forkCtx(() => persisted, stateFile);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

    await fire([rawU1, rawA1, d1]);
    const s1 = await loadState(stateFile);
    const d1Id = s1.messageRefs.byRef["m00003"];
    assert.ok(d1Id?.startsWith("live-"), "duplicate-content tail message gets its own live id");

    await fire([rawU1, rawA1, d1, d2]);
    const s2 = await loadState(stateFile);
    assert.equal(s2.messageRefs.byRef["m00003"], d1Id, "older duplicate keeps its id when newer tail arrives");

    await fire([rawU1, rawA1, d1, d2, d3]);
    const s3 = await loadState(stateFile);
    assert.equal(s3.messageRefs.byRef["m00003"], d1Id, "rank conserved while a second duplicate joins the tail");
    assert.notEqual(s3.messageRefs.byRef["m00005"], d1Id, "the new duplicate gets a distinct id");

    persisted.push(roleMsg("p-d1", "assistant", DUP), roleMsg("p-d2", "assistant", "other"), roleMsg("p-d3", "assistant", DUP));
    await fire([rawU1, rawA1, d1, d2, d3]);
    const s4 = await loadState(stateFile);
    assert.equal(liveKeys(s4).length, 0, "once the host persists the tail, no live ids remain");
  } finally {
    process.env.PI_ACP_FORK_HOST = prevForkHost;
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("issue #459: refs for messages that leave the host view are pruned", async () => {
  const prevForkHost = process.env.PI_ACP_FORK_HOST;
  const stateFile = "/tmp/pai-acp-fork-stab3.session.json";
  process.env.PI_ACP_FORK_HOST = "1";
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    await rm(`${stateFile}.acp.json`, { force: true });

    const persisted = [roleMsg("p-u1", "user", "hello"), roleMsg("p-a1", "assistant", "hi there")];
    const rawU1 = { role: "user", content: "hello", timestamp: 0 };
    const rawA1 = { role: "assistant", content: "hi there", timestamp: 0 };
    const rawT = (text: string) => ({ role: "assistant", content: text, timestamp: 0 });
    const ctx = forkCtx(() => persisted, stateFile);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

    await fire([rawU1, rawA1, rawT(`x1 ${BIG}`), rawT(`x2 ${BIG}`)]);
    const s1 = await loadState(stateFile);
    const oldKeys = new Set(liveKeys(s1));
    assert.equal(oldKeys.size, 2);

    await fire([rawU1, rawA1, rawT(`y1 ${BIG}`)]);
    const s2 = await loadState(stateFile);
    const keys = liveKeys(s2);
    assert.equal(keys.length, 1, "only the surviving tail message keeps a live id");
    assert.ok(!oldKeys.has(keys[0]!), "the surviving message did not exist before");
    for (const key of oldKeys) {
      assert.equal(s2.messageRefs.byRaw[key], undefined, `orphaned ref ${key} pruned`);
    }
    const referenced = new Set(Object.values(s2.messageRefs.byRef ?? {}));
    for (const key of oldKeys) {
      assert.ok(!referenced.has(key), `no byRef entry points at orphaned ${key}`);
    }
  } finally {
    process.env.PI_ACP_FORK_HOST = prevForkHost;
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});

test("issue #459: compress built from refs of a prior fire resolves on the next fire", async () => {
  const prevForkHost = process.env.PI_ACP_FORK_HOST;
  const stateFile = "/tmp/pai-acp-fork-stab4.session.json";
  process.env.PI_ACP_FORK_HOST = "1";
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    await rm(`${stateFile}.acp.json`, { force: true });

    const persisted = [roleMsg("p-u1", "user", "hello"), roleMsg("p-a1", "assistant", "hi there")];
    const rawU1 = { role: "user", content: "hello", timestamp: 0 };
    const rawA1 = { role: "assistant", content: "hi there", timestamp: 0 };
    const rawT = (text: string) => ({ role: "assistant", content: text, timestamp: 0 });
    const ctx = forkCtx(() => persisted, stateFile);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

    await fire([rawU1, rawA1, rawT(`x1 ${BIG}`), rawT(`x2 ${BIG}`), rawT(`x3 ${BIG}`), rawT(`x4 ${BIG}`), rawT(`x5 ${BIG}`)]);
    const s1 = await loadState(stateFile);
    const x1Raw = s1.messageRefs.byRef["m00003"];
    const x3Raw = s1.messageRefs.byRef["m00005"];
    assert.ok(x1Raw?.startsWith("live-") && x3Raw?.startsWith("live-"), "live messages carry live ids");
    const refOf = (raw: string) => Object.entries(s1.messageRefs.byRef).find(([, r]) => r === raw)?.[0];
    const startRef = refOf(x1Raw);
    const endRef = refOf(x3Raw);
    assert.ok(startRef && endRef, "kernel refs captured from the first fire");

    // Grow the tail past the protected zone so m00003..m00005 (x1..x3) become
    // a legal range — the nudge only ever cites such ranges.
    await fire([rawU1, rawA1, rawT(`x1 ${BIG}`), rawT(`x2 ${BIG}`), rawT(`x3 ${BIG}`), rawT(`x4 ${BIG}`), rawT(`x5 ${BIG}`), rawT(`y1 ${BIG}`), rawT(`y2 ${BIG}`), rawT(`y3 ${BIG}`), rawT(`y4 ${BIG}`)]);

    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const text = textOf(await (compressTool as any).execute(
      "fc-stab",
      { content: [{ startId: startRef, endId: endRef, summary: "prior-fire ref resolution regression: x1..x3 range captured from fire-1 state must resolve on the fire-2 view after tail growth" }] },
      undefined,
      undefined,
      ctx,
    ));
    assert.ok(!isCompressNoopText(text), `prior-fire refs resolve on the next fire: ${text}`);
    assert.ok(!/does not exist|cannot be anchored|unknown/i.test(text), `no ref-resolution failure: ${text}`);
  } finally {
    process.env.PI_ACP_FORK_HOST = prevForkHost;
    await rm(`${stateFile}.acp.json`, { force: true });
  }
});
