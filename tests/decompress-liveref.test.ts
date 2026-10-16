import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";
import { messageIdentity } from "../src/messages.js";
import { loadLiveRefEntries } from "../src/session-log.js";
import { setRunNpmForTest } from "../src/update.js";
import { tmpPath } from "./tmp-path.js";

// Issue #579: fork hosts (PI_ACP_FORK_HOST=1, e.g. Prime Agent) alias the
// not-yet-persisted live tail with content-addressed `live-*` ids (runtime.ts
// mergeLiveEntries). Compressing over that tail records live-* ids into
// block.effectiveMessageIds — aliases that appear in NO session jsonl, so the
// #534 ancestor entry-id fallback structurally cannot find them. The rawId→
// identity bridge lives in the declaring session's OWN sidecar
// (liveRefOrigins); recovery walks the current/ancestor chain read-only and
// matches messageIdentity against each level's log entries.

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;

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

function roleMsg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now() } };
}

const rawOf = (e: any) => ({ ...e.message });

async function writeJsonl(file: string, sessionId: string, entries: unknown[], parentSession?: string) {
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/tmp", ...(parentSession ? { parentSession } : {}) };
  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
  await writeFile(file, lines.join("\n") + "\n", "utf8");
}

async function writeSidecar(jsonlFile: string, payload: unknown) {
  await writeFile(`${jsonlFile}.acp.json`, JSON.stringify(payload), "utf8");
}

/** Declared fork host: getBranch returns ENTRIES; context event.messages
 *  carries RAW AgentMessages — the exact send view (contract per
 *  compress-retry-fork-host.test.ts). */
function forkCtx(entries: any[], stateFile: string, sessionId: string): any {
  return {
    mode: "rpc",
    cwd: "/tmp",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => stateFile,
      getEntry: (id: string) => entries.find((e: any) => e.id === id),
    },
  };
}

const filler = (n: number, i: number) => `filler-${n}-${i}`;
// 160 fillers/message keeps the 3-message range above the kernel's min-size
// compressible threshold (5000 chars across all ranges).
const liveText = (n: number) => `LIVE-TAIL SECRET L${n}: ${Array.from({ length: 160 }, (_, i) => filler(n, i)).join(" ")}`;
// ~5K chars (~1250 tokens) per buffer: the six buffers behind the compressed
// range accumulate past preserveRecentTokens (5000) so the kernel's token-based
// protected zone stops BEFORE reaching the live range (decompress-ancestor.test.ts
// uses the same shape: target early, heavy mass behind it).
const bufferText = (n: number) => `BUFFER-TAIL B${n}: ${Array.from({ length: 400 }, (_, i) => filler(100 + n, i)).join(" ")}`;

const inlineText = (out: any): string => (typeof out === "string" ? out : ((out?.content?.[0]?.text ?? String(out)) as string));

/** Fork-host parent compresses its UNPERSISTED live tail (L1–L3 ahead of
 *  still-live L4–L6), then derives a depth-1 child. Pins the issue's failure
 *  preconditions: every b1 ref is a live-* alias absent from all jsonls, the
 *  parent sidecar carries the liveRefOrigins bridge, and the child inherits
 *  the block WITHOUT that bridge. */
