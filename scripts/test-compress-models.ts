import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { sliceRange, formatSlice, parseSummary, SYSTEM_PROMPT } from "../src/auto-compress.js";

const agentDir = join(homedir(), ".pi", "agent");
const store = JSON.parse(readFileSync(join(agentDir, "alibaba-coding-models.cache.json"), "utf8")) as {
  models?: Array<{ id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; input?: string[]; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>;
};
const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, { type?: string; access?: string; key?: string }>;

const PROVIDER = "alibaba-coding";
const BASE_URL = "https://coding.dashscope.aliyuncs.com/apps/anthropic";
const API = "anthropic-messages";

const MODELS = ["qwen3.7-plus", "qwen3.6-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5"];

function makeState(): CompressionState {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const byRaw: Record<string, string> = {};
  ids.forEach((id, i) => {
    byRaw[id] = `m${String(i + 1).padStart(5, "0")}`;
  });
  return {
    blocks: [],
    messageRefs: { byRaw, byRef: Object.fromEntries(Object.entries(byRaw).map(([k, v]) => [v, k])) },
    nudge: { shownKeys: new Set<string>() },
    stats: { compressions: 0, tokensCompressed: 0, messagesCompressed: 0, lastCompressedAt: 0 },
    nextBlockId: 1,
    nextRunId: 1,
  };
}

const msgs: CoreMessage[] = [
  { id: "a", role: "user", contentType: "text", text: "给 pi 增加一个扩展，实现 omp /drop 的命令和功能" },
  { id: "b", role: "tool", contentType: "text", toolName: "grep", text: "src/commands.ts:42  handleDropCommand\nsrc/index.ts:191  pi.registerCommand(\"drop\", ...)\n3 files matched" },
  { id: "c", role: "assistant", contentType: "text", text: "定位到 handleDropCommand（command-controller.ts:996）。扩展用 ctx.newSession() 后 fs.rm 旧 sessionFile + artifactsDir 实现。" },
  { id: "d", role: "tool", contentType: "text", toolName: "bash", text: "Error: Cannot find module './user-metrics'\n    at Module._compile (node:internal/modules/cjs/loader:1254:14)\n    at Object.<anonymous> (/Volumes/code/ai-agents/billion-context-pi/scripts/build.mjs:12:7)\n    at processTicksAndRejections (node:internal/process/task_queues:96:5)\n原因是 cp 时漏拷了源目录第 6 个文件 user-metrics.ts（parser.ts 依赖它），已补拷，bundle 6 模块通过。" },
  { id: "e", role: "assistant", contentType: "text", text: "修复完成：dist/index.js 637.91KB，md5 与已安装 npm 版一致。下一步验证 /drop 删除会话文件。" },
  { id: "f", role: "user", contentType: "text", text: "构建通过了吗？跑一下测试确认" },
  { id: "g", role: "tool", contentType: "text", toolName: "bash", text: "✔ tests/auto-compress.test.ts (45 tests) 12ms\n✔ tests/integration.test.ts 8ms\n  ✓ sliceRange: filters by ref range inclusive\n  ✓ parseSummary: strips json fences" },
  { id: "h", role: "assistant", contentType: "text", text: "45 个测试全部通过。npm run typecheck 无错误。" },
];

const state = makeState();
const slice = sliceRange(msgs, state, "m00002", "m00007");
const PROMPT = `${SYSTEM_PROMPT}\n\nMessage range [m00002..m00007] (6 messages). Compress it:\n\n${formatSlice(slice, state)}`;

const ANCHORS = [
  "command-controller.ts:996",
  "user-metrics.ts",
  "dist/index.js",
  "637.91KB",
  "auto-compress.test.ts",
];

async function run() {
  for (const id of MODELS) {
    const def = store.models?.find((m) => m.id === id);
    if (!def) {
      console.log(`[${id}] NOT FOUND in alibaba-coding-models.cache.json`);
      continue;
    }
    const model = {
      ...def,
      provider: PROVIDER,
      baseUrl: BASE_URL,
      api: API,
      cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const apiKey = auth[PROVIDER]?.access ?? auth[PROVIDER]?.key ?? "";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    const t0 = Date.now();
    try {
      const out = await complete(model, {
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }], timestamp: Date.now() }],
      }, { apiKey, maxTokens: 3000, signal: ac.signal });
      // reasoning 模型返回 thinking block + text block，找 type=text
      const textBlock = out?.content?.find((c: { type?: string }) => c.type === "text");
      const text = textBlock?.text ?? "";
      const summary = parseSummary(text);
      const ms = Date.now() - t0;
      if (!summary) {
        console.log(`[${id}] ${ms}ms FAIL: 输出无法解析为 JSON summary. 原文前 200 字符: ${text.slice(0, 200).replace(/\n/g, " ")}`);
        continue;
      }
      const missing = ANCHORS.filter((a) => !summary.includes(a));
      const tooShort = summary.length < 50;
      console.log(`[${id}] ${ms}ms len=${summary.length} ${tooShort ? "FAIL(len<50)" : missing.length ? `FAIL(缺锚点: ${missing.join(", ")})` : "PASS"}`);
      console.log(`      ${summary.slice(0, 300).replace(/\n/g, " ")}`);
    } catch (e: unknown) {
      console.log(`[${id}] ERROR ${Date.now() - t0}ms: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
run();
