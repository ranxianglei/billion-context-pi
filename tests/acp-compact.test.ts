import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createAcpExtension } from "../src/index.js";

// ─── helpers (mirror compress-tool.test.ts) ─────────────────────────────────

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

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function fakeCtx(entries: any[], stateFile: string, cwd: string, onNotify?: (s: string) => void, model?: any) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd,
    ui: { notify: (s: string) => onNotify?.(s) ?? undefined, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: model ?? { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

// A full pi-ai Model pointing at a local mock SSE server, used as the
// "session" compression model (ctx.model) so the shared-prefix call is a real
// request we can inspect and stub.
function sessionModel(baseUrl: string): any {
  return {
    id: "session-model",
    name: "Session Model",
    provider: "testprov",
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4000,
    maxTokens: 2000,
    headers: { Authorization: "Bearer sk-test" },
  };
}

async function readBlockSummaries(stateFile: string): Promise<string[]> {
  const raw = await fs.readFile(`${stateFile}.acp.json`, "utf8");
  const state = JSON.parse(raw);
  return (state.blocks ?? []).map((b: { summary: string }) => b.summary);
}

// The kernel protects the last 5 messages AND the trailing ~5000 tokens
// (preserveRecentMessages=5, preserveRecentTokens=5000). To make the OLDEST
// message (m00001) compressible: it must be >= minCompressRange (5000 chars)
// AND the fillers after it must sum to >= 5000 tokens so the token-protection
// window stops before reaching m00001.
const LONG = "lorem ipsum dolor sit amet ".repeat(400); // ~8800 chars (target)
const FILLER = "filler text for padding purposes ".repeat(150); // ~4200 chars ≈ 1050 tokens
function compressibleEntries(): any[] {
  const out = [userMsg("e1", LONG)];
  for (let i = 2; i <= 7; i++) out.push(userMsg(`e${i}`, FILLER)); // 6 × ~1050 = ~6300 tokens
  return out; // m00001 = LONG (compressible), m00002..m00007 = fillers
}

// ─── env + models.json setup ────────────────────────────────────────────────

let tmp: string;
let agentDir: string;
let modelsJsonPath: string;
let acpJsonPath: string;
const prevHome = process.env.HOME;
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acp-compact-"));
  agentDir = path.join(tmp, ".pi", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  modelsJsonPath = path.join(agentDir, "models.json");
  acpJsonPath = path.join(tmp, ".pi", "acp.json");
  process.env.HOME = tmp;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

function writeModelsJson(baseUrl: string): void {
  void fs.writeFile(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        testprov: {
          baseUrl,
          apiKey: "sk-test",
          api: "openai-completions",
          models: [{ id: "mini-summarizer", name: "Mini Summarizer", contextWindow: 4000, maxTokens: 2000 }],
        },
      },
    }),
  );
}

// ─── /acp compact command ───────────────────────────────────────────────────

test("/acp compact (no args) lists models.json models when unset", async () => {
  await writeModelsJson("http://127.0.0.1:1/v1");
  await fs.rm(acpJsonPath, { force: true });
  const { api } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "list-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  let out = "";
  const ctx = fakeCtx([userMsg("e1", "hello")], stateFile, tmp, (s) => (out = s));
  await api.commands.get("acp").handler("compact", ctx);
  assert.ok(out.includes("NOT SET"), `expected NOT SET status, got: ${out}`);
  assert.ok(out.includes("testprov/mini-summarizer"), `expected model listed, got: ${out}`);
});

test("/acp compact <id> sets the model (in-memory ref + acp.json)", async () => {
  await writeModelsJson("http://127.0.0.1:1/v1");
  await fs.rm(acpJsonPath, { force: true });
  const { api } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "set-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  let out = "";
  const ctx = fakeCtx([userMsg("e1", "hello")], stateFile, tmp, (s) => (out = s));
  await api.commands.get("acp").handler("compact testprov/mini-summarizer", ctx);
  assert.ok(out.includes("set to testprov/mini-summarizer"), `expected set confirmation, got: ${out}`);
  const written = JSON.parse(await fs.readFile(acpJsonPath, "utf8"));
  assert.equal(written.compressionModelId, "testprov/mini-summarizer");
});

