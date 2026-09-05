import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { isBiliProxyBaseUrl, PROXY_STAND_DOWN_MESSAGE } from "../src/proxy-detect.js";
import { setRunNpmForTest } from "../src/update.js";

// Hermetic session_start: the pi path runs the auto-update check, so disable
// it and stub npm (no network) — mirroring omp-refuse.test.ts.
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
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

type Notify = (msg: string, type?: string) => void;

function piCtx(notify: Notify, baseUrl: string | undefined, hasUI = true) {
  return {
    mode: "rpc",
    hasUI,
    cwd: "/tmp",
    ui: { notify, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: baseUrl === undefined ? { contextWindow: 200_000 } : { contextWindow: 200_000, baseUrl },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "pi-session",
      getSessionFile: () => "/tmp/pi-proxy.session.json",
    },
  };
}

const startSession = (handlers: any, ctx: any) =>
  handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

const PROXIED_BASE_URL = "http://127.0.0.1:8787/bili/https://api.openai.com/v1";

describe("isBiliProxyBaseUrl (#296)", () => {
  const hits = [
    "http://127.0.0.1:8787/bili/https://api.openai.com/v1",
    "http://localhost:9090/bili/http://internal:11434/v1",
    "https://proxy.example.com/bili/https://upstream.example.com/api",
    "http://127.0.0.1:8787/bili/https://api.openai.com/v1/",
  ];
  const misses: Array<string | undefined> = [
    "https://api.openai.com/v1",
    "https://example.com/foo/bili/https://api.x.com/v1",
    "ftp://host/bili/https://x",
    "http://host/bili",
    "http://host/bili/",
    "http://host/bili/relative/path",
    "http://host/BILI/https://x",
    "not a url",
    "",
    undefined,
  ];
  for (const u of hits) test(`hit: ${u}`, () => assert.equal(isBiliProxyBaseUrl(u), true));
  for (const u of misses) test(`miss: ${String(u)}`, () => assert.equal(isBiliProxyBaseUrl(u), false));
});

describe("proxied baseUrl stand-down (#296)", () => {
  test("detects at session_start, stands down, warns once via UI", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: Array<{ msg: string; type?: string }> = [];
    const ctx = piCtx((msg, type) => notes.push({ msg, type }), PROXIED_BASE_URL);

    await startSession(handlers, ctx);

    assert.equal(notes.length, 1, "warns exactly once");
    assert.equal(notes[0]!.msg, PROXY_STAND_DOWN_MESSAGE);
    assert.equal(notes[0]!.type, "warning");
    // Stands down: does not cancel the host's own compaction (the proxy owns compression).
    assert.equal(handlers.get("session_before_compact")![0]!({}, {}), undefined);
    // Does not inject the ACP system prompt (model must not learn compress here).
    assert.equal(handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {}), undefined);
    // Leaves the context untouched (no ref tags / nudge) — returns undefined.
    const ctxResult = await handlers.get("context")![0]!(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      ctx,
    );
    assert.equal(ctxResult, undefined, "context untouched on a proxied host");
  });

  test("all four ACP tools report the stand-down reason", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const ctx = piCtx(() => {}, PROXIED_BASE_URL);
    await startSession(handlers, ctx);

    for (const name of ["compress", "decompress", "search_context", "acp_status"]) {
      const tool = api.tools.find((t: any) => t.name === name);
      assert.ok(tool, `${name} tool is registered`);
      const res = await (tool as any).execute("t1", {}, undefined, undefined, ctx);
      assert.equal((res.content[0] as any).text, PROXY_STAND_DOWN_MESSAGE, `${name} reports the stand-down reason`);
    }
  });

  test("warns only once across repeated session_start events", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: string[] = [];
    const ctx = piCtx((msg) => notes.push(msg), PROXIED_BASE_URL);

    await startSession(handlers, ctx);
    await startSession(handlers, ctx);

    assert.equal(notes.length, 1, "second session_start must not re-warn");
    assert.equal(notes[0], PROXY_STAND_DOWN_MESSAGE);
  });

  test("prints the warning to stderr when there is no UI (headless one-shot)", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const ctx = piCtx(() => {}, PROXIED_BASE_URL, false);

    const orig = console.error;
    const errs: string[] = [];
    console.error = (...a: any[]) => {
      errs.push(a.join(" "));
    };
    try {
      await startSession(handlers, ctx);
    } finally {
      console.error = orig;
    }

    assert.equal(errs.length, 1, "exactly one stderr line");
    assert.equal(errs[0], PROXY_STAND_DOWN_MESSAGE);
  });

  test("stays active when baseUrl is a plain LLM endpoint", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: string[] = [];
    const ctx = piCtx((msg) => notes.push(msg), "https://api.openai.com/v1");

    await startSession(handlers, ctx);

    assert.equal(notes.filter((m) => m === PROXY_STAND_DOWN_MESSAGE).length, 0, "no stand-down warning on a direct endpoint");
    assert.deepEqual(handlers.get("session_before_compact")![0]!({}, {}), { cancel: true });
    const sp = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {});
    assert.ok(sp.systemPrompt.startsWith("BASE"));
    assert.ok(sp.systemPrompt.includes("compress"));
  });

  test("falls back to the context event when session_start did not fire", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: string[] = [];
    const ctx = piCtx((msg) => notes.push(msg), PROXIED_BASE_URL);

    const ctxResult = await handlers.get("context")![0]!(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      ctx,
    );
    assert.equal(ctxResult, undefined, "context left untouched");
    assert.equal(notes.length, 1, "warned via the fallback detection point");
    assert.equal(notes[0], PROXY_STAND_DOWN_MESSAGE);

    assert.equal(handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {}), undefined);
    const tool = api.tools.find((t: any) => t.name === "compress") as any;
    const res = await tool.execute("t1", {}, undefined, undefined, ctx);
    assert.equal((res.content[0] as any).text, PROXY_STAND_DOWN_MESSAGE);
  });
});
