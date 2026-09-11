import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, PRODUCER_NAME, createSidecarEnvelope, type BcpBlockV1 } from "../src/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Must stay in sync with src/contract.ts BcpBlockV1 required fields and schema/bcp-block-v1.json.
const REQUIRED = ["blockId", "summary", "tier", "compressedTokens", "createdAt"];
const OPTIONAL = ["topic", "startRef", "endRef", "effectiveMessageIds"];

test("SCHEMA_VERSION and PRODUCER_NAME are stable", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(PRODUCER_NAME, "billion-context-pi");
});

test("createSidecarEnvelope: includes version when provided", () => {
  assert.deepEqual(createSidecarEnvelope("0.1.65"), {
    schemaVersion: 1,
    producer: { name: "billion-context-pi", version: "0.1.65" },
  });
});

test("createSidecarEnvelope: omits version when unknown (dev/test build)", () => {
  const env = createSidecarEnvelope(undefined);
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.producer.name, "billion-context-pi");
  assert.ok(!("version" in env.producer), "version key must be absent, not undefined");
});

test("schema/bcp-block-v1.json stays in sync with the BcpBlockV1 contract", async () => {
  const raw = await readFile(path.join(here, "..", "schema", "bcp-block-v1.json"), "utf8");
  const schema = JSON.parse(raw) as {
    type: string;
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<string, unknown>;
  };
  assert.equal(schema.type, "object");
  assert.deepEqual([...(schema.required ?? [])].sort(), [...REQUIRED].sort());
  assert.equal(schema.additionalProperties, true, "internal fields outside the contract must remain allowed");
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    assert.ok(schema.properties[key], `schema must define property ${key}`);
  }
});

test("BcpBlockV1 exposes exactly the documented required core", () => {
  const block: BcpBlockV1 = { blockId: "b1", summary: "s", tier: 1, compressedTokens: 10, createdAt: 172 };
  for (const key of REQUIRED) assert.ok(key in block, `BcpBlockV1 requires ${key}`);
});