test("/acp compact <unknown-id> reports not found + lists available", async () => {
  await writeModelsJson("http://127.0.0.1:1/v1");
  const { api } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "unknown-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  let out = "";
  const ctx = fakeCtx([userMsg("e1", "hello")], stateFile, tmp, (s) => (out = s));
  await api.commands.get("acp").handler("compact no-such-model", ctx);
  assert.ok(out.includes("not found"), `expected not-found, got: ${out}`);
  assert.ok(out.includes("testprov/mini-summarizer"), `expected available list, got: ${out}`);
});

test("/acp compact reset clears the model", async () => {
  await writeModelsJson("http://127.0.0.1:1/v1");
  await fs.writeFile(acpJsonPath, JSON.stringify({ compressionModelId: "testprov/mini-summarizer" }));
  const { api } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "reset-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  let out = "";
  const ctx = fakeCtx([userMsg("e1", "hello")], stateFile, tmp, (s) => (out = s));
  await api.commands.get("acp").handler("compact reset", ctx);
  assert.ok(out.includes("cleared"), `expected cleared, got: ${out}`);
  const written = JSON.parse(await fs.readFile(acpJsonPath, "utf8"));
  assert.equal(written.compressionModelId, undefined);
});

// ─── handleCompress routing ─────────────────────────────────────────────────

// >= 50 chars (kernel minSummaryLength) so the generated summary is accepted.
// (summarize() trims, so no trailing space — matches what gets stored.)
const MOCK_SUMMARY = "MOCK-SUMMARY: dedicated compression model output for this compressed range.";

test("compress: dedicated model writes the summary (mock SSE server)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (o: unknown) => res.write("data: " + JSON.stringify(o) + "\n\n");
    chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: MOCK_SUMMARY }, finish_reason: null }] });
    chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await writeModelsJson(`http://127.0.0.1:${port}/v1`);
    await fs.rm(acpJsonPath, { force: true });
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const stateFile = path.join(tmp, "success-state.json");
    await fs.rm(`${stateFile}.acp.json`, { force: true });
    const entries = compressibleEntries();
    const ctx = fakeCtx(entries, stateFile, tmp);
    // Assign mNNNNN refs (the context transform does this each turn).
    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

    // Set the compression model via the command (updates in-memory ref).
    await api.commands.get("acp").handler("compact testprov/mini-summarizer", ctx);

    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const out = await compressTool.execute(
      "tc1",
      { content: [{ startId: "m00001", endId: "m00001", summary: "placeholder-from-main-model" }] },
      undefined, undefined, ctx,
    );
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.ok(text.includes("summaries written by testprov/mini-summarizer"), `expected compression-model note, got: ${text}`);

    const summaries = await readBlockSummaries(stateFile);
    assert.ok(summaries.some((s) => s === MOCK_SUMMARY), `expected block summary from mock model, got: ${JSON.stringify(summaries)}`);
    assert.ok(!summaries.some((s) => s === "placeholder-from-main-model"), "placeholder must be overridden");
  } finally {
    server.close();
  }
});

test("compress: falls back to main model when the compression model is unreachable", async () => {
  // Port 1 → connection refused → complete() fails → fallback.
  await writeModelsJson("http://127.0.0.1:1/v1");
  await fs.rm(acpJsonPath, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "fallback-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  const entries = compressibleEntries();
  const ctx = fakeCtx(entries, stateFile, tmp);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  await api.commands.get("acp").handler("compact testprov/mini-summarizer", ctx);

  const FALLBACK_SUMMARY = "main-model fallback summary used because the compression model was unreachable. ";
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: FALLBACK_SUMMARY }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  // Compression still succeeds (no interruption) using the main model's summary.
  assert.ok(text.includes("▣ ACP |"), `expected a success panel, got: ${text}`);

  const summaries = await readBlockSummaries(stateFile);
  assert.ok(summaries.some((s) => s === FALLBACK_SUMMARY), `expected main-model fallback summary, got: ${JSON.stringify(summaries)}`);
});

