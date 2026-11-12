import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";
import { parseSessionLog, loadAncestorEntries } from "../src/session-log.js";

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

async function writeJsonl(file: string, sessionId: string, entries: unknown[], parentSession?: string) {
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/tmp", ...(parentSession ? { parentSession } : {}) };
  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
  await writeFile(file, lines.join("\n") + "\n", "utf8");
}

function fakeCtx(entries: any[], stateFile: string, sessionId: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => stateFile,
      getEntry: (id: string) => entries.find((e: any) => e.id === id),
    },
  };
}

const LONG_TEXT = "PARENT SECRET CONTENT: the quick brown fox jumps over the lazy dog. ".repeat(130);
const filler = (n: string) => `filler ${n} `.repeat(400);

/** Parent session compresses m00001 into block b1; returns handles for the
 *  child-side decompress plus the on-disk sidecar paths. */
async function setupDerivedChild(dir: string, levels: 1 | 2) {
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");
  const grandChildJsonl = path.join(dir, "grandchild.jsonl");

  const parentEntries = [
    userMsg("p1", LONG_TEXT),
    userMsg("p2", filler("two")), userMsg("p3", filler("three")),
    userMsg("p4", filler("four")), userMsg("p5", filler("five")),
    userMsg("p6", filler("six")), userMsg("p7", filler("seven")),
  ];
  await writeJsonl(parentJsonl, "parent-sid", parentEntries);

  const childEntries = [userMsg("c1", filler("child-one")), userMsg("c2", filler("child-two"))];
  if (levels === 1) {
    await writeJsonl(childJsonl, "child-sid", childEntries, parentJsonl);
  } else {
    const grandEntries = [userMsg("g1", filler("grand-one"))];
    await writeJsonl(childJsonl, "child-sid", childEntries, parentJsonl);
    await writeJsonl(grandChildJsonl, "grand-sid", grandEntries, childJsonl);
  }

  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const parentCtx = fakeCtx(parentEntries, parentJsonl, "parent-sid");
  await handlers.get("context")![0]!({ type: "context", messages: [] }, parentCtx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "Inherited block summary covering the parent secret content message." }] },
    undefined, undefined, parentCtx,
  );

  const runtime = createRuntime({});
  if (levels === 1) {
    assert.equal(await runtime.deriveChildState(
      { sessionId: "child-sid", sessionFile: childJsonl },
      { sessionId: "parent-sid", sessionFile: parentJsonl },
    ), true, "child derivation must succeed");
  } else {
    assert.equal(await runtime.deriveChildState(
      { sessionId: "child-sid", sessionFile: childJsonl },
      { sessionId: "parent-sid", sessionFile: parentJsonl },
    ), true, "mid-level derivation must succeed");
    assert.equal(await runtime.deriveChildState(
      { sessionId: "grand-sid", sessionFile: grandChildJsonl },
      { sessionId: "child-sid", sessionFile: childJsonl },
    ), true, "depth-2 derivation must succeed");
  }

  const leafJsonl = levels === 1 ? childJsonl : grandChildJsonl;
  const leafId = levels === 1 ? "child-sid" : "grand-sid";
  const leafEntries = levels === 1 ? childEntries : [userMsg("g1", filler("grand-one"))];
  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  return { decompressTool, leafJsonl, leafId, leafEntries, parentJsonl };
}

test("decompress restores an inherited block's content from the PARENT session log (derived child)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-decomp-anc1-"));
  try {
    const { decompressTool, leafJsonl, leafId, leafEntries } = await setupDerivedChild(dir, 1);
    const leafCtx = fakeCtx(leafEntries, leafJsonl, leafId);
    const res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, leafCtx);
    const text = (res.content[0] as any).text as string;

    assert.match(text, /inline:/, "result signals inline mode");
    assert.ok(text.includes("PARENT SECRET CONTENT"), "inherited block restored from the parent log via ancestor fallback");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decompress walks the chain to depth 2 (grandchild inherits a parent-compressed block)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-decomp-anc2-"));
  try {
    const { decompressTool, leafJsonl, leafId, leafEntries } = await setupDerivedChild(dir, 2);
    const leafCtx = fakeCtx(leafEntries, leafJsonl, leafId);
    const res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, leafCtx);
    const text = (res.content[0] as any).text as string;

    assert.match(text, /inline:/, "result signals inline mode");
    assert.ok(text.includes("PARENT SECRET CONTENT"), "block compressed two generations up is still restorable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decompress by message ref finds a parent-only entry in a derived child", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-decomp-anc3-"));
  try {
    const { decompressTool, leafJsonl, leafId, leafEntries } = await setupDerivedChild(dir, 1);
    const sidecar = JSON.parse(await readFile(`${leafJsonl}.acp.json`, "utf8")) as { blocks: Array<{ effectiveMessageIds: string[] }> };
    const rawRef = sidecar.blocks[0]!.effectiveMessageIds[0]!;
    assert.ok(rawRef.length > 0, "inherited block carries a message ref");

    const leafCtx = fakeCtx(leafEntries, leafJsonl, leafId);
    const target = path.join(dir, "msg-out.txt");
    const res = await decompressTool.execute("tc3", { blockId: rawRef, toFile: target }, undefined, undefined, leafCtx);
    const text = (res.content[0] as any).text as string;

    assert.match(text, /written to/, "message-ref path resolves through the ancestor fallback");
    const written = await readFile(target, "utf8");
    assert.ok(written.includes("PARENT SECRET CONTENT"), "parent-only entry text restored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseSessionLog skips blank and malformed lines like pi does", () => {
  const good = JSON.stringify(userMsg("x1", "hello"));
  const entries = parseSessionLog(`\n${good}\n{not json}\n\n`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, "x1");
});

test("loadAncestorEntries terminates on a cyclic parent chain and finds nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-decomp-cycle-"));
  try {
    const a = path.join(dir, "a.jsonl");
    const b = path.join(dir, "b.jsonl");
    await writeJsonl(a, "a-sid", [], b);
    await writeJsonl(b, "b-sid", [userMsg("bx", "cycle payload")], a);
    const found = await loadAncestorEntries(a, new Set(["missing-id"]));
    assert.deepEqual(found, [], "no cycle, no hang, no phantom entries");
    const hit = await loadAncestorEntries(a, new Set(["bx"]));
    assert.equal(hit.length, 1, "entry in the (cyclic) ancestor is still found");
    assert.equal(hit[0]!.id, "bx");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAncestorEntries: nearest ancestor wins on duplicate ids; missing file yields empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-decomp-dup-"));
  try {
    const top = path.join(dir, "top.jsonl");
    const mid = path.join(dir, "mid.jsonl");
    const leaf = path.join(dir, "leaf.jsonl");
    await writeJsonl(top, "top-sid", [userMsg("dup", "TOP version")]);
    await writeJsonl(mid, "mid-sid", [userMsg("dup", "MID version")], top);
    await writeJsonl(leaf, "leaf-sid", [], mid);

    const found = await loadAncestorEntries(leaf, new Set(["dup"]));
    assert.equal(found.length, 1);
    assert.ok((found[0]!.message as any).content.includes("MID version"), "nearest ancestor wins");

    const none = await loadAncestorEntries(path.join(dir, "does-not-exist.jsonl"), new Set(["dup"]));
    assert.deepEqual(none, [], "unreadable start file → no ancestors");
    const noHeader = await loadAncestorEntries(top, new Set(["dup"]));
    assert.deepEqual(noHeader, [], "top-level session has no parent header → nothing above it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
