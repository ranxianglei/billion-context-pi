import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCompressModel } from "../src/auto-compress.js";

const registry = {
  find(provider: string, modelId: string) {
    if (provider === "qwen" && modelId === "qwen3-coder") return { provider: "qwen", id: "qwen3-coder" };
    return undefined;
  },
};

test("resolveCompressModel: explicit compressModel wins", () => {
  const r = resolveCompressModel(registry, { provider: "opencode", id: "default" }, "qwen:qwen3-coder");
  assert.deepEqual(r, { model: { provider: "qwen", id: "qwen3-coder" }, label: "qwen:qwen3-coder" });
});

test("resolveCompressModel: falls back to current session model when unconfigured", () => {
  const r = resolveCompressModel(registry, { provider: "opencode", id: "deepseek-v4-flash" }, null);
  assert.deepEqual(r, { model: { provider: "opencode", id: "deepseek-v4-flash" }, label: "opencode:deepseek-v4-flash" });
});

test("resolveCompressModel: null when configured model not found", () => {
  assert.equal(resolveCompressModel(registry, { provider: "opencode", id: "default" }, "qwen:nope"), null);
});

test("resolveCompressModel: null when neither configured nor current model", () => {
  assert.equal(resolveCompressModel(registry, undefined, null), null);
});

test("resolveCompressModel: parses provider-less config as openai", () => {
  const r = resolveCompressModel(
    {
      find(provider: string) {
        return provider === "openai" ? { provider: "openai", id: "gpt-4o-mini" } : undefined;
      },
    },
    undefined,
    "gpt-4o-mini",
  );
  assert.deepEqual(r, { model: { provider: "openai", id: "gpt-4o-mini" }, label: "gpt-4o-mini" });
});