// ─── /acp compact session (shared-prefix path) ──────────────────────────────

// >= 50 chars (kernel minSummaryLength), no trailing space (summarize trims).
const SESSION_SUMMARY = "SESSION-SUMMARY: shared-prefix compression model output for this range.";

test("/acp compact session sets compressionModelId to 'session'", async () => {
  await fs.rm(acpJsonPath, { force: true });
  const { api } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "sess-set-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  let out = "";
  const ctx = fakeCtx([userMsg("e1", "hello")], stateFile, tmp, (s) => (out = s));
  await api.commands.get("acp").handler("compact session", ctx);
  assert.ok(out.includes("set to session"), `expected session confirmation, got: ${out}`);
  const written = JSON.parse(await fs.readFile(acpJsonPath, "utf8"));
  assert.equal(written.compressionModelId, "session");
});

test("/acp compact (no args) shows current 'session' model", async () => {
  await fs.writeFile(acpJsonPath, JSON.stringify({ compressionModelId: "session" }));
  const { api } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "sess-status-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  let out = "";
  const ctx = fakeCtx([userMsg("e1", "hello")], stateFile, tmp, (s) => (out = s));
  await api.commands.get("acp").handler("compact", ctx);
  assert.ok(out.includes("session"), `expected session status, got: ${out}`);
});

test("compress: session model writes the summary reusing the shared prefix", async () => {
  let receivedBody = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      receivedBody = body;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o: unknown) => res.write("data: " + JSON.stringify(o) + "\n\n");
      chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: SESSION_SUMMARY }, finish_reason: null }] });
      chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    // Both the session model (ctx.model) and the registry point at the mock.
    await writeModelsJson(baseUrl);
    await fs.rm(acpJsonPath, { force: true });
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const stateFile = path.join(tmp, "sess-success-state.json");
    await fs.rm(`${stateFile}.acp.json`, { force: true });
    const entries = compressibleEntries();
    const ctx = fakeCtx(entries, stateFile, tmp, undefined, sessionModel(baseUrl));
    // Capture the transformed messages (the shared prefix) via a context round.
    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

    await api.commands.get("acp").handler("compact session", ctx);

    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const out = await compressTool.execute(
      "tc1",
      { content: [{ startId: "m00001", endId: "m00001", summary: "placeholder-from-main-model" }] },
      undefined, undefined, ctx,
    );
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.ok(text.includes("summaries written by session model"), `expected session note, got: ${text}`);

    const summaries = await readBlockSummaries(stateFile);
    assert.ok(summaries.some((s) => s === SESSION_SUMMARY), `expected session-model summary, got: ${JSON.stringify(summaries)}`);
    // The shared prefix (captured transformed messages) must be in the request.
    assert.ok(receivedBody.includes("lorem ipsum"), `expected shared prefix in request body, got: ${receivedBody.slice(0, 200)}`);
  } finally {
    server.close();
  }
});

test("compress: session model falls back to main model on error", async () => {
  // Unreachable session model (port 1) → complete() fails → main-model fallback.
  await writeModelsJson("http://127.0.0.1:1/v1");
  await fs.rm(acpJsonPath, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const stateFile = path.join(tmp, "sess-fallback-state.json");
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  const entries = compressibleEntries();
  const ctx = fakeCtx(entries, stateFile, tmp, undefined, sessionModel("http://127.0.0.1:1/v1"));
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  await api.commands.get("acp").handler("compact session", ctx);

  const FALLBACK = "session-model fallback summary used because the session compression call failed. ";
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: FALLBACK }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(text.includes("▣ ACP |"), `expected a success panel, got: ${text}`);

  const summaries = await readBlockSummaries(stateFile);
  assert.ok(summaries.some((s) => s === FALLBACK), `expected main-model fallback summary, got: ${JSON.stringify(summaries)}`);
});
