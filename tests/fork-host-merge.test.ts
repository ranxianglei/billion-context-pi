import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createInitialState, type CompressionState } from "acp-kernel";
import { createAcpExtension } from "../src/index.js";
import { extractText, matchesStoredText, messageIdentity, messageRef } from "../src/messages.js";
import { createRuntime, LiveEntryMerger } from "../src/runtime.js";
import { findPositionalPrefixRun, type MatchRange } from "../src/sequence-match.js";
import type { LiveRefOrigin } from "../src/state.js";

type AgentMessage = SessionMessageEntry["message"];

// Pre-cache merge (f9dc713), using a brute-force oracle for the unique run.
function legacyMerge(entries: SessionEntry[], live: AgentMessage[], state: CompressionState, origins: LiveRefOrigin[]): SessionEntry[] {
  const persisted = entries.filter((e): e is SessionMessageEntry => e.type === "message");
  const liveIdentities = live.map(messageIdentity);
  const persistedIdentities = persisted.map((entry) => messageIdentity(entry.message));
  const normalizedKeys = normalizePersistedMatchKeys(persisted, persistedIdentities, live, liveIdentities);
  // #459: the unique matcher gives up on duplicate-heavy views (ambiguous best
  // run), which previously stranded every live message and renumbered its
  // volatile live-N id each fire; the tail-anchored prefix run recovers the
  // alignment deterministically under append-only growth.
  const persistedRange = bruteForceMatch<MatchKey>(persistedIdentities, normalizedKeys) ?? findPositionalPrefixRun<MatchKey>(persistedIdentities, normalizedKeys);
  const originRange = bruteForceMatch(origins.map((origin) => origin.identity), liveIdentities);
  // #459: occurrence rank of each identity across (persisted + unmatched live
  // prefix). When a message gets persisted it moves from the live count into
  // the persisted count, so every still-live duplicate keeps the same rank —
  // its id stays put across fires.
  const identityRanks = new Map<string, number>();
  for (const identity of persistedIdentities) identityRanks.set(identity, (identityRanks.get(identity) ?? 0) + 1);
  const out: SessionEntry[] = [];
  const nextOrigins: LiveRefOrigin[] = [];
  for (let i = 0; i < live.length; i++) {
    const msg = live[i]!;
    const entry = valueInRange(persisted, persistedRange, i);
    const origin = valueInRange(origins, originRange, i);
    if (entry) {
      if (origin) migrateLiveRefs(state, origin.rawId, entry.id);
      else migrateTaggedRef(state, msg, entry.id);
      out.push(entry);
      continue;
    }
    const identity = liveIdentities[i]!;
    const rank = identityRanks.get(identity) ?? 0;
    identityRanks.set(identity, rank + 1);
    const id = origin?.rawId ?? stableLiveId(identity, rank);
    out.push({ type: "message", id, parentId: null, timestamp: String(msg.timestamp ?? Date.now()), message: msg });
    nextOrigins.push({ rawId: id, identity });
  }
  origins.splice(0, origins.length, ...nextOrigins);
  return out;
}

// #459: deterministic id for an unmatched live message — sha256 over its
// content identity plus occurrence rank, so the same logical message gets the
// same id on every context fire (and after a state rebuild) even when the
// unique matcher cannot align it.
function stableLiveId(identity: string, rank: number): string {
  return `live-${createHash("sha256").update(`${identity}\u0000${rank}`).digest("hex").slice(0, 16)}`;
}

function migrateTaggedRef(state: CompressionState, message: AgentMessage, stableId: string): void {
  const ref = messageRef(message);
  const rawId = ref ? state.messageRefs.byRef[ref] : undefined;
  if (rawId?.startsWith("live-")) migrateLiveRefs(state, rawId, stableId);
}

function migrateLiveRefs(state: CompressionState, liveId: string, stableId: string): void {
  const rootId = liveId.split("#", 1)[0]!;
  if (!rootId.startsWith("live-")) return;
  for (const [rawId, ref] of Object.entries(state.messageRefs.byRaw)) {
    if (rawId !== rootId && !rawId.startsWith(`${rootId}#`)) continue;
    const stableRawId = `${stableId}${rawId.slice(rootId.length)}`;
    if (state.messageRefs.byRaw[stableRawId] === undefined) {
      state.messageRefs.byRaw[stableRawId] = ref;
      state.messageRefs.byRef[ref] = stableRawId;
    } else if (state.messageRefs.byRef[ref] === rawId) {
      delete state.messageRefs.byRef[ref];
    }
    delete state.messageRefs.byRaw[rawId];
  }
}

type MatchKey = string | symbol;

const NO_PERSISTED_MATCH = Symbol("no-persisted-match");

