import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";

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

function fakeCtx(entries: any[], stateFile: string) {
    return {
        mode: "rpc",
        hasUI: false,
        ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
        model: { contextWindow: 200_000, id: "test-model" },
        sessionManager: {
            getBranch: () => entries,
            getSessionId: () => "prefix-stab-session",
            getSessionFile: () => stateFile,
        },
    };
}

test("outbound provider view stays byte-stable across context rounds; compression rewrites it exactly once", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000, rollover: false })(api as any);
    const dir = await mkdtemp(join(tmpdir(), "pi-prefix-"));
    const stateFile = join(dir, "s.session.json");

    const filler = "the quick brown fox jumps over the lazy dog. ".repeat(30);
    const entries: any[] = [];
    const views: any[][] = [];
    const ctxOf = () => fakeCtx(entries, stateFile);
    const runRound = async () => {
        const res = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => ({ role: e.message.role, content: [{ type: "text", text: e.message.content }], timestamp: 0 })) }, ctxOf());
        views.push(res.messages);
        return res;
    };

    const TURNS = 30;
    let n = 0;
    for (let t = 1; t <= TURNS; t++) {
        entries.push(entry(`u${++n}`, "user", `user turn ${t}: ${filler}`));
        await runRound();
        entries.push(entry(`a${++n}`, "assistant", `assistant reply ${t}: ${filler}`));
    }

    let stable = 0;
    const divergedAt: number[] = [];
    for (let i = 1; i < views.length; i++) {
        const prev = views[i - 1].map((m: any) => JSON.stringify(m));
        const cur = views[i].map((m: any) => JSON.stringify(m));
        let div = -1;
        for (let k = 0; k < Math.min(prev.length, cur.length); k++) if (prev[k] !== cur[k]) { div = k; break; }
        if (div === -1 && cur.length >= prev.length) stable++;
        else divergedAt.push(i);
    }
    console.log(`pre-compress: rounds=${views.length} stablePairs=${stable}/${views.length - 1} divergedAt=${JSON.stringify(divergedAt)}`);
    assert.equal(stable, views.length - 1, `pre-compress views must be append-only byte-stable, diverged at ${JSON.stringify(divergedAt)}`);

    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const out = await compressTool.execute(
        "tc1",
        { content: [{ startId: "m00002", endId: "m00020", summary: "stable summary of the compressed middle segment covering incremental growth and compression cycles with per-turn measurements recorded at each checkpoint along the way for later review and analysis" }] },
        undefined, undefined, ctxOf(),
    );
    const outText = typeof out === "string" ? out : out?.content?.[0]?.text ?? String(out);
    console.log("compress result:", outText.slice(0, 100));
    assert.ok(!outText.includes("FAILED"), `compression should succeed: ${outText}`);

    const pre = views.length;
    for (let t = 1; t <= 6; t++) {
        entries.push(entry(`u${++n}`, "user", `post turn ${t}: ${filler}`));
        await runRound();
        entries.push(entry(`a${++n}`, "assistant", `post reply ${t}: ${filler}`));
    }

    let postStable = 0;
    const postDiverged: number[] = [];
    for (let i = pre; i < views.length; i++) {
        const prev = views[i - 1].map((m: any) => JSON.stringify(m));
        const cur = views[i].map((m: any) => JSON.stringify(m));
        let div = -1;
        for (let k = 0; k < Math.min(prev.length, cur.length); k++) if (prev[k] !== cur[k]) { div = k; break; }
        if (div === -1 && cur.length >= prev.length) postStable++;
        else postDiverged.push(i - pre);
    }
    console.log(`post-compress: rounds=${views.length - pre} stablePairs=${postStable}/${views.length - pre} divergedAt(offset)=${JSON.stringify(postDiverged)}`);
    assert.deepEqual(postDiverged, [0], "exactly the first post-compression round may diverge (the rewrite), then re-anchor");
    assert.ok(postStable === views.length - pre - 1, "post-compression views must be append-only stable after the single rewrite");

    await rm(dir, { recursive: true, force: true });
});
