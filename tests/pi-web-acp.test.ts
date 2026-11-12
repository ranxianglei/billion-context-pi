import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tsup defines CURRENT_VERSION at build time; under the node test runner it
// is bare, so stub it before the module graph reads it.
(globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";

const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(
  "@earendil-works/pi-coding-agent"
);
const { createAcpExtension } = await import("../src/index.js");
const { createInitialState } = await import("acp-kernel");

type Notify = { msg: string; type?: string };

interface CapturedCustom {
  customType: string;
  display: boolean;
  content: unknown;
}

interface PiWebSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  notifications: Notify[];
  customMessages: CapturedCustom[];
  cleanup: () => Promise<void>;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part !== null && typeof part === "object" && "text" in part) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

// Seed a finished ACP session (jsonl + .acp.json sidecar) into the session dir
// so /acp-export has deterministic input. Fixture shape mirrors
// tests/export-cmd.test.ts (header + linear parentId chain).
function seedExportableSession(sessionDir: string): void {
  const id = "fixture-sess";
  const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp" };
  const entries = [
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "",
      message: { role: "user", content: "Fixture prompt for the export listing.", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "",
      message: { role: "user", content: "Second fixture message.", timestamp: Date.now() },
    },
  ];
  writeFileSync(join(sessionDir, `${id}.jsonl`), [header, ...entries].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  writeFileSync(join(sessionDir, `${id}.jsonl.acp.json`), JSON.stringify(createInitialState()), "utf8");
}

// Simulate a pi-web host: embeds the pi SDK in another node process, drives the
// agent via AgentSession.prompt(), and surfaces extension output through two
// channels — persistent custom messages (session events + log entries, issue
// #255) and transient ui.notify() toasts. Mirrors that contract so /acp is
// verified end-to-end without the real pi-web app installed.
async function createPiWebSession(opts: { seedExport?: boolean } = {}): Promise<PiWebSession> {
  const base = mkdtempSync(join(tmpdir(), "piweb-test-"));
  const agentDir = join(base, "agent");
  const cwd = join(base, "cwd");
  const sessionDir = join(base, "sessions");
  for (const d of [agentDir, cwd, sessionDir]) mkdirSync(d, { recursive: true });
  if (opts.seedExport) seedExportableSession(sessionDir);

  const factory = createAcpExtension({ autoUpdate: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [factory],
  });
  // createAgentSession does NOT reload a caller-supplied loader; do it here.
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    sessionManager,
  });

  const notifications: Notify[] = [];
  const customMessages: CapturedCustom[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end") return;
    if (event.message.role !== "custom") return;
    customMessages.push({
      customType: event.message.customType,
      display: event.message.display,
      content: event.message.content,
    });
  });

  const uiContext = new Proxy(
    {},
    {
      has: () => true,
      get(_t, prop) {
        if (prop === "notify")
          return (msg: string, type?: string) => notifications.push({ msg, type });
        if (prop === "select") return async () => undefined;
        if (prop === "confirm") return async () => false;
        if (prop === "input") return async () => undefined;
        if (prop === "custom") return async () => undefined;
        return () => {};
      },
    },
  );
  await session.bindExtensions({ uiContext, mode: "rpc" });

  return {
    session,
    notifications,
    customMessages,
    cleanup: async () => {
      unsubscribe();
      await session.dispose?.();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// Kit panel structural markers (see tests/commands-kit-panel.test.ts).
function assertKitPanel(env: PiWebSession, command: string): void {
  assert.equal(env.notifications.length, 0, `${command} must not fall back to transient notify on SDK hosts`);
  const panels = env.customMessages.filter((m) => m.customType === "acp-status");
  assert.equal(panels.length, 1, `${command} must deliver exactly one acp-status custom message`);
  const panel = panels[0]!;
  assert.equal(panel.display, true, "panel must be rendered (display: true)");
  const text = contentText(panel.content);
  assert.match(text, /Context \(session accounting, host footer scale\):/);
  assert.match(text, /Sent to LLM \(after compression, est\.\):/);
  assert.match(text, /Token Breakdown \(sent view\):/);
  assert.match(text, /billion-context-pi@/);
  const persisted = env.session.sessionManager.getEntries().filter((e) => e.type === "custom_message");
  assert.ok(
    persisted.some((e) => e.type === "custom_message" && e.customType === "acp-status"),
    "panel must be persisted in the session log so web hosts reload it with the transcript",
  );
}

test("pi-web: /acp renders the kit status panel as a persistent custom message", async () => {
  const env = await createPiWebSession();
  try {
    await env.session.prompt("/acp");
    assertKitPanel(env, "/acp");
  } finally {
    await env.cleanup();
  }
});

test("pi-web: /acp-status re-renders the kit panel through the same channel", async () => {
  const env = await createPiWebSession();
  try {
    await env.session.prompt("/acp-status");
    assertKitPanel(env, "/acp-status");
  } finally {
    await env.cleanup();
  }
});

test("pi-web: /acp-export lists ACP sessions as an acp-export custom message", async () => {
  const env = await createPiWebSession({ seedExport: true });
  try {
    await env.session.prompt("/acp-export");
    assert.equal(env.notifications.length, 0, "export listing must use the persistent channel");
    const exports = env.customMessages.filter((m) => m.customType === "acp-export");
    assert.equal(exports.length, 1);
    assert.equal(exports[0]!.display, true);
    const text = contentText(exports[0]!.content);
    assert.match(text, /^ACP-managed sessions:/);
    assert.match(text, /fixture-sess/);
    assert.match(text, /blocks=0/);
    assert.match(text, /Usage: \/acp-export/);
  } finally {
    await env.cleanup();
  }
});

test("pi-web: /acp-search and /acp-subagents deliver results via transient notify", async () => {
  const env = await createPiWebSession();
  try {
    await env.session.prompt("/acp-search context");
    assert.equal(env.notifications.length, 1, "acp-search should notify a result");
    assert.match(env.notifications[0]!.msg, /No matching blocks\.|^\[b\d+\]/);

    env.notifications.length = 0;
    await env.session.prompt("/acp-subagents");
    assert.equal(env.notifications.length, 1, "acp-subagents should notify a result");
    // Outcome depends on whether this machine has pi-subagents installed; the
    // contract under test is that exactly one toast arrives on the notify channel.
    assert.match(env.notifications[0]!.msg, /^(Nothing to do: |ACP tools enabled for pi-subagents agents in |Failed to update )/);
  } finally {
    await env.cleanup();
  }
});
