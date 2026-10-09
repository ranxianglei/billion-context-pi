import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Host compatibility layer for pi vs omp (oh-my-pi) API differences.
 *
 * pi: systemPrompt is string, getSystemPrompt() returns string
 * omp: systemPrompt is string[], getSystemPrompt() returns string[]
 *
 * These helpers normalize the differences so the rest of the codebase
 * can work with a consistent string interface.
 */

/** Normalize systemPrompt to a single string (join with newlines if array). */
export function normalizeSystemPrompt(input: string | string[] | undefined): string {
  if (input === undefined) return "";
  if (Array.isArray(input)) return input.join("\n");
  return input;
}

/**
 * Format systemPrompt for before_agent_start event handler.
 * Always returns string to satisfy pi's type definition, but handles
 * both string (pi) and string[] (omp) input types at runtime.
 */
export function formatSystemPromptForEvent(
  base: string | string[],
  append: string
): string {
  const normalized = normalizeSystemPrompt(base);
  return `${normalized}\n\n${append}`;
}

/**
 * Get the system prompt as a single string, regardless of host type.
 * Handles both pi (string) and omp (string[]) return types.
 */
export function getSystemPromptText(ctx: ExtensionContext): string {
  const result = ctx.getSystemPrompt?.();
  return normalizeSystemPrompt(result);
}

interface SystemPromptEventShape {
  systemPrompt: string | string[];
  systemPromptOptions?: { appendSystemPrompt?: string };
}

// pi 1.x re-renders event.systemPrompt from mutable options ("live"); pi 0.83
// serves a static snapshot string ("legacy"). Detect by probing whether an
// appended sentinel to the appendable option shows up in the rendered prompt.
// The restore is synchronous within the handler, so no other handler sees it.
export function appendOptionFeedsRenderedPrompt(
  event: SystemPromptEventShape,
): boolean {
  const opts = event.systemPromptOptions;
  if (!opts || typeof opts !== "object") return false;
  const prev = typeof opts.appendSystemPrompt === "string" ? opts.appendSystemPrompt : "";
  const sentinel = "\u0000acp-append-probe\u0000";
  try {
    opts.appendSystemPrompt = prev + sentinel;
    return normalizeSystemPrompt(event.systemPrompt).includes(sentinel);
  } finally {
    opts.appendSystemPrompt = prev;
  }
}

// On live hosts a returned systemPrompt becomes a force prompt that replaces
// the structured sections, silently dropping other extensions' appendSystemPrompt
// addendum depending on load order (#630) — so append into the option instead.
// On legacy hosts only a returned replacement reaches the model; return it there.
export function injectAcpSystemPrompt(
  event: SystemPromptEventShape,
  block: string,
): { systemPrompt: string } | undefined {
  const opts = event.systemPromptOptions;
  if (opts && typeof opts === "object" && appendOptionFeedsRenderedPrompt(event)) {
    const current = typeof opts.appendSystemPrompt === "string" ? opts.appendSystemPrompt : "";
    if (!current.includes(block)) {
      opts.appendSystemPrompt = current ? `${current}\n\n${block}` : block;
    }
    return undefined;
  }
  return { systemPrompt: formatSystemPromptForEvent(event.systemPrompt, block) };
}
