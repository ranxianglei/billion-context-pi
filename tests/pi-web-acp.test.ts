import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tsup defines CURRENT_VERSION at build time; under the node test runner it
// is bare, so stub it before the module graph reads it.
(globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";

const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(
  "@earendil-works/pi-coding-agent"
);
const { createAcpExtension } = await import("../src/index.js");

type Notify = { msg: string; type?: string };

interface PiWebSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  notifications: Notify[];
  cleanup: () => Promise<void>;
}

// Simulate a pi-web host: embeds the pi SDK in another node process, drives the
// agent via AgentSession.prompt(), and surfaces extension output through a UI
// context whose notify() reaches the web chat. Mirrors that contract so /acp is
// verified end-to-end without the real pi-web app installed.
async function createPiWebSession(): Promise<PiWebSession> {
  const base = mkdtempSync(join(tmpdir(), "piweb-test-"));
  const agentDir = join(base, "agent");
  const cwd = join(base, "cwd");
  const sessionDir = join(base, "sessions");
  for (const d of [agentDir, cwd, sessionDir]) mkdirSync(d, { recursive: true });

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
    cleanup: async () => {
      await session.dispose?.();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test("pi-web: /acp renders the ACP status panel via ui.notify", async () => {
  const { session, notifications, cleanup } = await createPiWebSession();
  try {
    await session.prompt("/acp");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].msg, /ACP Context Analysis/);
    assert.match(notifications[0].msg, /billion-context-pi@/);
    assert.match(notifications[0].msg, /Sent to LLM/);
    assert.match(notifications[0].msg, /Nudge:/);
    assert.match(notifications[0].msg, /Blocks:/);
  } finally {
    await cleanup();
  }
});

test("pi-web: /acp-status, /acp-search, /acp-subagents all notify", async () => {
  const { session, notifications, cleanup } = await createPiWebSession();
  try {
    await session.prompt("/acp-status");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].msg, /ACP Context Analysis/);

    notifications.length = 0;
    await session.prompt("/acp-search context");
    assert.ok(notifications.length >= 1, "acp-search should notify a result");

    notifications.length = 0;
    await session.prompt("/acp-subagents");
    assert.ok(notifications.length >= 1, "acp-subagents should notify a result");
  } finally {
    await cleanup();
  }
});
