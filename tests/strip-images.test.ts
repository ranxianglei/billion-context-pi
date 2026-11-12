import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { apiToStripProtocol, applyStripImages } from "../src/strip-images.js";
import { resolveCompress } from "../src/config.js";

// Issue #321 (ranxianglei/billion-context-pi#321): opt-in wire-level strip of
// historical image payloads via acp-kernel's stripHistoricalImages (kernel
// #215). The strip runs at pi's before_provider_request hook on the RAW
// serialized body, before the HTTP call. Default OFF.

test("apiToStripProtocol maps known pi-ai APIs, null for everything else", () => {
    assert.equal(apiToStripProtocol("anthropic-messages"), "anthropic");
    assert.equal(apiToStripProtocol("openai-completions"), "openai");
    assert.equal(apiToStripProtocol("openai-responses"), "responses");
    assert.equal(apiToStripProtocol("azure-openai-responses"), "responses");
    assert.equal(apiToStripProtocol("openai-codex-responses"), "responses");
    // Unsupported / exotic dialects must never be mangled.
    assert.equal(apiToStripProtocol("bedrock-converse-stream"), null);
    assert.equal(apiToStripProtocol("google-generative-ai"), null);
    assert.equal(apiToStripProtocol(undefined), null);
    assert.equal(apiToStripProtocol("some-future-api"), null);
});

function anthropicBody(n: number) {
    return {
        model: "claude",
        system: "sys",
        messages: Array.from({ length: n }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: [{ type: "image", source: { type: "base64", data: `img-${i}` } }, { type: "text", text: `t${i}` }],
        })),
    };
}

test("applyStripImages: disabled / unknown api / no-op bodies return removed 0 and no replacement", () => {
    const body = anthropicBody(8);
    assert.deepEqual(applyStripImages(body, "anthropic-messages", { enabled: false, keepRecent: 5 }), { removed: 0 });
    assert.deepEqual(applyStripImages(body, "bedrock-converse-stream", { enabled: true, keepRecent: 5 }), { removed: 0 });
    // Text-only body: nothing to strip, kernel returns the input reference.
    const textOnly = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    assert.deepEqual(applyStripImages(textOnly, "anthropic-messages", { enabled: true, keepRecent: 5 }), { removed: 0 });
});

test("applyStripImages: anthropic — older-than-keepRecent image parts dropped, recent kept", () => {
    const body = anthropicBody(8); // images in messages 0..7
    const out = applyStripImages(body, "anthropic-messages", { enabled: true, keepRecent: 5 });
    assert.equal(out.removed, 3); // messages 0,1,2 are older than the last 5
    assert.notEqual(out.body, body);
    const msgs = (out.body as typeof body).messages;
    assert.ok(!JSON.stringify(msgs[0]).includes("img-0"), "old image gone");
    assert.ok(JSON.stringify(msgs[5]).includes("img-5"), "recent image kept");
    assert.ok(JSON.stringify(msgs[7]).includes("img-7"), "newest image kept");
    // Text parts survive alongside the strip.
    assert.ok(JSON.stringify(msgs[0]).includes("t0"));
});

test("applyStripImages: openai + responses dialects strip their own part types", () => {
    const openai = {
        messages: Array.from({ length: 6 }, (_, i) => ({
            role: "user",
            content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${i}` } }],
        })),
    };
    const outO = applyStripImages(openai, "openai-completions", { enabled: true, keepRecent: 2 });
    assert.equal(outO.removed, 4);
    // Image-only message collapses to a text placeholder, message count stable.
    const msgsO = (outO.body as typeof openai).messages;
    assert.equal(msgsO.length, 6);
    assert.deepEqual(msgsO[0].content, [{ type: "text", text: "[image]" }]);

    const responses = {
        model: "gpt",
        input: [
            { role: "user", content: [{ type: "input_image", image_url: `data:${0}` }] },
            { role: "user", content: [{ type: "input_image", image_url: `data:${1}` }] },
            { role: "user", content: [{ type: "input_text", text: "tail" }] },
        ],
    };
    const outR = applyStripImages(responses, "openai-responses", { enabled: true, keepRecent: 1 });
    assert.equal(outR.removed, 2); // items 0 and 1 are older than the last 1
    assert.deepEqual((outR.body as typeof responses).input[0].content, [{ type: "input_text", text: "[image]" }]);
    assert.ok((outR.body as typeof responses).input[2].content[0].type === "input_text", "non-image tail untouched");
});

test("resolveCompress: stripImages fields follow the three-level deepest-wins merge", () => {
    const c = resolveCompress(
        {
            stripImages: true,
            stripImagesKeepRecent: 5,
            providers: {
                "anthropic": { stripImagesKeepRecent: 9, models: { "claude-x": { stripImages: false } } },
            },
        },
        "anthropic",
        "claude-x",
    );
    assert.equal(c.stripImages, false); // model level wins
    assert.equal(c.stripImagesKeepRecent, 9); // provider level wins over global
    const other = resolveCompress(
        { stripImages: true, stripImagesKeepRecent: 5, providers: { "anthropic": { stripImagesKeepRecent: 9, models: { "claude-x": { stripImages: false } } } } },
        "anthropic",
        "other-model",
    );
    assert.equal(other.stripImages, true); // global inherited
    const off = resolveCompress(undefined, undefined, undefined);
    assert.equal(off.stripImages, undefined); // default: never strip
});

// --- End-to-end through the extension's registered before_provider_request handler ---

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

function ctxFor(model: Record<string, unknown> = {}) {
    return {
        mode: "rpc",
        hasUI: false,
        cwd: join(tmpdir(), "strip-images-cwd"),
        ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
        model: { contextWindow: 200_000, id: "test-model", ...model },
        sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/none.jsonl" },
    };
}

async function stripViaHandler(adapter: any, model: Record<string, unknown>, payload: unknown) {
    const { api, handlers } = captureApi();
    createAcpExtension(adapter)(api as any);
    const h = handlers.get("before_provider_request")!;
    assert.ok(h.length >= 1, "handler registered");
    return await h[0]!({ type: "before_provider_request", payload }, ctxFor(model));
}

test("before_provider_request: strips historical images when compress.stripImages is on", async () => {
    const payload = anthropicBody(8);
    const result = await stripViaHandler(
        { modelContextLimit: 200_000, autoUpdate: false, compress: { stripImages: true } },
        { api: "anthropic-messages" },
        payload,
    );
    assert.ok(result && typeof result === "object");
    assert.ok(!JSON.stringify(result).includes("img-0"), "historical image stripped on the wire");
    assert.ok(JSON.stringify(result).includes("img-7"), "recent image kept");
});

test("before_provider_request: default off leaves the payload reference untouched", async () => {
    const payload = anthropicBody(8);
    const result = await stripViaHandler(
        { modelContextLimit: 200_000, autoUpdate: false },
        { api: "anthropic-images" },
        payload,
    );
    assert.equal(result, undefined, "no replacement body when disabled");
});

test("before_provider_request: bili-proxy baseUrl stands down even when enabled", async () => {
    const payload = anthropicBody(8);
    const result = await stripViaHandler(
        { modelContextLimit: 200_000, autoUpdate: false, compress: { stripImages: true } },
        { api: "anthropic-messages", baseUrl: "http://127.0.0.1:9111/bili/https://api.anthropic.com" },
        payload,
    );
    assert.equal(result, undefined, "proxy owns the wire; extension must not touch the body");
});
