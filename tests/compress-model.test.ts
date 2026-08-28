import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CompressionModelClient,
  buildSummarizeSystemPrompt,
  truncateContent,
  type CompleteFn,
} from "../src/compress-model.js";
import { saveCompressionModelId, loadUserConfig } from "../src/user-config.js";

// models.json with two providers; "test-unique-a" appears in BOTH (for the
// ambiguity case), "test-unique-b" only in testprov.
const MODELS_JSON = {
  providers: {
    testprov: {
      name: "Test Provider",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test",
      api: "openai-completions",
      models: [
        { id: "test-unique-a", name: "Test A", contextWindow: 1000, maxTokens: 100 },
        { id: "test-unique-b", name: "Test B", contextWindow: 1000, maxTokens: 100 },
      ],
    },
    testprov2: {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test",
      api: "openai-completions",
      models: [{ id: "test-unique-a", name: "Test A (2)", contextWindow: 1000, maxTokens: 100 }],
    },
  },
};

function mockComplete(response: { text?: string; stopReason?: string; errorMessage?: string }): CompleteFn {
  return async () =>
    ({
      role: "assistant",
      content: response.text !== undefined ? [{ type: "text", text: response.text }] : [],
      api: "openai-completions",
      provider: "testprov",
      model: "test-unique-a",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: response.stopReason ?? "stop",
      timestamp: Date.now(),
      ...(response.errorMessage !== undefined ? { errorMessage: response.errorMessage } : {}),
    }) as never;
}

let tmp: string;
let modelsPath: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acp-compress-model-"));
  modelsPath = path.join(tmp, "models.json");
  await fs.writeFile(modelsPath, JSON.stringify(MODELS_JSON, null, 2));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("listModels reads only models.json providers (not built-ins)", async () => {
  const client = new CompressionModelClient({ modelsPath });
  const models = await client.listModels();
  assert.deepEqual(
    models.map((m) => `${m.provider}/${m.id}`).sort(),
    ["testprov/test-unique-a", "testprov/test-unique-b", "testprov2/test-unique-a"].sort(),
  );
});

test("resolveModel: explicit provider/id resolves", async () => {
  const client = new CompressionModelClient({ modelsPath });
  const r = await client.resolveModel("testprov/test-unique-b");
  assert.ok(r.model, "should resolve");
  assert.equal(r.model!.provider, "testprov");
  assert.equal(r.model!.id, "test-unique-b");
  assert.deepEqual(r.ambiguous, []);
});

test("resolveModel: unique bare id resolves", async () => {
  const client = new CompressionModelClient({ modelsPath });
  const r = await client.resolveModel("test-unique-b");
  assert.ok(r.model, "should resolve");
  assert.equal(r.model!.id, "test-unique-b");
  assert.deepEqual(r.ambiguous, []);
});

test("resolveModel: ambiguous bare id returns candidates", async () => {
  const client = new CompressionModelClient({ modelsPath });
  const r = await client.resolveModel("test-unique-a");
  assert.equal(r.model, null, "ambiguous → no single model");
  assert.deepEqual(
    r.ambiguous.map((m) => `${m.provider}/${m.id}`).sort(),
    ["testprov/test-unique-a", "testprov2/test-unique-a"].sort(),
  );
});

test("resolveModel: unknown ref → null, no ambiguity", async () => {
  const client = new CompressionModelClient({ modelsPath });
  const r = await client.resolveModel("definitely-not-a-model-xyz");
  assert.equal(r.model, null);
  assert.deepEqual(r.ambiguous, []);
});

test("summarize: returns the compression model's text", async () => {
  const client = new CompressionModelClient({ modelsPath, complete: mockComplete({ text: "  THE-SUMMARY  " }) });
  const resolved = (await client.resolveModel("testprov/test-unique-b")).model!;
  const out = await client.summarize(resolved, "[user] hello", "sys prompt", 500);
  assert.equal(out, "THE-SUMMARY");
});

test("summarize: API error stopReason throws (triggers fallback)", async () => {
  const client = new CompressionModelClient({ modelsPath, complete: mockComplete({ stopReason: "error", errorMessage: "boom" }) });
  const resolved = (await client.resolveModel("testprov/test-unique-b")).model!;
  await assert.rejects(() => client.summarize(resolved, "content", "sys", 500), /boom/);
});

test("summarize: empty/whitespace response throws (triggers fallback)", async () => {
  const client = new CompressionModelClient({ modelsPath, complete: mockComplete({ text: "   " }) });
  const resolved = (await client.resolveModel("testprov/test-unique-b")).model!;
  await assert.rejects(() => client.summarize(resolved, "content", "sys", 500), /empty/);
});

test("buildSummarizeSystemPrompt includes topic and tier-1 rules", () => {
  const p = buildSummarizeSystemPrompt({ compressPhilosophy: "PHIL", howToCompressRules: "RULES" }, "Auth Work");
  assert.ok(p.includes("PHIL"));
  assert.ok(p.includes("RULES"));
  assert.ok(p.includes("Auth Work"));
});

test("truncateContent keeps head and tail when over the cap", () => {
  const content = "H".repeat(50) + "M".repeat(200) + "T".repeat(50);
  const out = truncateContent(content, 120);
  assert.ok(out.length <= 120, `length ${out.length} > 120`);
  assert.ok(out.startsWith("H".repeat(20)), "keeps head");
  assert.ok(out.endsWith("T".repeat(20)), "keeps tail");
  assert.ok(out.includes("[... truncated ...]"), "has marker");
});

test("truncateContent is a no-op under the cap", () => {
  assert.equal(truncateContent("short", 100), "short");
});

// ─── persistence (saveCompressionModelId ↔ loadUserConfig) ──────────────────

test("saveCompressionModelId writes, reads back, and clears (isolated HOME)", async () => {
  const prevHome = process.env.HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-home-"));
  process.env.HOME = home;
  try {
    await saveCompressionModelId("testprov/test-unique-b");
    const acpJson = path.join(home, ".pi", "acp.json");
    const written = JSON.parse(await fs.readFile(acpJson, "utf8"));
    assert.equal(written.compressionModelId, "testprov/test-unique-b");

    // loadUserConfig (cwd outside home) picks up the global value.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acp-cwd-"));
    const cfg = await loadUserConfig(cwd);
    assert.equal(cfg.compressionModelId, "testprov/test-unique-b");

    await saveCompressionModelId(null);
    const cleared = JSON.parse(await fs.readFile(acpJson, "utf8"));
    assert.equal(cleared.compressionModelId, undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
