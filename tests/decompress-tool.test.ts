import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
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

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

async function cleanState(sessionFile: string) {
  await rm(`${sessionFile}.acp.json`, { force: true });
}

function fakeCtx(entries: any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

/** fake ctx whose sessionManager keeps a FULL tree (getEntry) distinct from the
 *  ACTIVE branch (getBranch), simulating a tree navigation (undo): the leaf
 *  moved so the block's messages left the active branch, but they are still in
 *  the session log (full tree) — exactly the scenario resolveBlockMessages
 *  fixes. */
function fakeCtxFullTree(allEntries: any[], activeEntries: any[], stateFile: string) {
  const ctx = fakeCtx(activeEntries, stateFile) as any;
  ctx.sessionManager.getEntry = (id: string) => allEntries.find((e: any) => e.id === id);
  return ctx;
}

// Shared setup: assign refs + compress m00001 into block b1, return the tool
// handles + ctx so each test can drive the decompress tool.
async function setupWithCompressedBlock() {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);

  const stateFile = "/tmp/pai-acp-decompress-tool-it.session.json";
  await cleanState(stateFile);
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const entries = [
    userMsg("e1", longText),
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];
  const ctx = fakeCtx(entries, stateFile);

  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "Detailed initial context message for the decompress-tool tests." }] },
    undefined, undefined, ctx,
  );

  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  return { decompressTool, ctx };
}

test("decompress default writes content to an auto-generated file (no context bloat)", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc2", { blockId: "b1" }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /written to/, "result reports a file path");
  assert.match(text, /acp-decompress[\\/]b1-\d+\.txt/, "auto-generated path under ~/.cache/pi/acp-decompress");
  assert.match(text, /stays compressed/, "tells model the block stays compressed");
  assert.match(text, /Preview:/, "includes a head preview");
  // Crucially: the full long content is NOT in the tool result (it's in the file).
  // The result carries only a short head preview + boilerplate, so it must be
  // far smaller than the restored content (which the result itself reports as
  // ~7287 chars).
  assert.ok(text.length < 2000,
    `inline content must NOT be the full restored text (result was ${text.length} chars)`);
});

test("decompress inline:true returns the full content in the tool result", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc3", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /inline:/, "result signals inline mode");
  assert.ok(text.includes("This is a detailed message that needs to be compressed."),
    "full restored content present in the tool result");
});

test("decompress toFile writes to the specified path", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const dir = await mkdtemp(join(tmpdir(), "pai-acp-decompress-"));
  const target = join(dir, "custom.txt");
  const res = await decompressTool.execute("tc4", { blockId: "b1", toFile: target }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "result mentions the custom path");
  const written = await readFile(target, "utf8");
  assert.ok(written.includes("This is a detailed message that needs to be compressed."),
    "file contains the full restored content");
});

test("decompress toFile rejects paths outside allowed roots", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc5", { blockId: "b1", toFile: "/etc/passwd" }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.match(text, /must be under/i, "rejects arbitrary filesystem path");
});

test("decompress toFile rejects paths that escape an allowed root via a symlink", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const jail = await mkdtemp(join(tmpdir(), "pai-acp-jail-"));
  // A symlink inside the (allowed) jail that points OUTSIDE all allowed roots.
  // /etc exists on both Linux and macOS, so realpath can follow the link.
  // The literal path looks contained (jail/evil-link/x.txt under tmpdir), but
  // resolving the symlink reveals it lands in /etc — must be rejected.
  const link = join(jail, "evil-link");
  await symlink("/etc", link);
  const target = join(link, "passwd.txt");
  const res = await decompressTool.execute("tc-sym", { blockId: "b1", toFile: target }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.match(text, /must be under/i, "rejects path escaping an allowed root through a symlink");
});

