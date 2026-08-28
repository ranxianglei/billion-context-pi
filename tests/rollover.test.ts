import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";

// Batch rollover (#241): in-phase pending compress/absorb calls must keep the
// outbound provider view byte-stable (append-only), and the rollover itself
// must rewrite the view exactly once, after which it re-anchors.

function captureApi() {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const api = {
    on: (event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (t: any) => { tools.push(t); },
    registerCommand: (name: string, options: any) => { commands.set(name, options); },
  };
  return { api, handlers, tools, commands };
}

function entry(id: string, role: "user" | "assistant", text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: 0 } };
}

function toolCallEntry(id: string, callId: string, name: string, args: unknown) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: 0 },
  };
}

function resultEntry(id: string, callId: string, name: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0 },
  };
}

function fakeCtx(entries: any[], stateFile: string, window: number) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, setStatus: () => {}, setTitle: () => {}, setFooter: () => {}, setHeader: () => {}, note: () => {}, suggestForInput: () => {} },
    model: { contextWindow: window, id: "test-model" },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => "rollover-test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const FILLER = "the quick brown fox jumps over the lazy dog. ".repeat(30);

function firstDiv(prev: any[], cur: any[]): number {
  const p = prev.map((m) => JSON.stringify(m));
  const c = cur.map((m) => JSON.stringify(m));
  for (let k = 0; k < Math.min(p.length, c.length); k++) {
    if (p[k] !== c[k]) return k;
  }
  return -1;
}

function divergences(views: any[][]): number[] {
  const out: number[] = [];
  for (let k = 1; k < views.length; k++) {
    if (firstDiv(views[k - 1]!, views[k]!) !== -1) out.push(k);
  }
  return out;
}

function visibleIn(view: any[], needle: string): boolean {
  return view.some((m) => JSON.stringify(m).includes(needle));
}

function refOfView(view: any[], needle: string): string {
  for (const m of view) {
    const json = JSON.stringify(m);
    if (!json.includes(needle)) continue;
    const match = json.match(/>(m\d{5})<\/acp>/);
    if (match) return match[1]!;
  }
  throw new Error(`no tagged message containing ${needle}`);
}

async function withStoreDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acp-rollover-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("in-phase pending compress calls keep the view byte-stable (restore fix)", async () => {
  await withStoreDir(async (dir) => {
    const stateFile = join(dir, "session.jsonl");
    const { api, handlers, tools } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000, rollover: true, autoUpdate: false })(api as any);
    const entries: any[] = [];
    const ctxOf = () => fakeCtx(entries, stateFile, 200_000);
    const compress = tools.find((t) => t.name === "compress")!;
    const ctx = ctxOf();
    const runRound = async () => {
      const res = await handlers.get("context")![0]!({
        type: "context",
        messages: entries.map((e) => e.message),
      }, ctx);
      return res.messages as any[];
    };

    const views: any[][] = [];
    for (let t = 1; t <= 16; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      views.push(await runRound());
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
    }

    const ranges = ["m00002..m00005", "m00008..m00011", "m00014..m00017"];
    for (let i = 0; i < ranges.length; i++) {
      const [startId, endId] = ranges[i]!.split("..");
      const callId = `tc${i + 1}`;
      const out = await compress.execute(callId, {
         content: [{ startId: startId!, endId: endId!, summary: `Pending range ${i + 1} summary: filler turns ${Number(startId!.slice(1)) / 2 - 1}..${Number(endId!.slice(1)) / 2} — repeated fox sentences only, no decisions recorded.` }],
      }, undefined, undefined, ctx) as { content: { text: string }[] };
      const text = out.content[0]!.text;
      assert.ok(!text.includes("FAILED"), `compress ${i + 1} failed: ${text}`);
      assert.ok(text.includes("recorded for next rollover"), `expected pending panel, got: ${text}`);
      entries.push(toolCallEntry(`c${i + 1}`, callId, "compress", { content: [{ startId: startId!, endId: endId!, summary: `Pending range ${i + 1}` }] }));
      entries.push(resultEntry(`r${i + 1}`, callId, "compress", text));
      views.push(await runRound());
    }

    // 16 base rounds + 3 post-compress rounds = 19 views. Every pair must be
    // append-only: the 3rd pending call would hide the 1st mid-history
    // (KEEP_LAST_ORPHANED=2) without the restore fix.
    assert.equal(views.length, 19);
    const divs = divergences(views);
    assert.deepEqual(divs, [], `view diverged in-phase at round(s) ${divs.join(", ")}`);
  });
});

