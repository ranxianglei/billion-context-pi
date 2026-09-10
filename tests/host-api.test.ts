// Host-adapter contract reachability (docs/host-adapter.md, issue #367): every
// symbol under test is imported ONLY from the package name "billion-context-pi"
// (Node self-reference → dist/index.js), never from relative src paths. This
// pins the documented entrypoint surface; acp-kernel is used for fixtures only.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialState, type CompressionBlock } from "acp-kernel";

type Entrypoint = typeof import("billion-context-pi");

const DIST_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function loadEntrypoint(t: TestContext): Promise<Entrypoint | undefined> {
  if (!existsSync(DIST_ENTRY)) {
    t.skip("dist/index.js not found — run `npm run build` first (CI builds before testing)");
    return undefined;
  }
  return await import("billion-context-pi");
}

function makeBlock(id: string, active = true): CompressionBlock {
  return { blockId: id, runId: 0, tier: 1, generation: "young", active, summary: `summary ${id}`, directMessageIds: ["msg-a"], effectiveMessageIds: ["msg-a"], survivedCount: 1, createdAt: Date.now() };
}

test("entrypoint exports the documented host-facing API (#367)", async (t) => {
  const bcp = await loadEntrypoint(t);
  if (!bcp) return;
  assert.equal(typeof bcp.createAcpExtension, "function", "createAcpExtension");
  assert.equal(typeof bcp.createRuntime, "function", "createRuntime must be reachable from the package entrypoint");
  assert.equal(typeof bcp.deriveChildState, "function", "pure deriveChildState must be reachable from the package entrypoint");
});

test("pure deriveChildState via entrypoint deep-copies blocks", async (t) => {
  const bcp = await loadEntrypoint(t);
  if (!bcp) return;
  const parent = createInitialState();
  parent.blocks.push(makeBlock("b0"), makeBlock("b1", false));
  parent.nextBlockId = 3;
  const child = bcp.deriveChildState(parent);
  assert.deepEqual(child.blocks.map((b) => b.blockId), ["b0", "b1"]);
  assert.notEqual(child.blocks[0], parent.blocks[0], "blocks copied, not shared");
  assert.equal(child.nudge.baselineTokens, 0, "rhythm ledger reset");
  assert.equal(child.nextBlockId, 3);
});

test("documented call: runtime.deriveChildState(childRef, parentRef) round-trips through the entrypoint", async (t) => {
  const bcp = await loadEntrypoint(t);
  if (!bcp) return;
  const dir = await mkdtemp(path.join(tmpdir(), "acp-hostapi-"));
  try {
    const parentJsonl = path.join(dir, "parent.jsonl");
    const childJsonl = path.join(dir, "child.jsonl");
    const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp" }) + "\n";
    await writeFile(parentJsonl, header("parent-sid"), "utf8");
    await writeFile(childJsonl, header("child-sid"), "utf8");

    const parentState = createInitialState();
    parentState.blocks.push(makeBlock("b0"), makeBlock("b1", false));
    parentState.nextBlockId = 3;
    parentState.nudge.baselineTokens = 5000;
    await writeFile(`${parentJsonl}.acp.json`, JSON.stringify({ ...parentState, liveRefOrigins: [] }), "utf8");

    const runtime = bcp.createRuntime({});
    const childRef = { sessionId: "child-sid", sessionFile: childJsonl };
    const parentRef = { sessionId: "parent-sid", sessionFile: parentJsonl };

    assert.equal(await runtime.deriveChildState(childRef, parentRef), true, "derivation succeeds");

    const raw = JSON.parse(await readFile(`${childJsonl}.acp.json`, "utf8")) as {
      blocks: unknown[];
      nextBlockId: number;
      nudge: { baselineTokens: number };
      derivedFrom?: { parentSessionId: string };
    };
    assert.equal(raw.blocks.length, 2, "inherited blocks persisted into the independent child sidecar");
    assert.equal(raw.nextBlockId, 3, "id counter carried");
    assert.equal(raw.nudge.baselineTokens, 0, "rhythm baseline reset");
    assert.equal(raw.derivedFrom?.parentSessionId, "parent-sid", "one-time derivation marker persisted");

    assert.equal(await runtime.deriveChildState(childRef, parentRef), false, "marker present → no re-derivation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