test("decompress toFile rejects a dangling symlink whose target escapes the allowed roots", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const jail = await mkdtemp(join(tmpdir(), "pai-acp-jail-dangling-"));
  const link = join(jail, "dangling-link");
  const escapedTarget = join(homedir(), `acp-dangling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await symlink(escapedTarget, link);
  const target = join(link, "out.txt");
  const res = await decompressTool.execute("tc-sym2", { blockId: "b1", toFile: target }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.match(text, /must be under/i, "rejects a dangling symlink that would write outside allowed roots");
});

test("decompress keeps the block active after a file-mode call", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  await decompressTool.execute("tc6", { blockId: "b1" }, undefined, undefined, ctx);
  // Run the status tool to confirm b1 is still folded (active).
  const { api } = captureApi();
  // re-query via the same ctx's persisted state: simpler to just call decompress
  // again — a second file-mode call should succeed identically (block still there).
  const res2 = await decompressTool.execute("tc7", { blockId: "b1" }, undefined, undefined, ctx);
  const text2 = (res2.content[0] as any).text as string;
  assert.doesNotMatch(text2, /not found/i, "block still present after first decompress");
});

test("decompress restores a block's original text via getEntry fallback after tree navigation (undo)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-decompress-fallback-undo.session.json";
  await cleanState(stateFile);
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const allEntries = [
    userMsg("e1", longText),
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];

  // Compress phase: everything is on the active branch (e1 → block b1).
  const compressCtx = fakeCtxFullTree(allEntries, allEntries, stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, compressCtx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "Detailed initial context message for the decompress-tool tests." }] },
    undefined, undefined, compressCtx,
  );

  // Undo phase: the leaf moved; e1 left the active branch but is still in the
  // full tree (getEntry finds it) — like after /undo, /redo, or /tree.
  const activeAfterUndo = allEntries.filter((e) => e.id !== "e1");
  const undoCtx = fakeCtxFullTree(allEntries, activeAfterUndo, stateFile);
  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  const res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, undoCtx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /inline:/, "result signals inline mode");
  assert.ok(text.includes("This is a detailed message that needs to be compressed."),
    "fallback restored the original text from the full session tree");
});

test("decompress keeps the degraded message when the ref is gone from both branch and full tree", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-decompress-fallback-gone.session.json";
  await cleanState(stateFile);
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const allEntries = [
    userMsg("e1", longText),
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];

  const compressCtx = fakeCtxFullTree(allEntries, allEntries, stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, compressCtx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute("tc1", { content: [{ startId: "m00001", endId: "m00001", summary: "Detailed initial context message that needs restoration after navigation." }] }, undefined, undefined, compressCtx);

  // e1 vanished from the full tree entirely: getEntry → undefined AND the
  // active branch is empty — nothing to fall back to.
  const goneCtx = fakeCtxFullTree(allEntries.filter((e) => e.id !== "e1"), [], stateFile);
  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  const res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, goneCtx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /no restorable message content/, "degraded message preserved when nothing can be restored");
});

test("decompress restores multi tool-call assistant messages (refs carry # suffix) after undo", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-decompress-fallback-tools.session.json";
  await cleanState(stateFile);
  const filler = (n: string) => `filler ${n} `.repeat(400);

  const toolCallsEntry = {
    type: "message", id: "e1", parentId: null, timestamp: "",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", name: "read", id: "call-1", arguments: { path: "a.txt", payload: "p".repeat(3000) } },
        { type: "toolCall", name: "bash", id: "call-2", arguments: { command: "ls", payload: "q".repeat(3000) } },
      ],
      timestamp: Date.now(),
    },
  };
  const allEntries = [
    toolCallsEntry,
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];

  const compressCtx = fakeCtxFullTree(allEntries, allEntries, stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, compressCtx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  // The multi tool-call assistant projects to two CoreMessages (e1#call-1,
  // e1#call-2), each with its own ref (m00001, m00002).
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00002", summary: "Tool call summary covering the multi tool-call assistant message content for the test." }] },
    undefined, undefined, compressCtx,
  );

  const activeAfterUndo = allEntries.filter((e) => e.id !== "e1");
  const undoCtx = fakeCtxFullTree(allEntries, activeAfterUndo, stateFile);
  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  const res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, undoCtx);
  const text = (res.content[0] as any).text as string;

  assert.ok(text.includes("read") && text.includes("bash"),
    "both multi tool-call CoreMessages restored via base-id normalization");
});

test("decompress survives repeated compress → navigate → decompress cycles (state not lost)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-decompress-fallback-cycles.session.json";
  await cleanState(stateFile);
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(600);
  const allEntries = [
    userMsg("e1", longText),
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;

  // Cycle 1: compress e1 → navigate away → decompress (fallback restores).
  const compressCtx = fakeCtxFullTree(allEntries, allEntries, stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, compressCtx);
  await compressTool.execute("tc1", { content: [{ startId: "m00001", endId: "m00001", summary: "First compression cycle summary for the repeated round-trip navigation test." }] }, undefined, undefined, compressCtx);

  let active = allEntries.filter((e) => e.id !== "e1");
  let res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, fakeCtxFullTree(allEntries, active, stateFile));
  assert.ok(((res.content[0] as any).text as string).includes("This is a detailed message"),
    "cycle 1: fallback restored the original text after undo");

  // Cycle 2: navigate BACK (redo) so everything is active again, compress a
  // NEW block over e2, navigate away, decompress the new block.
  const redoCtx = fakeCtxFullTree(allEntries, allEntries, stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, redoCtx);
  await compressTool.execute("tc3", { content: [{ startId: "m00002", endId: "m00002", summary: "Second compression cycle summary covering the filler two message for the test." }] }, undefined, undefined, redoCtx);

  active = allEntries.filter((e) => e.id !== "e2");
  res = await decompressTool.execute("tc4", { blockId: "b2", inline: true }, undefined, undefined, fakeCtxFullTree(allEntries, active, stateFile));
  assert.ok(((res.content[0] as any).text as string).includes("filler two"),
    "cycle 2: newly compressed block also restores after navigate-away");
});
