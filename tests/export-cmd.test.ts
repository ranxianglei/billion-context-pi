import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { listSessions, exportSession, parseExportArgs } from "../src/export.js";
import { createInitialState } from "acp-kernel";

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

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

// Valid Pi session JSONL (header + linear chain) on disk so SessionManager.open can parse it.
async function writeSessionFile(file: string, id: string, entries: any[]) {
  const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp" };
  let parent: string | null = null;
  const lines = [header];
  for (const e of entries) {
    lines.push({ ...e, parentId: parent });
    parent = e.id;
  }
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

function fakeCtx(entries: any[], stateFile: string, notifies: string[]) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: (m: string) => notifies.push(m), confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
      getSessionDir: () => path.dirname(stateFile),
    },
  };
}

// Full pipeline: write session file, run context handler (assigns refs), compress m00002 → leaves .jsonl + .acp.json on disk.
// e1 is the first user message (prune always keeps it) and the last 5 messages are a protected zone,
// so only e2 (m00002) is both compressible and foldable — it carries the long text that gets folded.
async function setupSession(stateFile: string) {
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const entries = [
    userMsg("e1", "Initial short prompt."),
    userMsg("e2", longText), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];
  await writeSessionFile(stateFile, "test-session", entries);
  await rm(`${stateFile}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api);
  const notifies: string[] = [];
  const ctx = fakeCtx(entries, stateFile, notifies);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const res = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00002", endId: "m00002", summary: "This range contained a detailed user message discussing the initial context." }] },
    undefined,
    undefined,
    ctx,
  );
  const text = (res.content[0] as any).text as string;
  assert.match(text, /1 block/, "compress created a block");
  return { api, ctx, notifies };
}

test("parseExportArgs parses selector, --full, and --output", () => {
  assert.deepEqual(parseExportArgs(""), { selector: undefined, full: false, output: undefined, error: undefined });
  assert.deepEqual(parseExportArgs("abc"), { selector: "abc", full: false, output: undefined, error: undefined });
  assert.deepEqual(parseExportArgs("abc --full"), { selector: "abc", full: true, output: undefined, error: undefined });
  assert.deepEqual(parseExportArgs("abc --output x.md"), { selector: "abc", full: false, output: "x.md", error: undefined });
  assert.deepEqual(parseExportArgs("--output x.md abc"), { selector: "abc", full: false, output: "x.md", error: undefined });
  assert.deepEqual(parseExportArgs("abc --output=x.md --full"), { selector: "abc", full: true, output: "x.md", error: undefined });
  assert.match(parseExportArgs("abc --output").error!, /requires a file path/);
});

test("listSessions returns ACP-managed sessions with id, title, and block count", async () => {
  const dir = "/tmp/pai-acp-export-list";
  const stateFile = `${dir}/test-session.jsonl`;
  await mkdir(dir, { recursive: true });
  await setupSession(stateFile);
  const summaries = await listSessions(dir);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.id, "test-session");
  assert.equal(summaries[0]!.blocks, 1);
  assert.match(summaries[0]!.title!, /Initial short prompt/);
});

test("exportSession with no selector lists persisted sessions", async () => {
  const dir = "/tmp/pai-acp-export-noselector";
  const stateFile = `${dir}/test-session.jsonl`;
  await mkdir(dir, { recursive: true });
  await setupSession(stateFile);
  const text = await exportSession(undefined, {}, dir);
  assert.match(text, /ACP-managed sessions:/);
  assert.match(text, /test-session/);
  assert.match(text, /blocks=1/);
  assert.match(text, /Usage: \/acp-export/);
});

test("exportSession renders the folded view (summary in place of the compressed range)", async () => {
  const dir = "/tmp/pai-acp-export-folded";
  const stateFile = `${dir}/test-session.jsonl`;
  await mkdir(dir, { recursive: true });
  await setupSession(stateFile);
  const text = await exportSession("test-session", {}, dir);
  assert.match(text, /# billion-context session handoff/);
  assert.match(text, /folded view as the model saw it/);
  assert.match(text, /This range contained a detailed user message/, "block summary present");
  assert.ok(!text.includes("This is a detailed message that needs to be compressed"), "compressed original is folded away");
  assert.match(text, /filler seven/, "uncompressed messages retained");
});

test("exportSession --full renders the original messages", async () => {
  const dir = "/tmp/pai-acp-export-full";
  const stateFile = `${dir}/test-session.jsonl`;
  await mkdir(dir, { recursive: true });
  await setupSession(stateFile);
  const text = await exportSession("test-session", { full: true }, dir);
  assert.match(text, /Full conversation/);
  assert.match(text, /This is a detailed message that needs to be compressed/, "original message restored");
  assert.match(text, /filler seven/);
});

test("exportSession --output writes the markdown file", async () => {
  const dir = "/tmp/pai-acp-export-output";
  const stateFile = `${dir}/test-session.jsonl`;
  const out = `${dir}/nested/handoff.md`;
  await mkdir(dir, { recursive: true });
  await setupSession(stateFile);
  const result = await exportSession("test-session", { output: out }, dir);
  assert.equal(result, `written to ${out}`);
  const content = await readFile(out, "utf8");
  assert.match(content, /# billion-context session handoff/);
  await rm(out, { force: true });
});

test("exportSession throws when no session matches the selector", async () => {
  const dir = "/tmp/pai-acp-export-nomatch";
  const stateFile = `${dir}/test-session.jsonl`;
  await mkdir(dir, { recursive: true });
  await setupSession(stateFile);
  await assert.rejects(() => exportSession("nonexistent", {}, dir), /no session matches "nonexistent"/);
});

test("exportSession reports an empty store", async () => {
  const dir = "/tmp/pai-acp-export-empty";
  await mkdir(dir, { recursive: true });
  const text = await exportSession(undefined, {}, dir);
  assert.match(text, /No ACP-managed sessions found/);
});

test("exportSession throws on an ambiguous selector", async () => {
  const dir = "/tmp/pai-acp-export-ambig";
  await mkdir(dir, { recursive: true });
  for (const id of ["sess-a", "sess-b"]) {
    await writeSessionFile(`${dir}/${id}.jsonl`, id, [userMsg("m1", "hello world")]);
    await writeFile(`${dir}/${id}.jsonl.acp.json`, JSON.stringify(createInitialState()));
  }
  await assert.rejects(() => exportSession("sess", {}, dir), /matches 2 sessions/);
});

test("/acp-export command is registered and lists, folds, and expands", async () => {
  const dir = "/tmp/pai-acp-export-cmd";
  const stateFile = `${dir}/test-session.jsonl`;
  await mkdir(dir, { recursive: true });
  const { api, ctx, notifies } = await setupSession(stateFile);
  const cmd = api.commands.get("acp-export");
  assert.ok(cmd, "acp-export command is registered");

  notifies.length = 0;
  await cmd.handler("", ctx);
  assert.match(notifies[0]!, /ACP-managed sessions:/);

  notifies.length = 0;
  await cmd.handler("test-session", ctx);
  assert.match(notifies[0]!, /folded view as the model saw it/);

  notifies.length = 0;
  await cmd.handler("test-session --full", ctx);
  assert.match(notifies[0]!, /Full conversation/);
});
