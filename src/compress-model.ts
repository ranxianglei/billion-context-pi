import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";

/** Sentinel compressionModelId value meaning "use the session's own model".
 *  The compression call reuses the session's prompt prefix (system prompt +
 *  tools + messages) so it hits the provider's prompt cache — isolation without
 *  a cheaper model. Distinct from a models.json ref (which is "provider/id"). */
export const SESSION_MODEL_REF = "session";

/** A model defined in models.json, addressed by provider + id. */
export interface CompressionModelInfo {
  provider: string;
  id: string;
  name?: string;
}

/** A resolved model ready for an LLM call. */
export interface ResolvedCompressionModel {
  provider: string;
  id: string;
  model: Model<Api>;
}

/** Result of resolving a user-supplied ref. `model` is set when the ref is
 *  unambiguous; `ambiguous` lists candidates when a bare id matches several. */
export interface ResolveResult {
  model: ResolvedCompressionModel | null;
  ambiguous: CompressionModelInfo[];
}

/** Injectable LLM call. Defaults to ModelRuntime.complete (streams SSE). */
export type CompleteFn = (model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>) => Promise<AssistantMessage>;

export interface CompressionModelClientOptions {
  /** Override the models.json path (default: ~/.pi/agent/models.json). */
  modelsPath?: string;
  /** Injectable LLM call for tests. */
  complete?: CompleteFn;
  /** Injectable runtime factory for tests. */
  createRuntime?: (opts: { modelsPath?: string }) => Promise<ModelRuntime>;
}

/** Default models.json path — Pi's own agent dir (homedir/.pi/agent by default,
 *  honors the PI_CODING_AGENT_DIR override). */
export function defaultModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

interface ModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: Array<{ id: string; name?: string }>;
}
type ModelsJson = { providers?: Record<string, ModelsJsonProvider> };

async function readModelsJson(modelsPath: string): Promise<Record<string, ModelsJsonProvider>> {
  try {
    const raw = await fs.readFile(modelsPath, "utf8");
    const parsed = JSON.parse(raw) as ModelsJson;
    return parsed?.providers ?? {};
  } catch {
    return {};
  }
}

/**
 * Client for the dedicated compression model. Reads ~/.pi/agent/models.json for
 * model discovery and uses a ModelRuntime (same source Pi uses) for the actual
 * LLM call, so provider-specific request/auth handling is reused rather than
 * re-implemented.
 */
export class CompressionModelClient {
  private readonly modelsPath: string;
  private readonly complete: CompleteFn;
  private readonly createRuntime: (opts: { modelsPath?: string }) => Promise<ModelRuntime>;
  private runtimePromise: Promise<ModelRuntime> | null = null;

  constructor(options: CompressionModelClientOptions = {}) {
    this.modelsPath = options.modelsPath ?? defaultModelsPath();
    this.createRuntime = options.createRuntime ?? ((opts) => ModelRuntime.create({ modelsPath: opts.modelsPath, allowModelNetwork: false }));
    this.complete = options.complete ?? (async (model, context, opts) => (await this.getRuntime()).complete(model, context, opts));
  }

  private getRuntime(): Promise<ModelRuntime> {
    if (!this.runtimePromise) this.runtimePromise = this.createRuntime({ modelsPath: this.modelsPath });
    return this.runtimePromise;
  }

  /** Models the user defined in models.json (NOT built-in providers). */
  async listModels(): Promise<CompressionModelInfo[]> {
    const providers = await readModelsJson(this.modelsPath);
    const out: CompressionModelInfo[] = [];
    for (const [provider, cfg] of Object.entries(providers)) {
      for (const m of cfg.models ?? []) out.push({ provider, id: m.id, name: m.name });
    }
    return out;
  }

  /** Resolve a ref: "provider/id" (explicit) or a bare id (searched across
   *  models.json first, then built-in providers). */
  async resolveModel(ref: string): Promise<ResolveResult> {
    const refTrim = ref.trim();
    if (!refTrim) return { model: null, ambiguous: [] };
    const rt = await this.getRuntime();
    if (refTrim.includes("/")) {
      const slash = refTrim.indexOf("/");
      const provider = refTrim.slice(0, slash);
      const id = refTrim.slice(slash + 1);
      const m = rt.getModel(provider, id);
      if (m) return { model: { provider, id, model: m }, ambiguous: [] };
      return { model: null, ambiguous: [] };
    }
    const jsonMatches = (await this.listModels()).filter((m) => m.id === refTrim);
    const rtMatches = rt.getModels().filter((m) => m.id === refTrim).map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
    const seen = new Set<string>();
    const all: CompressionModelInfo[] = [];
    for (const m of [...jsonMatches, ...rtMatches]) {
      const key = `${m.provider}/${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(m);
    }
    if (all.length === 0) return { model: null, ambiguous: [] };
    if (all.length === 1) {
      const m = all[0]!;
      const model = rt.getModel(m.provider, m.id)!;
      return { model: { provider: m.provider, id: m.id, model }, ambiguous: [] };
    }
    return { model: null, ambiguous: all };
  }

  /** Generate a summary with the resolved model from a FULLY BUILT context
   *  (the caller controls systemPrompt/messages/tools — used for both the
   *  fresh single-message prompt and the shared-prefix prompt). Throws on API
   *  error or an empty response — the caller falls back to the main model. */
  async summarizeContext(resolved: ResolvedCompressionModel, context: Context, maxTokens: number): Promise<string> {
    const msg = await this.complete(resolved.model, context, { maxTokens });
    if (msg.stopReason === "error") throw new Error(msg.errorMessage ?? "compression model returned an error");
    const text = msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    const trimmed = text.trim();
    if (!trimmed) throw new Error("compression model returned an empty summary");
    return trimmed;
  }

  /** Generate a summary of `content` with the resolved model using a fresh
   *  single-message prompt (no session prefix reuse). */
  async summarize(resolved: ResolvedCompressionModel, content: string, systemPrompt: string, maxTokens: number): Promise<string> {
    const context: Context = {
      systemPrompt,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    };
    return this.summarizeContext(resolved, context, maxTokens);
  }
}

/** System prompt for the compression model: reuse the kernel's tier-1 rules so
 *  its output matches the quality/format the main model would produce. */
export function buildSummarizeSystemPrompt(prompts: { compressPhilosophy: string; howToCompressRules: string }, topic: string | undefined): string {
  const topicLine = topic ? `\nTopic for this range: ${topic}\n` : "";
  return (
    "You are a dedicated context-compression model. You receive a range of conversation " +
    "messages and must write the single summary that replaces them. Follow the rules exactly.\n" +
    `${topicLine}\n` +
    `${prompts.compressPhilosophy}\n\n` +
    `${prompts.howToCompressRules}\n\n` +
    "Output ONLY the summary text (no preamble, no code fences)."
  );
}

/** Truncate very large content, keeping the head (goal/early context) and tail
 *  (most recent state) with a marker in the middle. */
export function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = "\n\n[... truncated ...]\n\n";
  const budget = maxChars - marker.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
}