async function setupLiveRefChild(dir: string) {
  const prevForkHost = process.env.PI_ACP_FORK_HOST;
  process.env.PI_ACP_FORK_HOST = "1";
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    const persisted = Array.from({ length: 7 }, (_, i) => roleMsg(`p${i + 1}`, "user", `persisted history ${i + 1} ${Array.from({ length: 24 }, (_, j) => filler(i + 1, j)).join(" ")}`));
    // Live tail: compressed range L1–L3 sits ahead of six heavy buffers B1–B6
    // so both protected-zone rules (last-5 refs; 5000-token tail budget) stop
    // before reaching it. Last message is assistant so the most-recent-user
    // protection lands on a buffer ref, outside the range.
    const liveTail = [
      roleMsg("L1", "assistant", liveText(1)),
      roleMsg("L2", "user", liveText(2)),
      roleMsg("L3", "assistant", liveText(3)),
      roleMsg("B1", "user", bufferText(1)),
      roleMsg("B2", "assistant", bufferText(2)),
      roleMsg("B3", "user", bufferText(3)),
      roleMsg("B4", "assistant", bufferText(4)),
      roleMsg("B5", "user", bufferText(5)),
      roleMsg("B6", "assistant", bufferText(6)),
    ];
    await writeJsonl(parentJsonl, "parent-sid", persisted);
    const childEntries = [roleMsg("c1", "user", "child one"), roleMsg("c2", "assistant", "child two")];
    await writeJsonl(childJsonl, "child-sid", childEntries, parentJsonl);

    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const parentCtx = forkCtx(persisted, parentJsonl, "parent-sid");
    await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, parentCtx);
    const sendView = [...persisted.map(rawOf), ...liveTail.map(rawOf)];
    await handlers.get("context")![0]!({ type: "context", messages: sendView }, parentCtx);

    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const res = await compressTool.execute("tc1", { content: [{ startId: "m00008", endId: "m00010", summary: "Unpersisted fork-host live tail: three live-turn messages carrying LIVE-TAIL SECRET L1/L2/L3." }] }, undefined, undefined, parentCtx);
    const compressText = inlineText(res);
    assert.ok(!compressText.includes("does not exist") && !compressText.includes("REJECTED") && !compressText.includes("Errors:"), `compress over the live tail must succeed: ${compressText.slice(0, 300)}`);

    const sidecar = JSON.parse(await readFile(`${parentJsonl}.acp.json`, "utf8")) as any;
    const b1 = sidecar.blocks.find((b: any) => b.blockId === "b1");
    assert.ok(b1, "sidecar holds the fresh block b1");
    assert.ok(b1.effectiveMessageIds.length >= 3 && b1.effectiveMessageIds.every((id: string) => id.startsWith("live-")),
      `b1 refs must ALL be live-* aliases (issue precondition): ${JSON.stringify(b1.effectiveMessageIds)}`);
    const origins = sidecar.liveRefOrigins as Array<{ rawId: string; identity: string }>;
    assert.ok(Array.isArray(origins) && origins.length > 0, "parent sidecar persists the liveRefOrigins bridge");
    const originBaseIds = new Set(origins.map((o) => o.rawId.split("#")[0]));
    for (const id of b1.effectiveMessageIds) assert.ok(originBaseIds.has(id.split("#")[0]), `origin declared for ${id}`);

    const runtime = createRuntime({});
    assert.equal(await runtime.deriveChildState(
      { sessionId: "child-sid", sessionFile: childJsonl },
      { sessionId: "parent-sid", sessionFile: parentJsonl }), true, "child derivation must succeed");
    const childSidecar = JSON.parse(await readFile(`${childJsonl}.acp.json`, "utf8")) as any;
    assert.ok(childSidecar.blocks.some((b: any) => b.blockId === "b1"), "child inherits b1");
    assert.ok(!Array.isArray(childSidecar.liveRefOrigins) || childSidecar.liveRefOrigins.length === 0,
      "child sidecar must NOT inherit the working liveRefOrigins array (it feeds the child's own live-tail alignment)");

    return {
      api, handlers, parentCtx, sendView, persisted, liveTail,
      decompressTool: api.tools.find((t: any) => t.name === "decompress")!,
      childJsonl, childEntries, parentJsonl, b1,
    };
  } finally {
    if (prevForkHost === undefined) delete process.env.PI_ACP_FORK_HOST;
    else process.env.PI_ACP_FORK_HOST = prevForkHost;
  }
}

/** Models the production timeline (#579): compress runs while the tail is
 *  still unpersisted (hence live-* aliases in the block), then the host
 *  flushes the same content into the parent jsonl under real entry ids — the
 *  state at which the child's decompress must succeed. */
async function flushParentTail(parentJsonl: string, persisted: any[], liveTail: any[]): Promise<any[]> {
  const flushed = [...persisted, ...liveTail.map((e: any, i: number) => ({ ...e, id: `l${i + 1}` }))];
  await writeJsonl(parentJsonl, "parent-sid", flushed);
  return flushed;
}