function normalizePersistedMatchKeys(
  persisted: readonly SessionMessageEntry[],
  persistedIdentities: readonly string[],
  live: readonly AgentMessage[],
  liveIdentities: readonly string[],
): MatchKey[] {
  const persistedByStructure = new Map<string, number>();
  for (let index = 0; index < persisted.length; index++) {
    const key = toolResultStructureKey(persisted[index]!.message);
    if (key === undefined) continue;
    persistedByStructure.set(key, persistedByStructure.has(key) ? -1 : index);
  }
  return live.map((message, liveIndex) => {
    const key = toolResultStructureKey(message);
    const candidateIndex = key === undefined ? undefined : persistedByStructure.get(key);
    if (candidateIndex === undefined) return liveIdentities[liveIndex]!;
    if (candidateIndex < 0) return NO_PERSISTED_MATCH;
    return sameToolResult(persisted[candidateIndex]!.message, message)
      ? persistedIdentities[candidateIndex]!
      : liveIdentities[liveIndex]!;
  });
}

function toolResultStructureKey(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult") return undefined;
  return `${message.toolName}\0${message.toolCallId}`;
}

function valueInRange<T>(values: readonly T[], range: MatchRange | undefined, liveIndex: number): T | undefined {
  if (!range || liveIndex < range.liveStart || liveIndex >= range.liveStart + range.length) return undefined;
  return values[range.candidateStart + liveIndex - range.liveStart];
}

function sameToolResult(stored: AgentMessage, visible: AgentMessage): boolean {
  if (stored.role !== "toolResult" || visible.role !== "toolResult") return false;
  return sameNonTextBlocks(stored.content, visible.content)
    && matchesStoredText(extractText(stored.content), extractText(visible.content));
}

function sameNonTextBlocks(a: unknown, b: unknown): boolean {
  const nonText = (blocks: unknown[]): unknown[] => blocks.filter((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return true;
    return block.type !== "text";
  });
  try {
    const na = Array.isArray(a) ? nonText(a) : [];
    const nb = Array.isArray(b) ? nonText(b) : [];
    return JSON.stringify(na) === JSON.stringify(nb);
  } catch {
    return false;
  }
}

function bruteForceMatch<Key>(candidates: readonly Key[], live: readonly Key[]): MatchRange | undefined {
  let length = 0;
  let unique: MatchRange | undefined;
  for (let candidateStart = 0; candidateStart < candidates.length; candidateStart++) {
    for (let liveStart = 0; liveStart < live.length; liveStart++) {
      let run = 0;
      while (candidateStart + run < candidates.length && liveStart + run < live.length
        && candidates[candidateStart + run] === live[liveStart + run]) run++;
      if (run > length) {
        length = run;
        unique = { candidateStart, liveStart, length };
      } else if (run === length) {
        unique = undefined;
      }
    }
  }
  return unique;
}

const now = 1_700_000_000_000;
const refAt = (i: number) => `m${String(i + 1).padStart(5, "0")}`;
const tagAt = (i: number) => `\x3cacp tokens="2" type="text"\x3e${refAt(i)}\x3c/acp\x3e`;
const user = (content: string): Extract<AgentMessage, { role: "user" }> => ({ role: "user", content, timestamp: now });
const text = (text: string) => ({ type: "text" as const, text });
function entry(message: AgentMessage, i: number, prefix = "p"): SessionMessageEntry {
  return { type: "message", id: `${prefix}${i}`, parentId: i === 0 ? null : `${prefix}${i - 1}`, timestamp: new Date(now + i).toISOString(), message };
}

function initialState(): CompressionState {
  const state = createInitialState();
  const refs = ["live-opening#z", "live-opening", "live-opening#a", "p0#z", "live-result"];
  for (const [i, rawId] of refs.entries()) {
    const ref = refAt(i === 1 ? 0 : i === 0 ? 35 : i === 4 ? 2 : i + 35);
    state.messageRefs.byRaw[rawId] = ref;
    state.messageRefs.byRef[ref] = rawId;
  }
  state.nextBlockId = 2;
  state.nextRunId = 2;
  state.blocks.push({
    blockId: "b1", runId: "run-1", tier: 1, summary: "Earlier investigation summary.",
    directMessageIds: ["p0", "p1#call-0", "p2", "p3"], effectiveMessageIds: ["p0", "p1#call-0", "p2", "p3"],
    directBlockIds: [], compressedTokens: 800, createdAt: now, survivedCount: 0, generation: "old", active: true,
  });
  return state;
}

