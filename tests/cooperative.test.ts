import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAcpExtension } from "../src/index.js";
import { proxyBaseFromUrl, proxyBaseFromEnv, forwardToolToProxy } from "../src/cooperative.js";

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
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

function fakeCtx(entries: any[], baseUrl?: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, baseUrl },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-pai-cooperative.session.json",
    },
  };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

const PROXY_URL = "http://127.0.0.1:8787/bili/https://api.anthropic.com";

test("proxyBaseFromUrl extracts the proxy origin only from /bili/ base URLs", () => {
  assert.equal(proxyBaseFromUrl(PROXY_URL), "http://127.0.0.1:8787");
  assert.equal(proxyBaseFromUrl("http://127.0.0.1:8787/bili/openai/https://api.openai.com/v1"), "http://127.0.0.1:8787");
  assert.equal(proxyBaseFromUrl("https://api.anthropic.com/v1/messages"), undefined);
  assert.equal(proxyBaseFromUrl("http://127.0.0.1:8787/v1/messages"), undefined);
  assert.equal(proxyBaseFromUrl(undefined), undefined);
  assert.equal(proxyBaseFromUrl("not a url"), undefined);
});

test("before_provider_headers announces plugin mode with pi's session id", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  assert.ok(handlers.has("before_provider_headers"), "before_provider_headers wired");

  const headers: Record<string, string | null> = {};
  await handlers.get("before_provider_headers")![0]!({ type: "before_provider_headers", headers }, fakeCtx([], PROXY_URL));
  assert.equal(headers["x-bili-plugin"], "pi");
  assert.equal(headers["x-bili-plugin-conversation"], "test-session");
  assert.equal(headers["x-bili-plugin-context-window"], "200000");

  const plain: Record<string, string | null> = {};
  await handlers.get("before_provider_headers")![0]!({ type: "before_provider_headers", headers: plain }, fakeCtx([], "https://api.anthropic.com"));
  assert.equal(plain["x-bili-plugin"], undefined);
  assert.equal(plain["x-bili-plugin-conversation"], undefined);
  assert.equal(plain["x-bili-plugin-context-window"], undefined);
});

test("BILLION_CONTEXT_PROXY enables cooperative mode without a /bili/ baseUrl (MITM launcher)", async () => {
  const prev = process.env.BILLION_CONTEXT_PROXY;
  process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
  try {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);

    const headers: Record<string, string | null> = {};
    await handlers.get("before_provider_headers")![0]!({ type: "before_provider_headers", headers }, fakeCtx([], "https://api.anthropic.com"));
    assert.equal(headers["x-bili-plugin"], "pi");
    assert.equal(headers["x-bili-plugin-conversation"], "test-session");
    assert.equal(headers["x-bili-plugin-context-window"], "200000");

    assert.equal(proxyBaseFromEnv(), "http://127.0.0.1:8787");
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9999/some/path";
    assert.equal(proxyBaseFromEnv(), "http://127.0.0.1:9999", "path is stripped to the origin");
    process.env.BILLION_CONTEXT_PROXY = "not a url";
    assert.equal(proxyBaseFromEnv(), undefined);
    delete process.env.BILLION_CONTEXT_PROXY;

    const plain: Record<string, string | null> = {};
    await handlers.get("before_provider_headers")![0]!({ type: "before_provider_headers", headers: plain }, fakeCtx([], "https://api.anthropic.com"));
    assert.equal(plain["x-bili-plugin"], undefined, "without env or /bili/ prefix cooperative mode is off");
  } finally {
    if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
    else process.env.BILLION_CONTEXT_PROXY = prev;
  }
});

test("context handler passes messages through untouched in cooperative mode", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);

  const entries = [userMsg("e1", "first"), userMsg("e2", "second")];
  const messages = entries.map((e) => e.message);
  const result = await handlers.get("context")![0]!({ type: "context", messages }, fakeCtx(entries, PROXY_URL));
  assert.equal(result.messages, messages, "must return the SAME array untransformed — the proxy owns tags/folding/nudges");
});

test("before_agent_start drops the local ACP prompt in cooperative mode (proxy injects it)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);

  const result = await handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, fakeCtx([], PROXY_URL));
  assert.ok(!result.systemPrompt.includes("ACP context management"), "philosophy must come from the proxy, not locally");
  assert.ok(result.systemPrompt.startsWith("BASE"));

  const local = await handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, fakeCtx([], "https://api.anthropic.com"));
  assert.ok(local.systemPrompt.includes("ACP context management"), "standalone mode keeps the local prompt");
});

test("native tools forward to the proxy tool endpoint in cooperative mode", async () => {
  const received: Array<{ conversationId?: string; tool?: string; args?: any }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => { body += c; });
    req.on("end", () => {
      if (req.url === "/__bili/plugin/tool") {
        received.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, tool: "compress", result: "[proxied] compressed m00001–m00002" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const { api } = captureApi();
  createAcpExtension()(api as any);
  const compress = api.tools.find((t: any) => t.name === "compress");
  assert.ok(compress, "compress tool registered");

  const args = { content: [{ startId: "m00001", endId: "m00002", summary: "x".repeat(60) }] };
  const out = await compress.execute(
    "call_1",
    args,
    undefined,
    undefined,
    fakeCtx([], `http://127.0.0.1:${port}/bili/https://api.anthropic.com`),
  );
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, "[proxied] compressed m00001–m00002");
  assert.equal(received.length, 1);
  assert.equal(received[0].conversationId, "test-session");
  assert.equal(received[0].tool, "compress");
  assert.equal(received[0].args.content[0].startId, "m00001");

  const localOut = await compress.execute(
    "call_2",
    args,
    undefined,
    undefined,
    fakeCtx([], `http://127.0.0.1:${port}/no-bili/https://api.anthropic.com`),
  );
  assert.notEqual(localOut.content[0].text, "[proxied] compressed m00001–m00002", "no /bili/ prefix → local handler runs");

  server.close();
});

test("proxy tool errors surface as tool failures", async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  await assert.rejects(
    forwardToolToProxy(`http://127.0.0.1:${port}`, "missing-conv", "compress", {}),
    /unknown plugin conversation/,
  );
  server.close();
});

test("ACP_COOPERATIVE_PROXY=0 disables cooperative mode entirely", async () => {
  const prev = process.env.ACP_COOPERATIVE_PROXY;
  process.env.ACP_COOPERATIVE_PROXY = "0";
  try {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);

    const headers: Record<string, string | null> = {};
    await handlers.get("before_provider_headers")![0]!({ type: "before_provider_headers", headers }, fakeCtx([], PROXY_URL));
    assert.equal(headers["x-bili-plugin"], undefined);

    const entries = [userMsg("e1", "first"), userMsg("e2", "second")];
    const messages = entries.map((e) => e.message);
    const result = await handlers.get("context")![0]!({ type: "context", messages }, fakeCtx(entries, PROXY_URL));
    assert.notEqual(result.messages, messages, "local pipeline must run (tagged output, not identity)");
    const first = (result.messages[0] as any).content;
    const textBlocks = Array.isArray(first) ? first.filter((b: any) => b.type === "text") : [];
    assert.ok(textBlocks.length > 0 && /m\d+/.test(textBlocks[0].text), "messages ref-tagged locally");
  } finally {
    if (prev === undefined) delete process.env.ACP_COOPERATIVE_PROXY;
    else process.env.ACP_COOPERATIVE_PROXY = prev;
  }
});