test("issue #579: depth-1 derived child restores an inherited block whose refs are all live-* aliases", async () => {
  const dir = tmpPath(`acp-liveref-child-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const { decompressTool, childJsonl, childEntries, parentJsonl, persisted, liveTail } = await setupLiveRefChild(dir);
    await flushParentTail(parentJsonl, persisted, liveTail);
    const childCtx = forkCtx(childEntries, childJsonl, "child-sid");
    const res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, childCtx);
    const text = inlineText(res);
    assert.match(text, /inline:/, `expected inline restore, got: ${text.slice(0, 200)}`);
    for (const n of [1, 2, 3]) {
      assert.ok(text.includes(`LIVE-TAIL SECRET L${n}`), `L${n} restored via the parent sidecar's liveRefOrigins bridge`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue #579 control: the PARENT resolves its own live-* block while the tail is still unpersisted", async () => {
  const dir = tmpPath(`acp-liveref-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const { decompressTool, handlers, parentCtx, sendView } = await setupLiveRefChild(dir);
    // Host resend: re-firing the context caches the same live tail for the tool path.
    await handlers.get("context")![0]!({ type: "context", messages: sendView }, parentCtx);
    const res = await decompressTool.execute("tc0", { blockId: "b1", inline: true }, undefined, undefined, parentCtx);
    const text = inlineText(res);
    assert.match(text, /inline:/, `expected inline restore, got: ${text.slice(0, 200)}`);
    for (const n of [1, 2, 3]) assert.ok(text.includes(`LIVE-TAIL SECRET L${n}`), `parent must resolve its own live refs (pre-existing behavior)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue #579: single-message-ref decompress resolves an inherited live-* ref", async () => {
  const dir = tmpPath(`acp-liveref-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const { decompressTool, childJsonl, childEntries, b1, parentJsonl, persisted, liveTail } = await setupLiveRefChild(dir);
    await flushParentTail(parentJsonl, persisted, liveTail);
    const ref = b1.effectiveMessageIds[0] as string;
    const childCtx = forkCtx(childEntries, childJsonl, "child-sid");
    const res = await decompressTool.execute("tc3", { blockId: ref, inline: true }, undefined, undefined, childCtx);
    const text = inlineText(res);
    assert.match(text, /restored inline/, `expected single-ref inline restore, got: ${text.slice(0, 200)}`);
    assert.ok(text.includes("LIVE-TAIL SECRET L1"), `first range ref maps to L1 content: ${text.slice(0, 120)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Fresh extension instance on the flushed parent session, fork host declared
 *  (setup's finally already restored the env around setup). */
function freshForkInstance(flushed: any[], parentJsonl: string) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const ctx = forkCtx(flushed, parentJsonl, "parent-sid");
  return { api, handlers, ctx, decompressTool: api.tools.find((t: any) => t.name === "decompress")! };
}

test("issue #579: self-level (depth-0) recovery — declaring session restores its own live-* block via its own sidecar bridge", async () => {
  const dir = tmpPath(`acp-liveref-self-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const { parentJsonl, persisted, liveTail } = await setupLiveRefChild(dir);
    const flushed = await flushParentTail(parentJsonl, persisted, liveTail);

    const prevForkHost = process.env.PI_ACP_FORK_HOST;
    try {
      process.env.PI_ACP_FORK_HOST = "1";
      // Depth-0 walk in isolation: session_start only, no context fire, so no
      // migration save overwrites the bridge before the tool runs.
      const inst = freshForkInstance(flushed, parentJsonl);
      await inst.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, inst.ctx);
      const res = await inst.decompressTool.execute("tc4a", { blockId: "b1", inline: true }, undefined, undefined, inst.ctx);
      const text = inlineText(res);
      assert.match(text, /inline:/, `expected inline restore, got: ${text.slice(0, 200)}`);
      for (const n of [1, 2, 3]) assert.ok(text.includes(`LIVE-TAIL SECRET L${n}`), `L${n} recovered via the self-level bridge`);
    } finally {
      if (prevForkHost === undefined) delete process.env.PI_ACP_FORK_HOST;
      else process.env.PI_ACP_FORK_HOST = prevForkHost;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue #579 boundary: the first post-flush context fire consumes the bridge (migration save) — decompress degrades to the honest miss", async () => {
  const dir = tmpPath(`acp-liveref-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const { parentJsonl, persisted, liveTail } = await setupLiveRefChild(dir);
    const flushed = await flushParentTail(parentJsonl, persisted, liveTail);

    const prevForkHost = process.env.PI_ACP_FORK_HOST;
    try {
      process.env.PI_ACP_FORK_HOST = "1";
      const inst = freshForkInstance(flushed, parentJsonl);
      await inst.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, inst.ctx);
      await inst.handlers.get("context")![0]!({ type: "context", messages: flushed.map(rawOf) }, inst.ctx);
      // The resumed turn migrates live-* refs to the now-real entry ids and
      // save() persists the CONSUMED (empty) origin slot — the provenance
      // bridge is intentionally ephemeral (#459 alignment records, not a
      // permanent archive). Pin the consequence: honest miss, no misattribution.
      const sidecar = JSON.parse(await readFile(`${parentJsonl}.acp.json`, "utf8")) as any;
      assert.equal(sidecar.liveRefOrigins.length, 0, "post-flush merge consumes the origin records");
      assert.ok(sidecar.blocks.some((b: any) => b.blockId === "b1"), "the block itself survives — only the bridge is gone");
      const res = await inst.decompressTool.execute("tc4b", { blockId: "b1", inline: true }, undefined, undefined, inst.ctx);
      assert.match(inlineText(res), /has no restorable message content/);
    } finally {
      if (prevForkHost === undefined) delete process.env.PI_ACP_FORK_HOST;
      else process.env.PI_ACP_FORK_HOST = prevForkHost;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue #579: multi-tool-call live ref remaps #callId cores back onto the alias", async () => {
  const dir = tmpPath(`acp-liveref-mtc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    const e1 = {
      type: "message", id: "e1", parentId: null, timestamp: "",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "multi-call preamble MTC-SECRET" },
          { type: "toolCall", name: "bash", id: "callA", arguments: { command: "ls -la" } },
          { type: "toolCall", name: "read_file", id: "callB", arguments: { path: "f.txt" } },
        ],
        timestamp: Date.now(),
      },
    };
    const alias = "live-mtc000000000001";
    await writeJsonl(parentJsonl, "parent-sid", [e1]);
    await writeSidecar(parentJsonl, {
      blocks: [{
        blockId: "b2", runId: "r1", tier: 1, summary: "Multi tool-call live block.",
        directMessageIds: [alias], effectiveMessageIds: [`${alias}#callA`, `${alias}#callB`],
        directBlockIds: [], compressedTokens: 120, createdAt: Date.now(), survivedCount: 0, generation: "young", active: true,
      }],
      liveRefOrigins: [{ rawId: alias, identity: messageIdentity(e1.message) }],
    });
    const childEntries = [roleMsg("c1", "user", "child one")];
    await writeJsonl(childJsonl, "child-sid", childEntries, parentJsonl);
    const runtime = createRuntime({});
    assert.equal(await runtime.deriveChildState(
      { sessionId: "child-sid", sessionFile: childJsonl },
      { sessionId: "parent-sid", sessionFile: parentJsonl }), true);

    const { api } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
    const childCtx = forkCtx(childEntries, childJsonl, "child-sid");
    const res = await decompressTool.execute("tc5", { blockId: "b2", inline: true }, undefined, undefined, childCtx);
    const text = inlineText(res);
    assert.match(text, /inline:/, `expected inline restore, got: ${text.slice(0, 200)}`);
    assert.ok(text.includes("bash") && text.includes("read_file"), "both tool-call cores restored under their aliased #callId refs");
    assert.ok(text.includes("ls -la") && text.includes("f.txt"), "each remapped core carries its tool-call args (multi-call projection drops the preamble text)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue #579: honest error preserved when the aliased content was never persisted anywhere", async () => {
  const dir = tmpPath(`acp-liveref-negative-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const sJsonl = path.join(dir, "s.jsonl");
    const sEntries = [roleMsg("u1", "user", "unrelated message")];
    await writeJsonl(sJsonl, "s-sid", sEntries);
    const alias = "live-deadbeefdeadbe";
    await writeSidecar(sJsonl, {
      blocks: [{
        blockId: "b9", runId: "r1", tier: 1, summary: "Ghost live block.",
        directMessageIds: [alias], effectiveMessageIds: [alias],
        directBlockIds: [], compressedTokens: 60, createdAt: Date.now(), survivedCount: 0, generation: "young", active: true,
      }],
      liveRefOrigins: [{ rawId: alias, identity: messageIdentity({ role: "user", content: "NEVER-PERSISTED-CONTENT", timestamp: 0 }) }],
    });
    const { api } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000 })(api as any);
    const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
    const sCtx = forkCtx(sEntries, sJsonl, "s-sid");
    const res = await decompressTool.execute("tc6", { blockId: "b9", inline: true }, undefined, undefined, sCtx);
    assert.match(inlineText(res), /has no restorable message content/, "bridge declared but content absent → no fabrication");
    const found = await loadLiveRefEntries(sJsonl, new Set([alias]));
    assert.equal(found.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadLiveRefEntries: cycle-safe chain walk finds the declaring level's entry", async () => {
  const dir = tmpPath(`acp-liveref-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const a = path.join(dir, "a.jsonl");
    const b = path.join(dir, "b.jsonl");
    const msg = { role: "user", content: "cycle payload CYC-SECRET", timestamp: 0 };
    await writeJsonl(a, "a-sid", [roleMsg("ax", "user", "a payload")], b);
    await writeJsonl(b, "b-sid", [{ type: "message", id: "bx", parentId: null, timestamp: "", message: msg }], a);
    await writeSidecar(b, { blocks: [], liveRefOrigins: [{ rawId: "live-cyc000000000001", identity: messageIdentity(msg) }] });
    const found = await loadLiveRefEntries(a, new Set(["live-cyc000000000001"]));
    assert.equal(found.size, 1, "no cycle, no hang, entry found at the declaring level");
    assert.equal(found.get("live-cyc000000000001")!.id, "bx");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadLiveRefEntries: nearest declaring level wins; non-live ids and missing files yield empty", async () => {
  const dir = tmpPath(`acp-liveref-nearest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const top = path.join(dir, "top.jsonl");
    const mid = path.join(dir, "mid.jsonl");
    const leaf = path.join(dir, "leaf.jsonl");
    const dup = { role: "user", content: "dup DUP-SECRET", timestamp: 0 };
    const msgEntry = (id: string) => ({ type: "message", id, parentId: null, timestamp: "", message: dup });
    await writeJsonl(top, "top-sid", [msgEntry("t1")]);
    await writeSidecar(top, { blocks: [], liveRefOrigins: [{ rawId: "live-top000000000001", identity: messageIdentity(dup) }] });
    await writeJsonl(mid, "mid-sid", [msgEntry("m1")], top);
    await writeSidecar(mid, { blocks: [], liveRefOrigins: [{ rawId: "live-nw000000000001", identity: messageIdentity(dup) }] });
    await writeJsonl(leaf, "leaf-sid", [], mid);

    const found = await loadLiveRefEntries(leaf, new Set(["live-nw000000000001"]));
    assert.equal(found.size, 1);
    assert.equal(found.get("live-nw000000000001")!.id, "m1", "nearest declaring level wins over farther ancestors");

    assert.deepEqual(await loadLiveRefEntries(mid, new Set(["m00001"])), new Map(), "non-live ids are never looked up");
    assert.deepEqual(await loadLiveRefEntries(path.join(dir, "missing.jsonl"), new Set(["live-x"])), new Map(), "missing start file → empty");
    assert.deepEqual(await loadLiveRefEntries(undefined, new Set(["live-x"])), new Map(), "undefined session file → empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