function turn(i: number, seed: number): AgentMessage[] {
  const base = {
    role: "assistant" as const, api: "openai-completions" as const, provider: "openai", model: "test", timestamp: now + i,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return [
    user(seed % 3 === 0 || i % 2 === 0 ? "Continue." : `Check item ${i}.`),
    { ...base, stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `file-${i}`, opts: { offset: 1 } } }] },
    { role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [text(`start-${i} ${"sample tool output ".repeat(30)} end-${i}`)], isError: false, timestamp: now + i },
    { ...base, stopReason: "stop", content: [text("Read complete.")] },
  ];
}

function* requests(seed: number): Generator<{ step: string; entries: SessionEntry[]; live: AgentMessage[] }> {
  const originals = Array.from({ length: 5 + seed % 4 }, (_, i) => turn(i, seed)).flat();
  let entries: SessionEntry[] = originals.slice(0, -1).map((msg, i) => entry(msg, i));
  let live = structuredClone(originals).map((msg, i): AgentMessage => {
    if (msg.role === "user" && typeof msg.content === "string") {
      return { ...msg, content: i % 8 === 0 ? `${msg.content}\n${tagAt(i)}` : [text(msg.content), text(tagAt(i))] };
    }
    if (msg.role === "toolResult") {
      const call = Math.floor(i / 4);
      return { ...msg, content: [text(`start-${call}\n\n...[truncated for context space] — original ~300 tokens]...\n\nend-${call}\n[${refAt(i)}]`)] };
    }
    return msg;
  });
  yield { step: "cold", entries, live };
  entries.push(entry(originals.at(-1)!, entries.length));
  live.push(user("Continue."));
  yield { step: "persist and append", entries, live };
  entries.push(entry(user("Continue."), entries.length));
  live = structuredClone([...live, user("Unpersisted A."), user("Unpersisted B.")]);
  yield { step: "clone and append two", entries, live };
  // The raw identity sequences still have their prefixes, but the extra tool
  // result makes the earlier #581 normalization ambiguous.
  entries.push(entry(structuredClone(originals[2]!), entries.length));
  yield { step: "duplicate tool result invalidates normalized prefix", entries, live };
  const edited = live[5]!;
  if (edited.role === "assistant" && edited.content[0]?.type === "toolCall") {
    (edited.content[0].arguments.opts as { offset: number }).offset++;
  }
  yield { step: "in-place nested edit", entries, live };
  entries = entries.slice(2, -1).map((e, i) => entry((e as SessionMessageEntry).message, i, "fork"));
  live = [user("Fork intro."), ...live.slice(2, -1)];
  yield { step: "fork", entries, live };
  entries = [{ type: "compaction", id: "compact", timestamp: new Date(now).toISOString(), parentId: null, firstKeptEntryId: entries.at(-3)!.id, tokensBefore: 1000, summary: "Compacted early turns." }, ...entries.slice(-3)];
  live = [user("Compacted early turns."), ...live.slice(-3)];
  yield { step: "compaction", entries, live };
}

function bytes(value: unknown): string {
  return JSON.stringify(value);
}

test("fork-host cache preserves legacy entries, ref order and live origins across changes", () => {
  for (let seed = 0; seed < 24; seed++) {
    const state = initialState();
    const oldState = structuredClone(state);
    const origins: LiveRefOrigin[] = [];
    const oldOrigins: LiveRefOrigin[] = [];
    const merger = new LiveEntryMerger();
    for (const { step, entries, live } of requests(seed)) {
      const label = `seed ${seed}: ${step}`;
      const expected = legacyMerge(entries, live, oldState, oldOrigins);
      assert.equal(bytes(merger.mergeLiveEntries(entries, live, state, origins)), bytes(expected), label);
      assert.equal(bytes(state.messageRefs), bytes(oldState.messageRefs), label);
      assert.equal(bytes(origins), bytes(oldOrigins), label);
    }
  }
});

test("migration indexes newly moved aliases and preserves collision semantics", () => {
  const live = [user(`one\n[${refAt(0)}]`), user(`two\n[${refAt(1)}]`)];
  const entries = [entry(user("one"), 0), entry(user("two"), 1)];
  entries[0]!.id = "live-next";
  const state = createInitialState();
  const ids = ["live-old#z", "live-old", "live-next", "live-old#a", "p1#z", "live-next#kept"];
  for (const [i, id] of ids.entries()) {
    const ref = refAt(i === 1 ? 0 : i === 2 ? 1 : i + 2);
    state.messageRefs.byRaw[id] = ref;
    state.messageRefs.byRef[ref] = id;
  }
  const expected = structuredClone(state);
  legacyMerge(entries, live, expected, []);
  new LiveEntryMerger().mergeLiveEntries(entries, live, state, []);
  assert.equal(bytes(state.messageRefs), bytes(expected.messageRefs));
  assert.equal(state.messageRefs.byRaw["p1#a"], refAt(5));
  assert.equal(state.messageRefs.byRef[refAt(2)], undefined);
});

