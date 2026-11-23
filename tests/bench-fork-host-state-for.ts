import assert from "node:assert/strict";
import type { Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import type { ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "acp-kernel";
import { messageIdentity } from "../src/messages.js";
import { createRuntime } from "../src/runtime.js";

type Message = SessionMessageEntry["message"];

const size = 4_800;
const refCount = 8_900;
const blockCount = 78;
const warmRequests = 8;
const trials = 3;
const baseTimestamp = 1_700_000_000_000;
const sessionId = "bench-fork-host";
const samplingInterval = 100;

const refAt = (index: number) => `m${String(index + 1).padStart(5, "0")}`;
const rawIdAt = (index: number) => `live-${index.toString(16).padStart(16, "0")}`;

function messageAt(index: number): Message {
  const timestamp = baseTimestamp + index;
  const turn = Math.floor(index / 4);
  if (index % 4 === 0) {
    const content = turn % 5 === 0 && index < size - 4 ? "Continue." : `Read file ${turn}.`;
    return { role: "user", content: turn % 2 === 0 ? content : [{ type: "text", text: content }], timestamp };
  }
  if (index % 4 === 2) {
    const text = `${turn}: ${"sample output from a tool\n".repeat(90)}end`;
    return {
      role: "toolResult", toolCallId: `call-${turn}`, toolName: "read", isError: false, timestamp,
      content: [{ type: "text", text }], details: { page: { offset: 0, limit: 90 } },
    };
  }
  return {
    role: "assistant", api: "openai-completions", provider: "openai", model: "bench", timestamp,
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: index % 4 === 1 ? "toolUse" : "stop",
    content: index % 4 === 1
      ? [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: { limit: 90, path: `file-${turn}.txt`, offset: 0 } }]
      : [{ type: "text", text: "Read complete." }],
  };
}

function liveVersion(message: Message, index: number): Message {
  if (message.role !== "user" && message.role !== "toolResult") return message;
  const ref = refAt(index);
  const tag = index % 4 === 0 ? `\x3cacp tokens="2" type="text"\x3e${ref}\x3c/acp\x3e` : `[${ref}]`;
  const content = typeof message.content === "string"
    ? `${message.content}\n${tag}`
    : message.content.map((block) => block.type === "text" ? { ...block, text: `${block.text}\n${tag}` } : block);
  return { ...message, content } as Message;
}

function entryAt(message: Message, index: number): SessionMessageEntry {
  return { type: "message", id: `p${index}`, parentId: index === 0 ? null : `p${index - 1}`, timestamp: new Date(baseTimestamp + index).toISOString(), message };
}

function savedState() {
  const state = createInitialState();
  const ids = Array.from({ length: refCount }, (_, index) => index < refCount - 273
    ? rawIdAt(index)
    : `${rawIdAt((index - refCount + 273) * 4 + 2)}#call-${index}`);
  for (const [index, id] of ids.entries()) {
    const ref = refAt(index);
    state.messageRefs.byRaw[id] = ref;
    state.messageRefs.byRef[ref] = id;
  }
  for (let i = 0; i < blockCount; i++) {
    const start = Math.floor(i * refCount / blockCount);
    const end = Math.floor((i + 1) * refCount / blockCount);
    state.blocks.push({
      blockId: `b${i + 1}`, runId: `run-${i + 1}`, tier: 1, summary: `Block ${i + 1}`,
      directMessageIds: ids.slice(start, end), effectiveMessageIds: ids.slice(Math.max(0, start - 100), end),
      directBlockIds: [], compressedTokens: 4_000, createdAt: baseTimestamp, survivedCount: 0, generation: "old", active: true,
    });
  }
  return state;
}

const phases = ["stateFor (wall)", "mergeLiveEntries", "messageIdentity / memo checks", "longest-run matching / suffix array", "migrateTaggedRef / migrateLiveRefs", "normalizePersistedMatchKeys"] as const;

function phase({ callFrame: { functionName: name, url } }: Profiler.ProfileNode): number {
  if (name === "mergeLiveEntries") return 1;
  if (name === "messageIdentity" || (name === "read" && url.endsWith("/message-identity-cache.ts"))) return 2;
  if (url.endsWith("/sequence-match.ts") && ["match", "findUniqueLongestRun", "findLongestRun", "buildSuffixArray"].includes(name)) return 3;
  if (name === "migrateTaggedRef" || name === "migrateLiveRefs") return 4;
  if (name === "normalizePersistedMatchKeys") return 5;
  return 0;
}

function durations(profile: Profiler.Profile, elapsed: number): number[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const phaseMasks = new Map<number, number>();
  function visit(id: number, parentMask: number): void {
    const node = nodes.get(id)!;
    const own = phase(node);
    const mask = parentMask | (own === 0 ? 0 : 1 << own);
    phaseMasks.set(id, mask);
    for (const child of node.children ?? []) visit(child, mask);
  }
  visit(profile.nodes[0]!.id, 0);
  const times = Array<number>(phases.length).fill(0);
  times[0] = elapsed;
  for (const [i, sample] of (profile.samples ?? []).entries()) {
    const mask = phaseMasks.get(sample) ?? 0;
    for (let p = 1; p < phases.length; p++) {
      if (mask & (1 << p)) times[p]! += (profile.timeDeltas?.[i] ?? 0) / 1_000;
    }
  }
  return times;
}

function stats(samples: number[][], phaseIndex: number): string {
  const sorted = samples.map((sample) => sample[phaseIndex]!).sort((a, b) => a - b);
  const percentile = (p: number) => {
    const value = sorted[Math.ceil(sorted.length * p) - 1]!;
    return value < 0.1 ? "<0.10" : value.toFixed(2);
  };
  return `${percentile(0.5)} / ${percentile(0.95)}`;
}

assert.equal(process.env.PI_ACP_FORK_HOST, "1", "Run with PI_ACP_FORK_HOST=1");
console.log(`Node ${process.version}; ${size} persisted messages + 1 live tail; ${refCount} saved refs; ${blockCount} blocks; ${trials} trials.`);
console.log(`Median / p95, ms. stateFor is wall time; other rows are inclusive V8 CPU profile estimates (${samplingInterval} µs sampling interval).`);
console.log("Warm requests append 1–2 messages and persist the previous tail. The last warm request in each trial reloads the saved aliases to measure a migration burst.");
const profiler = new Session();
profiler.connect();
try {
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.setSamplingInterval", { interval: samplingInterval });
  for (const cloneLive of [false, true]) {
    const cold: number[][] = [];
    const warm: number[][] = [];
    const reload: number[][] = [];
    for (let trial = 0; trial < trials; trial++) {
      const messages = Array.from({ length: size + 1 }, (_, index) => messageAt(index));
      const live = messages.map(liveVersion);
      const persisted = messages.slice(0, -1).map(entryAt);
      const ctx = {
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => undefined,
          getBranch: () => [...persisted],
        },
      } as unknown as ExtensionContext;
      const runtime = createRuntime({});
      await runtime.store.save(savedState(), undefined, sessionId);
      runtime.store.setLiveRefOrigins(undefined, sessionId, [size - 2, size - 1, size].map((i) => ({
        rawId: rawIdAt(i), identity: messageIdentity(live[i]),
      })));
      for (let step = 0; step <= warmRequests; step++) {
        for (let growth = step === 0 ? 0 : 1 + step % 2; growth > 0; growth--) {
          const index = messages.length;
          persisted.push(entryAt(messages[index - 1]!, index - 1));
          const message = messageAt(index);
          messages.push(message);
          live.push(liveVersion(message, index));
        }
        if (step === warmRequests) await runtime.store.save(savedState(), undefined, sessionId);
        const request = cloneLive ? structuredClone(live) : [...live];
        await profiler.post("Profiler.start");
        const start = performance.now();
        const { entries, state } = await runtime.stateFor(ctx, request);
        const elapsed = performance.now() - start;
        const { profile } = await profiler.post("Profiler.stop");
        (step === 0 ? cold : step === warmRequests ? reload : warm).push(durations(profile, elapsed));
        assert.equal(entries.length, live.length);
        assert.equal(entries[0]?.id, persisted[0]?.id);
        assert.equal(entries.at(-2)?.id, persisted.at(-1)?.id);
        assert.match(entries.at(-1)?.id ?? "", /^live-/);
        assert.equal(state.messageRefs.byRef[refAt(0)], "p0");
      }
    }
    console.log(`\n${cloneLive ? "Cloned" : "Retained"} live message objects:`);
    console.log(`| Phase | Cold (n=${cold.length}) | Warm append (n=${warm.length}) | Warm append + ref reload (n=${reload.length}) |`);
    console.log("| --- | ---: | ---: | ---: |");
    for (const [i, name] of phases.entries()) console.log(`| ${name} | ${stats(cold, i)} | ${stats(warm, i)} | ${stats(reload, i)} |`);
  }
} finally {
  profiler.disconnect();
}
