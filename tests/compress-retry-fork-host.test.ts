import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { retryBreakerKey } from "../src/runtime.js";
import { isCompressNoopText } from "../src/compress-tool.js";
import { setRunNpmForTest } from "../src/update.js";
import { tmpPath } from "./tmp-path.js";

// Issue #453 (evidence from the #452 log): under a declared fork host
// (PI_ACP_FORK_HOST=1, e.g. omp) the context handler keyed the compress-retry
// circuit breaker on lastTurnBoundaryId(MERGED entries) — and the merged tail
// carries live ids for messages the host has not persisted yet. The current
// user message stays live across every context fire of a long tool loop and
// its host view drifts between fires (the extension's own ref-tag/token-count
// mutations ride along in the text), so it re-mints a fresh content-addressed
// id per fire (#459) and the breaker's failTurnKey churned: the
// MAX_COMPRESS_ATTEMPTS cap never latched, and a session pinned at emergency
// kept getting emergency-injected and burning guaranteed-to-fail compress
// attempts forever (#452 log: cap → inject every ~45 s).
//
// Contract under test: the breaker keys off PERSISTED boundaries only
// (retryBreakerKey — immutable ids), so the cap latches through live-id
// churn and releases only when a genuine new user message reaches the session
// log (or a compress succeeds).

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

function toolResultMsg(id: string, toolCallId: string, text: string, isError: boolean) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: {
      role: "toolResult", toolCallId, toolName: "compress",
      content: [{ type: "text", text }], isError, timestamp: Date.now(),
    },
  };
}

// Declared fork host: getBranch only (no buildContextEntries); the branch
// lags behind the host's send view (event.messages carries the not-yet-
// persisted tail) — the omp shape documented in src/runtime.ts stateFor.
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
      getSessionId: () => "fork-breaker-session",
      getSessionFile: () => stateFile,
    },
  };
}

const textOf = (out: any) => (typeof out === "string" ? out : out.content?.[0]?.text ?? String(out));

const ZH = "中".repeat(6000);

test("issue #453: retryBreakerKey derives from persisted entries only", () => {
  const forkSm = {
    getBranch: () => [roleMsg("p-u1", "user", "a"), roleMsg("p-a1", "assistant", "b"), roleMsg("p-u2", "user", "c")],
  };
  assert.equal(retryBreakerKey(forkSm as any), "p-u2");
  const piSm = {
    buildContextEntries: () => [roleMsg("q-u1", "user", "a"), roleMsg("q-u2", "user", "c")],
    getBranch: () => [roleMsg("p-u1", "user", "a")],
  };
  assert.equal(retryBreakerKey(piSm as any), "q-u2", "buildContextEntries wins (pi precedence)");
});

test("issue #453: cap latches through fork-host live-id churn; new persisted user message releases", async () => {
  const prevForkHost = process.env.PI_ACP_FORK_HOST;
  process.env.PI_ACP_FORK_HOST = "1";
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const stateFile = tmpPath("pai-acp-fork-breaker.session.json");
    await rm(`${stateFile}.acp.json`, { force: true });

    // Shape contract: getBranch() returns session ENTRIES (stable ids);
    // event.messages carries RAW AgentMessages — the host's exact send view
    // (cf. prefix-stab.test.ts). Feeding entry-shaped objects as messages
    // breaks mergeLiveEntries' identity matching entirely: every entry
    // re-mints a content-addressed live id and no turn boundary is ever
    // recognized, so outcome collection sees nothing.
    const persisted: any[] = [roleMsg("p-u1", "user", "u1 " + ZH), roleMsg("p-a1", "assistant", "a1 " + ZH)];
    const rawOf = (e: any) => ({ ...e.message });
    const U3_BASE = "u3 " + ZH;
    const rawU3 = (drift: number) => ({ role: "user", content: drift === 0 ? U3_BASE : `${U3_BASE} (resend ${drift})`, timestamp: 0 });
    const rawResult = (toolCallId: string, text: string) => ({ role: "toolResult", toolCallId, toolName: "compress", content: [{ type: "text", text }], isError: false, timestamp: 0 });
    const ctx = forkCtx(() => persisted, stateFile);

    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

    // Stuck-turn dynamics (the #452 log pattern): u3 stays unpersisted across
    // every fire, and each host resend drifts from the prior send view (the
    // extension's own ref-tag/token-count mutations ride along in the text),
    // so u3 re-mints a fresh content-addressed live id per fire (#459). The
    // merged-view boundary id churns; the persisted boundary stays p-u1.
    let drift = 0;
    let live: any[] = [{ role: "user", content: "u1 " + ZH, timestamp: 0 }, { role: "assistant", content: "a1 " + ZH, timestamp: 0 }, rawU3(0)];
    const fire = () => handlers.get("context")![0]!({ type: "context", messages: live }, ctx);
    await fire();

    assert.equal(retryBreakerKey(ctx.sessionManager), "p-u1", "breaker key is the persisted boundary, not the live tail");

    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const S = () => [{ startId: "m00999", endId: "m00100", summary: "dead refs" }];
    const run = async (id: string) => {
      const text = textOf(await (compressTool as any).execute(id, { content: S() }, undefined, undefined, ctx));
      if (!persisted.some((e) => e.id === "p-u3")) {
        drift += 1;
        live = [live[0]!, live[1]!, rawU3(drift), ...live.slice(3)];
      }
      live = [...live, rawResult(id, text)];
      await fire();
      return text;
    };

    const f1 = await run("fc1");
    assert.ok(isCompressNoopText(f1) && f1.includes("does not exist"), `f1 is the kernel unknown-ref panel: ${f1}`);
    const f2 = await run("fc2");
    assert.ok(f2.includes("REJECTED"), `f2 is the dead-range hard rejection: ${f2}`);
    const f3 = await run("fc3");
    assert.ok(f3.includes("REJECTED"), `f3 still rejected: ${f3}`);

    // Three failures burned the cap while u3 stayed unpersisted and its
    // merged-view boundary id churned between fires. Pre-fix the counter was
    // keyed on those volatile ids: the key flip reset failCount, and the
    // per-session seen-set then blocked re-counting, so the cap never latched
    // and f4 executed instead of pausing.
    const f4 = await run("fc4");
    assert.ok(f4.includes("PAUSED"), `f4 must be paused by the latched cap despite live-id churn: ${f4}`);

    // The host finally persists the stuck turn's tail, including the current
    // user message — a genuine new user boundary reaches the log → release.
    persisted.push(
      roleMsg("p-u3", "user", U3_BASE),
      { type: "message", id: "p-r1", parentId: null, timestamp: "", message: rawResult("fc1", f1) },
      { type: "message", id: "p-r2", parentId: null, timestamp: "", message: rawResult("fc2", f2) },
      { type: "message", id: "p-r3", parentId: null, timestamp: "", message: rawResult("fc3", f3) },
    );
    live = persisted.map(rawOf);
    await fire();
    assert.equal(retryBreakerKey(ctx.sessionManager), "p-u3", "key advances only when the user message persists");

    const f5 = await run("fc5");
    assert.ok(f5.includes("REJECTED") && !f5.includes("PAUSED"), `cap released by the new user message (dead-range guard still applies): ${f5}`);
    await rm(`${stateFile}.acp.json`, { force: true });
  } finally {
    if (prevForkHost === undefined) delete process.env.PI_ACP_FORK_HOST;
    else process.env.PI_ACP_FORK_HOST = prevForkHost;
  }
});