test("rollover fires at threshold — one rewrite, then re-anchors", async () => {
  await withStoreDir(async (dir) => {
    const stateFile = join(dir, "session.jsonl");
    const { api, handlers, tools } = captureApi();
    createAcpExtension({ modelContextLimit: 12_000, rollover: true, autoUpdate: false })(api as any);
    const entries: any[] = [];
    const ctxOf = () => fakeCtx(entries, stateFile, 12_000);
    const compress = tools.find((t) => t.name === "compress")!;
    const ctx = ctxOf();
    const runRound = async () => {
      const res = await handlers.get("context")![0]!({
        type: "context",
        messages: entries.map((e) => e.message),
      }, ctx);
      return res.messages as any[];
    };

    // 11 turns (~7.3K tokens, 61% of 12K): past the 5000-token protected zone
    // for the m00002..m00005 range, below the 70% rollover threshold.
    const views: any[][] = [];
    for (let t = 1; t <= 11; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      views.push(await runRound());
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
    }

    const out = await compress.execute("tc1", {
      content: [{ startId: "m00002", endId: "m00005", summary: "Early filler turns 1-3: repeated fox sentences, no decisions." }],
    }, undefined, undefined, ctx) as { content: { text: string }[] };
    const text = out.content[0]!.text;
    assert.ok(text.includes("recorded for next rollover"), `expected pending panel, got: ${text}`);
    entries.push(toolCallEntry("c1", "tc1", "compress", { content: [{ startId: "m00002", endId: "m00005", summary: "Early filler" }] }));
    entries.push(resultEntry("r1", "tc1", "compress", text));
    views.push(await runRound());

    let rolloverAt = -1;
    for (let t = 12; t <= 30 && rolloverAt === -1; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      const view = await runRound();
      views.push(view);
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
      if (visibleIn(view, "▣ ACP rollover")) rolloverAt = views.length - 1;
    }
    assert.ok(rolloverAt > -1, "rollover never fired before 30 turns");
    const report = views[rolloverAt]!.map((m) => JSON.stringify(m)).find((j) => j.includes("▣ ACP rollover"))!;
    assert.match(report, /applied/);
    assert.match(report, /1 compression/);

    for (let t = 31; t <= 33; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      views.push(await runRound());
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
    }

    const divs = divergences(views);
    assert.deepEqual(divs, [rolloverAt, rolloverAt + 1], `expected the rollover round + its report-drop round, got ${divs.join(", ")}`);
  });
});

