import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";

// Issue #299 (ranxianglei/billion-context-pi#299): pi's importFromJsonl copies
// only the .jsonl — the `<sessionFile>.acp.json` sidecar never travels with an
// imported session. Last-resort recovery: replay the successful compress calls
// recorded in the session log itself and rebuild the block state.

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

function entry(id: string, role: string, text: string) {
    return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: 0 } };
}

function assistantCallEntry(id: string, toolCallId: string, ranges: Array<{ startId: string; endId: string; summary: string }>) {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "",
        message: {
            role: "assistant",
            content: [
                { type: "toolCall", name: "compress", id: toolCallId, arguments: { content: ranges } },
            ],
            timestamp: 0,
        },
    };
}

function compressResultEntry(id: string, toolCallId: string, isError = false) {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "",
        message: {
            role: "toolResult",
            toolName: "compress",
            toolCallId,
            content: "▣ ACP | 5.2K → 0.8K tokens (~4.4K reclaimed, 1 block)",
            isError,
            timestamp: 0,
        },
    };
}

function fakeCtx(entries: any[], stateFile: string, sid: string, cwd: string) {
    return {
        mode: "rpc",
        hasUI: false,
        cwd,
        ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
        model: { contextWindow: 200_000, id: "test-model" },
        sessionManager: {
            buildContextEntries: () => entries,
            getSessionId: () => sid,
            getSessionFile: () => stateFile,
        },
    };
}

function eventOf(entries: any[]) {
    return { type: "context", messages: entries.map((e) => ({ role: e.message.role, content: [{ type: "text", text: e.message.content }], timestamp: 0 })) };
}

const ADAPTER = { modelContextLimit: 200_000, autoUpdate: false };
const LONG = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(80);

async function fire(handlers: Map<string, ((event: any, ctx: any) => any)[]>, entries: any[], ctx: any) {
    await handlers.get("session_start")![0]!({}, ctx);
    return handlers.get("context")![0]!(eventOf(entries), ctx);
}

test("state rebuilt by replaying compress calls from the log when sidecar is missing (import scenario)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rebuild-"));
    const stateFile = join(dir, "imported.session.jsonl");
    const entries = [
        entry("m1", "user", LONG),
        entry("m2", "user", LONG),
        entry("m3", "user", LONG),
        entry("m4", "user", LONG),
        entry("m5", "user", LONG),
        entry("m6", "user", LONG),
        entry("m7", "user", LONG),
        assistantCallEntry("m8", "c1", [{ startId: "m1", endId: "m2", summary: "S1 rebuilt summary text long enough to clear the fifty character minimum" }]),
        compressResultEntry("m9", "c1"),
        entry("m10", "user", "tail message"),
    ];
    const { api, handlers } = captureApi();
    createAcpExtension(ADAPTER)(api as any);
    const ctx = fakeCtx(entries, stateFile, "rebuild-1", dir);

    const rebuilt1 = (await fire(handlers, entries, ctx)) as any;
    // No sidecar existed; the log replay must have recreated it.
    assert.ok(existsSync(`${stateFile}.acp.json`), "sidecar recreated after replay");
    const saved = JSON.parse(readFileSync(`${stateFile}.acp.json`, "utf8"));
    assert.equal(saved.blocks.length, 1);
    assert.equal(saved.blocks[0].summary, "S1 rebuilt summary text long enough to clear the fifty character minimum");
    assert.deepEqual(saved.blocks[0].effectiveMessageIds, ["m1", "m2"]);
    assert.equal(saved.blocks[0].active, true);
    assert.ok((saved.blocks[0].compressedTokens ?? 0) > 0, "compressedTokens restored");
    // The rebuilt state must make a re-compress of the same range fail
    // ("already covered") — the double-compress regression #299 is about.
    const compressTool = (api.tools as any[]).find((t: any) => t.name === "compress")!;
    const again = await compressTool.execute(
        "tc-again",
        { content: [{ startId: "m1", endId: "m2", summary: "attempted duplicate compression summary that must be rejected by the rebuilt state" }] },
        undefined, undefined, ctx,
    );
    const againText = typeof again === "string" ? again : again?.content?.[0]?.text ?? String(again);
    assert.ok(/already|covered|no longer|not compressible|FAILED/i.test(againText), `duplicate compress rejected: ${againText.slice(0, 120)}`);

    // Second fire must NOT re-apply the replay (sidecar now has state).
    await fire(handlers, entries, ctx);
    const saved2 = JSON.parse(readFileSync(`${stateFile}.acp.json`, "utf8"));
    assert.equal(saved2.blocks.length, 1, "no double-apply on second fire");
    assert.equal(saved2.blocks[0].blockId, saved.blocks[0].blockId, "same block id across fires");
});

test("errored compress calls and no-history logs leave state empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rebuild-none-"));
    const stateFile = join(dir, "s.session.jsonl");
    const entries = [
        entry("m1", "user", LONG),
        entry("m2", "user", LONG),
        entry("m3", "user", LONG),
        entry("m4", "user", LONG),
        entry("m5", "user", LONG),
        entry("m6", "user", LONG),
        assistantCallEntry("m7", "c1", [{ startId: "m1", endId: "m1", summary: "must not apply this errored call summary over fifty characters" }]),
        compressResultEntry("m8", "c1", true),
        entry("m9", "user", "tail"),
    ];
    const { api, handlers } = captureApi();
    createAcpExtension(ADAPTER)(api as any);
    const ctx = fakeCtx(entries, stateFile, "rebuild-none", dir);

    await fire(handlers, entries, ctx);
    // Errored call must not be replayed: no blocks in the saved state.
    if (existsSync(`${stateFile}.acp.json`)) {
        const saved = JSON.parse(readFileSync(`${stateFile}.acp.json`, "utf8"));
        assert.equal(saved.blocks.length, 0);
    }
    await rm(dir, { recursive: true, force: true });
});

test("two sequential successful compress calls rebuild two blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rebuild-two-"));
    const stateFile = join(dir, "s.session.jsonl");
    const entries = [
        entry("m1", "user", LONG),
        entry("m2", "user", LONG),
        entry("m3", "user", LONG),
        entry("m4", "user", LONG),
        entry("m5", "user", LONG),
        entry("m6", "user", LONG),
        entry("m7", "user", LONG),
        assistantCallEntry("m8", "c1", [{ startId: "m1", endId: "m1", summary: "first block summary long enough to clear the fifty char minimum" }]),
        compressResultEntry("m9", "c1"),
        entry("m10", "user", LONG),
        entry("m11", "user", LONG),
        entry("m12", "user", LONG),
        assistantCallEntry("m13", "c2", [{ startId: "m2", endId: "m2", summary: "second block summary long enough to clear the fifty char minimum" }]),
        compressResultEntry("m14", "c2"),
        entry("m15", "user", "tail"),
    ];
    const { api, handlers } = captureApi();
    createAcpExtension(ADAPTER)(api as any);
    const ctx = fakeCtx(entries, stateFile, "rebuild-two", dir);

    await fire(handlers, entries, ctx);
    const saved = JSON.parse(readFileSync(`${stateFile}.acp.json`, "utf8"));
    assert.equal(saved.blocks.length, 2);
    assert.deepEqual(saved.blocks.map((b: any) => b.summary), ["first block summary long enough to clear the fifty char minimum", "second block summary long enough to clear the fifty char minimum"]);
    await rm(dir, { recursive: true, force: true });
});
