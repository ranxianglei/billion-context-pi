import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { CONFIG_DIR_NAME } from "../src/config-dir.js";
import { setRunNpmForTest } from "../src/update.js";
import type { AdapterConfig } from "../src/config.js";

// Hermetic session_start (mirrors omp-refuse.test.ts): auto-update off, npm stubbed (no network),
// no proxy / fork-host env.
setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;
delete process.env.PI_ACP_FORK_HOST;

const DELEGATE_TOOLS = ["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"];
const CORE_TOOLS = ["compress", "decompress", "search_context", "acp_status"];
const PROMPT_MARKER = "ACP_DELEGATE NOTIFICATIONS";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api: any = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    shortcuts: [] as string[],
    commands: new Map<string, any>(),
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
    registerShortcut(name: string, _options: any) {
      this.shortcuts.push(name);
    },
  };
  return { api, handlers };
}

interface Harness {
  toolNames: string[];
  shortcuts: string[];
  systemPrompt: string;
}

// Boots against isolated HOME (global acp.json) + temp cwd (project acp.json); reports wired tools/shortcuts/prompt.
async function boot(
  adapter: Partial<AdapterConfig>,
  files: { global?: Record<string, unknown>; project?: Record<string, unknown> },
): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "bcp-home-"));
  const proj = mkdtempSync(join(tmpdir(), "bcp-proj-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    if (files.global !== undefined) {
      mkdirSync(join(home, CONFIG_DIR_NAME));
      writeFileSync(join(home, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(files.global));
    }
    if (files.project !== undefined) {
      mkdirSync(join(proj, CONFIG_DIR_NAME));
      writeFileSync(join(proj, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(files.project));
    }

    const { api, handlers } = captureApi();
    createAcpExtension(adapter)(api);
    const ctx = {
      mode: "rpc",
      hasUI: true,
      cwd: proj,
      ui: {
        notify: () => {},
        confirm: async () => true,
        select: async () => undefined,
        input: async () => "",
        setStatus: () => {},
      },
      model: { contextWindow: 200_000 },
      sessionManager: {
        buildContextEntries: () => [],
        getBranch: () => [],
        getSessionId: () => "delegate-toggle-session",
        getSessionFile: () => join(proj, "delegate-toggle.session.jsonl"),
      },
    };
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const sp = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctx);
    return {
      toolNames: api.tools.map((t: any) => t.name),
      shortcuts: api.shortcuts,
      systemPrompt: typeof sp?.systemPrompt === "string" ? sp.systemPrompt : "",
    };
  } finally {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

function assertDelegateOn(h: Harness) {
  for (const n of DELEGATE_TOOLS) assert.ok(h.toolNames.includes(n), `${n} registered`);
  assert.ok(h.shortcuts.includes("ctrl+alt+f"), "ctrl+alt+f shortcut registered");
  assert.ok(h.systemPrompt.includes(PROMPT_MARKER), `system prompt contains ${PROMPT_MARKER}`);
}

function assertDelegateOff(h: Harness) {
  for (const n of DELEGATE_TOOLS) assert.ok(!h.toolNames.includes(n), `${n} must not be registered`);
  assert.ok(!h.shortcuts.includes("ctrl+alt+f"), "no ctrl+alt+f shortcut");
  assert.ok(!h.systemPrompt.includes(PROMPT_MARKER), `system prompt without ${PROMPT_MARKER}`);
  for (const n of CORE_TOOLS) assert.ok(h.toolNames.includes(n), `${n} still registered`);
  assert.ok(h.systemPrompt.startsWith("BASE"), "base prompt preserved");
}

describe("delegate toggle: tools + shortcut + prompt section move together (#409)", () => {
  test("default (no config anywhere): all three surfaces active", async () => {
    assertDelegateOn(await boot({}, {}));
  });

  test('global acp.json {"delegate": false}: all three surfaces off', async () => {
    assertDelegateOff(await boot({}, { global: { delegate: false } }));
  });

  test('object form {"delegate": {"enabled": false}} is equivalent to the boolean shorthand', async () => {
    assertDelegateOff(await boot({}, { global: { delegate: { enabled: false } } }));
  });

  test("project-level acp.json overrides global in both directions", async () => {
    assertDelegateOff(await boot({}, { global: { delegate: true }, project: { delegate: false } }));
    assertDelegateOn(await boot({}, { global: { delegate: false }, project: { delegate: true } }));
  });
});