test("absorb: pair visible until rollover, gone after the single rewrite", async () => {
  await withStoreDir(async (dir) => {
    const stateFile = join(dir, "session.jsonl");
    const { api, handlers, tools } = captureApi();
    createAcpExtension({ modelContextLimit: 12_000, rollover: { threshold: 0.6 }, autoUpdate: false })(api as any);
    const entries: any[] = [];
    const ctxOf = () => fakeCtx(entries, stateFile, 12_000);
    const ctx = ctxOf();
    await handlers.get("session_start")![0]!({}, ctx);
    const absorb = tools.find((t) => t.name === "absorb")!;
    assert.ok(absorb, "absorb tool not registered");
    const runRound = async () => {
      const res = await handlers.get("context")![0]!({
        type: "context",
        messages: entries.map((e) => e.message),
      }, ctx);
      return res.messages as any[];
    };

    const BASH_BODY = "ABSORB-ME-OUTPUT " + "line of verbose tool output ".repeat(120);
    const views: any[][] = [];
    for (let t = 1; t <= 3; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      views.push(await runRound());
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
    }
    entries.push(toolCallEntry("cb", "cbash", "bash", { command: "ls -laR" }));
    entries.push(resultEntry("rb", "cbash", "bash", BASH_BODY));
    views.push(await runRound());
    assert.ok(visibleIn(views[views.length - 1]!, "ABSORB-ME-OUTPUT"));

    const ref = refOfView(views[views.length - 1]!, "ABSORB-ME-OUTPUT");
    const out = await absorb.execute("tabsorb", { ref, summary: "bash ls -laR: 42 files, 3 dirs; nothing unusual." }, undefined, undefined, ctx) as { content: { text: string }[] };
    const text = out.content[0]!.text;
    assert.ok(text.includes("recorded for the next rollover"), `expected pending absorb text, got: ${text}`);
    entries.push(toolCallEntry("ca", "tabsorb", "absorb", { ref, summary: "bash ls -laR: 42 files, 3 dirs; nothing unusual." }));
    entries.push(resultEntry("ra", "tabsorb", "absorb", text));
    views.push(await runRound());
    assert.ok(visibleIn(views[views.length - 1]!, "ABSORB-ME-OUTPUT"), "absorbed pair must stay visible until rollover");

    let rolloverAt = -1;
    for (let t = 4; t <= 30 && rolloverAt === -1; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      const view = await runRound();
      views.push(view);
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
      if (visibleIn(view, "▣ ACP rollover")) rolloverAt = views.length - 1;
    }
    assert.ok(rolloverAt > -1, "rollover never fired before 30 turns");
    assert.ok(!visibleIn(views[rolloverAt]!, "ABSORB-ME-OUTPUT"), "absorbed pair must be gone after rollover");
    assert.ok(visibleIn(views[rolloverAt]!, "42 files, 3 dirs"), "absorb summary must remain visible");

    for (let t = 31; t <= 33; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      views.push(await runRound());
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
    }
    const divs = divergences(views);
    assert.deepEqual(divs, [rolloverAt, rolloverAt + 1], `expected the rollover round + its report-drop round, got ${divs.join(", ")}`);
  });
});

test("decompress/search results append to tail (prefix byte-identical)", async () => {
  await withStoreDir(async (dir) => {
    const stateFile = join(dir, "session.jsonl");
    const { api, handlers, tools } = captureApi();
    createAcpExtension({ modelContextLimit: 12_000, rollover: true, autoUpdate: false })(api as any);
    const entries: any[] = [];
    const ctxOf = () => fakeCtx(entries, stateFile, 12_000);
    const ctx = ctxOf();
    const compress = tools.find((t) => t.name === "compress")!;
    const search = tools.find((t) => t.name === "search_context")!;
    const decompress = tools.find((t) => t.name === "decompress")!;
    const runRound = async () => {
      const res = await handlers.get("context")![0]!({
        type: "context",
        messages: entries.map((e) => e.message),
      }, ctx);
      return res.messages as any[];
    };

    const views: any[][] = [];
    for (let t = 1; t <= 11; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      views.push(await runRound());
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
    }
    const out = await compress.execute("tc1", {
      content: [{ startId: "m00002", endId: "m00005", summary: "Filler History: early fox-sentence turns, no decisions.", topic: "Filler History" }],
    }, undefined, undefined, ctx) as { content: { text: string }[] };
    entries.push(toolCallEntry("c1", "tc1", "compress", { content: [{ startId: "m00002", endId: "m00005", summary: "Filler History" }] }));
    entries.push(resultEntry("r1", "tc1", "compress", out.content[0]!.text));
    views.push(await runRound());

    let rolloverAt = -1;
    for (let t = 12; t <= 30 && rolloverAt === -1; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      const view = await runRound();
      views.push(view);
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
      if (visibleIn(view, "▣ ACP rollover")) rolloverAt = views.length - 1;
    }
    assert.ok(rolloverAt > -1, "rollover never fired");

    const base = views.length;
    const sOut = await search.execute("tsearch", { query: "Filler History" }, undefined, undefined, ctx) as { content: { text: string }[] };
    entries.push(toolCallEntry("cs", "tsearch", "search_context", { query: "Filler History" }));
    entries.push(resultEntry("rs", "tsearch", "search_context", sOut.content[0]!.text));
    views.push(await runRound());

    const outPath = join(dir, "b1-decompressed.txt");
    const dOut = await decompress.execute("tdecomp", { blockId: "b1", toFile: outPath }, undefined, undefined, ctx) as { content: { text: string }[] };
    assert.ok(!dOut.content[0]!.text.includes("FAILED"), `decompress failed: ${dOut.content[0]!.text}`);
    entries.push(toolCallEntry("cd", "tdecomp", "decompress", { blockId: "b1", toFile: outPath }));
    entries.push(resultEntry("rd", "tdecomp", "decompress", dOut.content[0]!.text));
    views.push(await runRound());
    const fileContent = await readFile(outPath, "utf8");
    assert.ok(fileContent.includes("user turn 2:"), "decompressed file should contain the original messages");

    for (let k = base + 1; k < views.length; k++) {
      assert.equal(firstDiv(views[k - 1]!, views[k]!), -1, `retrieval round ${k} must be a pure tail append`);
    }
  });
});

