import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDelegateUsage } from "./delegate-tool.js";

const FOOTER_STATUS_KEY = "billion-context-pi";
let ui: ExtensionContext["ui"] | undefined;
let lastFooterText: string | undefined = "";

/** Mirrors pi's footer.js formatTokens: lowercase k/M, thresholds <1000/<10000/<1e6/<1e7. */
export function formatCompactTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function initFooterStatus(ctx: ExtensionContext): void {
  ui = ctx.ui;
  lastFooterText = undefined;
}

/** Refresh the footer delegate-usage line. Cheap: reads the accumulated total
 *  and no-ops when the rendered text is unchanged (called on a 500ms tick). */
export function updateFooterStatus(): void {
  if (!ui) return;
  const usage = getDelegateUsage();
  let text: string | undefined;
  if (usage && usage.totalTokens > 0) {
    const costStr = usage.cost.total > 0 ? ` ($${usage.cost.total.toFixed(4)})` : "";
    text = `sub-agents \u2191${formatCompactTokens(usage.input)} \u2193${formatCompactTokens(usage.output)}${costStr}`;
  }
  if ((text ?? "") === lastFooterText) return;
  lastFooterText = text ?? "";
  try {
    ui.setStatus(FOOTER_STATUS_KEY, text);
  } catch {
    // session is tearing down — best effort
  }
}

export function disposeFooterStatus(): void {
  if (ui) {
    try {
      ui.setStatus(FOOTER_STATUS_KEY, undefined);
    } catch {
      // best effort
    }
  }
  ui = undefined;
  lastFooterText = "";
}
