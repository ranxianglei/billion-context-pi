import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { UNSUPPORTED_HOST_MESSAGE } from "../src/omp.js";
import { setRunNpmForTest } from "../src/update.js";

// Hermetic session_start: the pi (non-OMP) path runs the auto-update check, so
// disable it and stub npm (no network) — mirroring integration.test.ts.
setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;
delete process.env.PI_ACP_FORK_HOST;

// Mock Pi's ExtensionAPI — captures the event handlers + tools the factory wires.
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

// OMP-shaped host: sessionManager exposes getBranch but NOT buildContextEntries.
function ompCtx(notify: Notify, hasUI: boolean) {
  return {
    mode: "rpc",
    hasUI,
    cwd: "/tmp",
    ui: { notify, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "omp-session",
      getSessionFile: () => "/tmp/omp-refuse.session.json",
    },
  };
}

// pi-shaped host: sessionManager exposes buildContextEntries (the pi signature).
function piCtx(notify: Notify) {
  return {
    mode: "rpc",
    hasUI: true,
    cwd: "/tmp",
    ui: { notify, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "pi-session",
      getSessionFile: () => "/tmp/pi-refuse.session.json",
    },
  };
}

const startSession = (handlers: any, ctx: any) =>
  handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

describe("Unsupported-host refusal (issue #234 / #364)", () => {
  test("detects OMP at session_start, refuses service, warns once via UI", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: Array<{ msg: string; type?: string }> = [];
    const notify: Notify = (msg, type) => notes.push({ msg, type });
    const ctx = ompCtx(notify, true);

    await startSession(handlers, ctx);

    assert.equal(notes.length, 1, "warns exactly once");
    assert.equal(notes[0]!.msg, UNSUPPORTED_HOST_MESSAGE);
    assert.equal(notes[0]!.type, "warning");

    // Stands down: does not cancel the host's own compaction.
    assert.equal(handlers.get("session_before_compact")![0]!({}, {}), undefined);
    // Does not inject the ACP system prompt (model must not learn compress here).
    assert.equal(handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {}), undefined);
    // Leaves the context untouched (no ref tags / nudge) — returns undefined.
    const ctxResult = await handlers.get("context")![0]!(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      ctx,
    );
    assert.equal(ctxResult, undefined, "context untouched on a refused host");
  });

  test("warns only once across repeated session_start events", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: string[] = [];
    const notify: Notify = (msg) => notes.push(msg);
    const ctx = ompCtx(notify, true);

    await startSession(handlers, ctx);
    await startSession(handlers, ctx);

    assert.equal(notes.length, 1, "second session_start must not re-warn");
    assert.equal(notes[0], UNSUPPORTED_HOST_MESSAGE);
  });

  test("all four ACP tools refuse service on OMP", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const ctx = ompCtx(() => {}, true);
    await startSession(handlers, ctx);

    for (const name of ["compress", "decompress", "search_context", "acp_status"]) {
      const tool = api.tools.find((t: any) => t.name === name);
      assert.ok(tool, `${name} tool is registered`);
      const res = await (tool as any).execute("t1", {}, undefined, undefined, ctx);
      assert.equal((res.content[0] as any).text, UNSUPPORTED_HOST_MESSAGE, `${name} refuses service`);
    }
  });

  test("prints the warning to stderr when there is no UI (headless one-shot)", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const ctx = ompCtx(() => {}, false);

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
    assert.equal(errs[0], UNSUPPORTED_HOST_MESSAGE);
  });

  test("does NOT refuse on a pi host (buildContextEntries present)", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: string[] = [];
    const notify: Notify = (msg) => notes.push(msg);
    const ctx = piCtx(notify);

    await startSession(handlers, ctx);

    assert.equal(notes.filter((m) => m === UNSUPPORTED_HOST_MESSAGE).length, 0, "no OMP warning on a pi host");
    assert.deepEqual(handlers.get("session_before_compact")![0]!({}, {}), { cancel: true });
    const sp = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {});
    assert.ok(sp.systemPrompt.startsWith("BASE"));
    assert.ok(sp.systemPrompt.includes("compress"));
  });

  test("declared Pi-compatible fork (PI_ACP_FORK_HOST=1) is NOT refused (#364)", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: string[] = [];
    const notify: Notify = (msg) => notes.push(msg);
    const ctx = ompCtx(notify, true);

    process.env.PI_ACP_FORK_HOST = "1";
    try {
      await startSession(handlers, ctx);
    } finally {
      delete process.env.PI_ACP_FORK_HOST;
    }

    assert.equal(notes.filter((m) => m === UNSUPPORTED_HOST_MESSAGE).length, 0, "no refusal when fork declared");
    assert.deepEqual(handlers.get("session_before_compact")![0]!({}, {}), { cancel: true });
  });
});