function forkContext(dir: string, sessionId: string, readEntries: () => SessionEntry[], sessionFile?: string): ExtensionContext {
  return {
    cwd: dir, hasUI: false, model: { id: "test", contextWindow: 200_000 }, getContextUsage: () => null,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getBranch: readEntries },
  } as unknown as ExtensionContext;
}

test("append-only fork-host stateFor skips suffix sorting and drops the matcher with the projection cache", async (t) => {
  const runtime = createRuntime({});
  const persisted = Array.from({ length: 160 }, (_, i) => entry(user(`entry ${i}`), i));
  const live = [...persisted.map((e) => structuredClone(e.message)), user("tail")];
  const ctx = forkContext(tmpdir(), "warm-match", () => persisted);
  const sort = Array.prototype.sort;
  let suffixSorts = 0;
  Array.prototype.sort = function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
    if (this.length >= 160 && typeof this[0] === "number") suffixSorts++;
    return sort.call(this, compare);
  };
  t.after(() => { Array.prototype.sort = sort; });
  await runtime.stateFor(ctx, live);
  assert.ok(suffixSorts > 0, "cold request must exercise the original matcher");
  suffixSorts = 0;
  for (let i = 0; i < 4; i++) {
    persisted.push(entry(live.at(-1)!, persisted.length));
    live.push(user(`tail ${i}`));
    await runtime.stateFor(ctx, structuredClone(live));
  }
  assert.equal(suffixSorts, 0, "small append-only requests must not rebuild the suffix array");
  live[20]!.content = "edited";
  await runtime.stateFor(ctx, live);
  assert.ok(suffixSorts > 0, "editing the prefix must use the original matcher");
  suffixSorts = 0;
  runtime.dropProjectionCache("warm-match");
  await runtime.stateFor(ctx, live);
  assert.ok(suffixSorts > 0, "dropping the session cache makes the next request cold");
});

type ContextHandler = (event: { type: "context"; messages: AgentMessage[] }, ctx: ExtensionContext) => Promise<{ messages: AgentMessage[] } | undefined>;
function captureContext(): ContextHandler {
  let handler: ContextHandler | undefined;
  const api = {
    on(name: string, fn: ContextHandler) { if (name === "context") handler = fn; },
    registerTool() {}, registerCommand() {},
  };
  createAcpExtension({ autoUpdate: false })(api as unknown as ExtensionAPI);
  assert.ok(handler);
  return handler;
}

test("full fork-host context output and saved sidecars are byte-identical to the legacy merge", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bcp-fork-merge-"));
  const env = ["HOME", "PI_ACP_FORK_HOST", "BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_NATIVE"]
    .map((key) => [key, process.env[key]] as const);
  process.env.HOME = dir;
  process.env.PI_ACP_FORK_HOST = "1";
  delete process.env.BILLION_CONTEXT_PROXY;
  delete process.env.BILLION_CONTEXT_NATIVE;
  t.after(async () => {
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(Date, "now", () => now);
  const realMerge = LiveEntryMerger.prototype.mergeLiveEntries;
  let useLegacy = false;
  t.mock.method(LiveEntryMerger.prototype, "mergeLiveEntries", function (this: LiveEntryMerger, ...args: Parameters<typeof legacyMerge>) {
    return useLegacy ? legacyMerge(...args) : realMerge.call(this, ...args);
  });
  for (const seed of [0, 1, 3, 6]) {
    const before = captureContext();
    const after = captureContext();
    const beforeFile = join(dir, `before-${seed}.jsonl`);
    const afterFile = join(dir, `after-${seed}.jsonl`);
    const savedState = bytes(initialState());
    await writeFile(`${beforeFile}.acp.json`, savedState);
    await writeFile(`${afterFile}.acp.json`, savedState);
    const legacyRequests = requests(seed);
    for (const { step, entries, live } of requests(seed)) {
      const previous = legacyRequests.next();
      assert.ok(!previous.done);
      const label = `seed ${seed}: ${step}`;
      useLegacy = true;
      const oldView = await before({ type: "context", messages: previous.value.live }, forkContext(dir, `before-${seed}`, () => previous.value.entries, beforeFile));
      assert.ok(oldView?.messages.length, label);
      const oldMessages = bytes(oldView.messages);
      const oldSidecar = await readFile(`${beforeFile}.acp.json`, "utf8");
      assert.notEqual(oldSidecar, savedState, label);
      useLegacy = false;
      const newView = await after({ type: "context", messages: live }, forkContext(dir, `after-${seed}`, () => entries, afterFile));
      assert.equal(bytes(newView?.messages), oldMessages, label);
      assert.equal(await readFile(`${afterFile}.acp.json`, "utf8"), oldSidecar, label);
    }
  }
});
