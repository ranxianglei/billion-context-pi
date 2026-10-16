import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

// issue #464: the kernel (acp-kernel#302) fires terminalEscape /
// truncationSkipped effects when emergency truncation cannot save the
// context. pi must surface them — one log event per episode, no per-turn
// spam — instead of silently dropping the "compression cannot save this
// session" signal.
test("terminal-escape and truncation-skipped are logged once per stuck episode", async () => {
  const dir = await mkdir(path.join(tmpdir(), `acp-tesc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`), { recursive: true });
  const logFile = path.join(dir, "acp.log");
  const stateFile = path.join(dir, "session.json");
  process.env.ACP_LOG_FILE = logFile;
  process.env.ACP_DEBUG = "";
  const { createAcpExtension } = await import(`../src/index.js?t=${Date.now()}-${Math.random()}`);

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

  // Tiny limit + many small messages: usage sits deep in the emergency band,
  // nothing is compressible (all messages far below the viable-range floor)
  // and nothing is truncatable (no oversized payloads) — the stuck shape.
  createAcpExtension({ modelContextLimit: 10_000, preserveRecentMessages: 1 })(api as any);
  const entries = Array.from({ length: 40 }, (_, i) => ({
    type: "message", id: `e${i}`, parentId: null, timestamp: "",
    message: { role: "user", content: `small message ${i} — nothing big enough to truncate or compress`, timestamp: Date.now() },
  }));
  let usage: { tokens: number; percent: number } | null = null;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 10_000, id: "test-model" },
    getContextUsage: () => usage,
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "tesc-session",
      getSessionFile: () => stateFile,
    },
  };
  usage = { tokens: 9_800, percent: 0.98 };

  const fire = () => handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  for (let i = 0; i < 6; i++) await fire(); // escapeAfter=3: episodes fire on 3..6

  const log = await readFile(logFile, "utf8");
  const escapes = log.split("\n").filter((l) => l.includes("event=terminal-escape"));
  const skips = log.split("\n").filter((l) => l.includes("event=truncation-skipped"));
  assert.ok(escapes.length >= 1, `terminal-escape must be logged: ${log.slice(-800)}`);
  assert.equal(escapes.length, 1, `one log per episode, got ${escapes.length}`);
  assert.ok(skips.length >= 1, `truncation-skipped must be logged: ${log.slice(-800)}`);
  assert.equal(skips.length, 1, `one skip log per episode, got ${skips.length}`);
  assert.match(escapes[0]!, /stuckEvents=/);
  await rm(dir, { recursive: true, force: true });
});
