import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "../src/index.js";

// #409: the `delegate: false` escape hatch for users who bring their own sub-agent
// extension must remove BOTH halves of the acp_delegate surface — the three tools
// (registered at session_start) and the ACP_DELEGATE_NOTIFICATIONS system-prompt
// section (appended at before_agent_start). Gate: src/index.ts. tests/config.test.ts
// covers resolveDelegate() in isolation only, so this file drives the real
// registration / prompt wiring with a REAL acp.json on disk.

const DELEGATE_TOOLS = ["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"];
const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status"];
const DELEGATE_PROMPT_MARKER = "ACP_DELEGATE NOTIFICATIONS";
const ACP_PROMPT_MARKER = "ACP context management";

const ADAPTER = { modelContextLimit: 200_000, autoUpdate: false };

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
        registerShortcut() {},
        sendMessage() {},
    };
    return { api, handlers };
}

function fakeCtx(cwd: string) {
    return {
        mode: "rpc",
        hasUI: false,
        cwd,
        ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
        model: { contextWindow: 200_000, id: "test-model" },
        sessionManager: {
            buildContextEntries: () => [],
            getSessionId: () => "sess-delegate-toggle",
            getSessionFile: () => undefined,
        },
    };
}

async function boot(api: any, handlers: Map<string, ((event: any, ctx: any) => any)[]>, cwd: string) {
    const ctx = fakeCtx(cwd);
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const promptEvent = await handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctx);
    return { tools: (api.tools as any[]).map((t) => t.name as string), systemPrompt: promptEvent.systemPrompt as string };
}

/** Temp HOME + temp cwd: `global` lands in $HOME/.pi/acp.json, `project` in
 *  <cwd>/.pi/acp.json. Both are real files, so the production config path
 *  (loadUserConfig → applyUserConfig → reloadConfig) is what gets exercised. */
async function withConfigs(
    global: unknown,
    project: unknown,
    fn: (cwd: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-delegate-"));
    const home = join(root, "home");
    const cwd = join(root, "project");
    const savedHome = process.env.HOME;
    try {
        await mkdir(join(home, CONFIG_DIR_NAME), { recursive: true });
        await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
        if (global !== undefined) await writeFile(join(home, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(global));
        if (project !== undefined) await writeFile(join(cwd, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(project));
        process.env.HOME = home;
        await fn(cwd);
    } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        await rm(root, { recursive: true, force: true });
    }
}


test("delegate toggle: default config keeps the acp_delegate tools and prompt section", async () => {
    await withConfigs(undefined, undefined, async (cwd) => {
        const { api, handlers } = captureApi();
        createAcpExtension({ ...ADAPTER })(api as any);
        const { tools, systemPrompt } = await boot(api, handlers, cwd);
        for (const name of DELEGATE_TOOLS) assert.ok(tools.includes(name), `${name} registered by default`);
        assert.ok(systemPrompt.includes(DELEGATE_PROMPT_MARKER), "delegate prompt section present by default");
    });
});

test("delegate toggle: global {\"delegate\": false} drops the tools and the prompt section", async () => {
    await withConfigs({ delegate: false }, undefined, async (cwd) => {
        const { api, handlers } = captureApi();
        createAcpExtension({ ...ADAPTER })(api as any);
        const { tools, systemPrompt } = await boot(api, handlers, cwd);
        for (const name of DELEGATE_TOOLS) assert.ok(!tools.includes(name), `${name} must not be registered`);
        assert.ok(!systemPrompt.includes(DELEGATE_PROMPT_MARKER), "delegate prompt section must be gone");
        for (const name of ACP_TOOLS) assert.ok(tools.includes(name), `${name} must survive the delegate toggle`);
        assert.ok(systemPrompt.includes(ACP_PROMPT_MARKER), "ACP base prompt must survive the delegate toggle");
    });
});

test("delegate toggle: object form {\"delegate\": {\"enabled\": false}} is equivalent to the boolean shorthand", async () => {
    await withConfigs({ delegate: { enabled: false } }, undefined, async (cwd) => {
        const { api, handlers } = captureApi();
        createAcpExtension({ ...ADAPTER })(api as any);
        const { tools, systemPrompt } = await boot(api, handlers, cwd);
        for (const name of DELEGATE_TOOLS) assert.ok(!tools.includes(name), `${name} must not be registered`);
        assert.ok(!systemPrompt.includes(DELEGATE_PROMPT_MARKER), "delegate prompt section must be gone");
    });
});

test("delegate toggle: project acp.json wins over global in both directions", async () => {
    await withConfigs({ delegate: true }, { delegate: false }, async (cwd) => {
        const { api, handlers } = captureApi();
        createAcpExtension({ ...ADAPTER })(api as any);
        const { tools } = await boot(api, handlers, cwd);
        assert.ok(!tools.includes("acp_delegate"), "project delegate:false must override global delegate:true");
    });
    await withConfigs({ delegate: false }, { delegate: true }, async (cwd) => {
        const { api, handlers } = captureApi();
        createAcpExtension({ ...ADAPTER })(api as any);
        const { tools, systemPrompt } = await boot(api, handlers, cwd);
        assert.ok(tools.includes("acp_delegate"), "project delegate:true must override global delegate:false");
        assert.ok(systemPrompt.includes(DELEGATE_PROMPT_MARKER));
    });
});
