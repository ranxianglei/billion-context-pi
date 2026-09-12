import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../src/runtime.js";

// [#361] E2E wiring for the strict-echo gate: drives the REAL production path
// (createRuntime → reloadConfig → reasoningDropFor), complementing the pure-function
// tests in reasoning-drop.test.ts. Proves ctx.model.baseUrl reaches the gate (not just
// the provider name), an explicit drop:true loses to the safety override, and the
// info log fires exactly once per session.

function ctxFor(provider: string | undefined, baseUrl: string | undefined, sid = "s1"): ExtensionContext {
    return { model: { provider, baseUrl }, sessionManager: { getSessionId: () => sid } } as unknown as ExtensionContext;
}

async function withIsolatedHome(json: unknown, fn: (cwd: string) => Promise<void>): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "pai-acp-e2e-gate-"));
    if (json !== undefined) {
        await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
        await writeFile(join(cwd, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(json));
    }
    const savedHome = process.env.HOME;
    const savedLog = process.env.ACP_LOG_FILE;
    process.env.HOME = cwd;
    process.env.ACP_LOG_FILE = join(cwd, "acp.log");
    try {
        await fn(cwd);
    } finally {
        process.env.HOME = savedHome;
        process.env.ACP_LOG_FILE = savedLog;
        await rm(cwd, { recursive: true, force: true });
    }
}

test("e2e gate: default drop:true is auto-disabled through the real pipeline on a strict-echo upstream", async () => {
    await withIsolatedHome(undefined, async (cwd) => {
        const runtime = createRuntime({});
        await runtime.reloadConfig(cwd);

        // Provider name does NOT contain "deepseek" — only the baseUrl does — proving
        // ctx.model.baseUrl reaches the gate, not just m.provider.
        const gated = runtime.reasoningDropFor(ctxFor("my-proxy", "https://api.deepseek.com/v1", "s1"));
        assert.equal(gated.drop, false, "default drop:true forced off on a strict-echo upstream");
        assert.equal(gated.threshold, 2048, "threshold preserved by the gate");

        const plain = runtime.reasoningDropFor(ctxFor("openai", "https://api.openai.com/v1", "s2"));
        assert.equal(plain.drop, true, "non-strict upstream keeps the pass");

        runtime.reasoningDropFor(ctxFor("my-proxy", "https://api.deepseek.com/v1", "s1")); // repeat, same session
        runtime.reasoningDropFor(ctxFor(undefined, "https://api.deepseek.com/v1", "s3"));  // new session

        const log = await readFile(join(cwd, "acp.log"), "utf8");
        const lines = log.split("\n").filter((l) => l.includes("event=compress-reasoning-auto-disabled"));
        assert.equal(lines.length, 2, "logged once per session (s1 repeated, s3 new)");
        assert.ok(lines[0]!.includes("sid=s1"), "first line belongs to session s1");
        assert.ok(lines[0]!.includes("provider=my-proxy"), "log carries the provider signal");
        assert.ok(lines[1]!.includes("sid=s3"), "second line belongs to the new session s3");
    });
});

test("e2e gate: explicit drop:true in acp.json still loses to the safety gate", async () => {
    const json = {
        compress: {
            reasoning: { drop: true },
            providers: { deepseek: { reasoning: { drop: true, threshold: 4096 } } },
        },
    };
    await withIsolatedHome(json, async (cwd) => {
        const runtime = createRuntime({});
        await runtime.reloadConfig(cwd);

        const gated = runtime.reasoningDropFor(ctxFor("deepseek", undefined, "d1"));
        assert.equal(gated.drop, false, "explicit drop:true overridden on a strict-echo upstream (safety wins)");
        assert.equal(gated.threshold, 4096, "provider-level threshold survives the gate");

        const plain = runtime.reasoningDropFor(ctxFor("anthropic", "https://api.anthropic.com", "d2"));
        assert.equal(plain.drop, true, "explicit drop:true honored for non-strict providers");
    });
});
