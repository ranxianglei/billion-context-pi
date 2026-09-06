import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";

// #283 (billion-context#499): outbound view must stay byte-identical across a
// process restart — compression state reloads from <sessionFile>.acp.json, so
// the previously-sent prefix must still match the provider's prompt cache.

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

const ADAPTER = { modelContextLimit: 200_000, autoUpdate: false };

async function boot(handlers: Map<string, ((event: any, ctx: any) => any)[]>, ctx: any): Promise<void> {
    await handlers.get("session_start")![0]!({}, ctx);
}

function eventOf(entries: any[]) {
    return { type: "context", messages: entries.map((e) => ({ role: e.message.role, content: [{ type: "text", text: e.message.content }], timestamp: 0 })) };
}

test("outbound view is byte-identical across a simulated restart (state reloaded from disk)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-restart-"));
    const stateFile = join(dir, "s.session.jsonl");
    const filler = "the quick brown fox jumps over the lazy dog. ".repeat(30);
    const entries: any[] = [];
    let n = 0;

    // ── Phase 1: original process ──────────────────────────────────────────
    const A = captureApi();
    createAcpExtension({ ...ADAPTER })(A.api as any);
    await boot(A.handlers, fakeCtx(entries, stateFile, "sess-original", dir));
    const roundA = async () => {
        const res = await A.handlers.get("context")![0]!(eventOf(entries), fakeCtx(entries, stateFile, "sess-original", dir));
        return res.messages as any[];
    };

    for (let t = 1; t <= 10; t++) {
        entries.push(entry(`u${++n}`, "user", `user turn ${t}: ${filler}`));
        await roundA();
        entries.push(entry(`a${++n}`, "assistant", `assistant reply ${t}: ${filler}`));
    }

    const compressTool = A.api.tools.find((t: any) => t.name === "compress")!;
    const out = await compressTool.execute(
        "tc1",
        { content: [{ startId: "m00002", endId: "m00016", summary: "restart-audit summary of the compressed middle segment covering turns two through eight with per-turn filler measurements recorded for later review" }] },
        undefined, undefined, fakeCtx(entries, stateFile, "sess-original", dir),
    );
    const outText = typeof out === "string" ? out : out?.content?.[0]?.text ?? String(out);
    assert.ok(!outText.includes("FAILED"), `compression should succeed: ${outText}`);
    assert.ok(outText.includes("block"), `compression should create a block: ${outText}`);

    for (let t = 11; t <= 14; t++) {
        entries.push(entry(`u${++n}`, "user", `post turn ${t}: ${filler}`));
        await roundA();
        entries.push(entry(`a${++n}`, "assistant", `post reply ${t}: ${filler}`));
    }

    const preRestart = (await roundA()).map((m) => JSON.stringify(m));
    assert.ok(existsSync(stateFile + ".acp.json"), "state must be persisted to disk before the simulated restart");

    // ── Phase 2: simulated restart — fresh extension instance (fresh runtime,
    // fresh in-memory store), same session file + entries. Worst case included:
    // the session ID CHANGES (as it does across fork/clone); the state key is
    // the file, so routing must not depend on the id. ────────────────────────
    const B = captureApi();
    createAcpExtension({ ...ADAPTER })(B.api as any);
    await boot(B.handlers, fakeCtx(entries, stateFile, "sess-after-restart", dir));
    const postRestart = ((await B.handlers.get("context")![0]!(eventOf(entries), fakeCtx(entries, stateFile, "sess-after-restart", dir))).messages as any[]).map((m) => JSON.stringify(m));

    console.log(`entries=${entries.length} preMsgs=${preRestart.length} postMsgs=${postRestart.length}`);
    assert.deepEqual(postRestart, preRestart, "post-restart outbound view must be byte-identical to the pre-restart view (prefix cache preserved)");

    // ── Phase 3: growth after restart stays append-only stable (re-anchored) ─
    const views = [postRestart];
    for (let t = 15; t <= 18; t++) {
        entries.push(entry(`u${++n}`, "user", `late turn ${t}: ${filler}`));
        const res = await B.handlers.get("context")![0]!(eventOf(entries), fakeCtx(entries, stateFile, "sess-after-restart", dir));
        views.push((res.messages as any[]).map((m) => JSON.stringify(m)));
        entries.push(entry(`a${++n}`, "assistant", `late reply ${t}: ${filler}`));
    }
    for (let i = 1; i < views.length; i++) {
        const prev = views[i - 1]!;
        const cur = views[i]!;
        for (let k = 0; k < prev.length; k++) {
            assert.equal(cur[k], prev[k], `message ${k} diverged after restart growth (round ${i})`);
        }
        assert.ok(cur.length >= prev.length, "view must stay append-only");
    }

    await rm(dir, { recursive: true, force: true });
});