test("manual /acp-rollover applies pending work immediately", async () => {
  await withStoreDir(async (dir) => {
    const stateFile = join(dir, "session.jsonl");
    const { api, handlers, tools, commands } = captureApi();
    createAcpExtension({ modelContextLimit: 200_000, rollover: true, autoUpdate: false })(api as any);
    const entries: any[] = [];
    const ctxOf = () => fakeCtx(entries, stateFile, 200_000);
    const ctx = ctxOf();
    const compress = tools.find((t) => t.name === "compress")!;
    const runRound = async () => {
      const res = await handlers.get("context")![0]!({
        type: "context",
        messages: entries.map((e) => e.message),
      }, ctx);
      return res.messages as any[];
    };

    const views: any[][] = [];
    for (let t = 1; t <= 12; t++) {
      entries.push(entry(`u${t}`, "user", `user turn ${t}: ${FILLER}`));
      views.push(await runRound());
      entries.push(entry(`a${t}`, "assistant", `assistant reply ${t}: ${FILLER}`));
    }
    const out = await compress.execute("tc1", {
      content: [{ startId: "m00002", endId: "m00005", summary: "Manual rollover target: early filler turns with repeated fox sentences, no decisions recorded." }],
    }, undefined, undefined, ctx) as { content: { text: string }[] };
    assert.ok(out.content[0]!.text.includes("recorded for next rollover"));
    entries.push(toolCallEntry("c1", "tc1", "compress", { content: [{ startId: "m00002", endId: "m00005", summary: "Manual rollover target" }] }));
    entries.push(resultEntry("r1", "tc1", "compress", out.content[0]!.text));
    views.push(await runRound());
    assert.equal(firstDiv(views[views.length - 2]!, views[views.length - 1]!), -1, "no rollover below threshold");

    const notify: string[] = [];
    (ctx as any).ui.notify = (t: string) => notify.push(t);
    const cmd = commands.get("acp-rollover")!;
    assert.ok(cmd, "acp-rollover command not registered");
    await cmd.handler("", ctx);
    assert.ok(notify.length > 0, "command should notify");
    assert.match(notify.join("\n"), /▣ ACP rollover/);
    assert.match(notify.join("\n"), /applied/);

    views.push(await runRound());
    const last = views[views.length - 1]!;
    assert.ok(!visibleIn(last, "assistant reply 1: "), "compressed range must be gone after manual rollover");
    assert.ok(visibleIn(last, "user turn 12: "), "recent history must survive");
  });
});
