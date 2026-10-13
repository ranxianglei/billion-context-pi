import type { ExtensionAPI, ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";

type AgentMessage = SessionMessageEntry["message"];

/** Cross-extension context view, protocol v1.
 *
 *  A consumer (the advisor extension) needs the *compressed* conversation —
 *  the projection this adapter hands the host — instead of rebuilding Pi's raw
 *  session history, which is uncompressed and overflows the consumer's own
 *  window. It emits a ContextViewRequest here and receives, synchronously
 *  claimed, a projection built for its own session.
 *
 *  Built fresh, not captured. The consumer runs in the middle of a turn: the
 *  assistant message carrying its own call is already persisted, and a sibling
 *  tool result may have completed before it. A projection recorded during the
 *  previous LLM request would predate all of that and hand the consumer a stale
 *  view — the exact evidence it is being asked to review. So the provider
 *  re-runs the adapter's own pipeline (stateFor → processTurn →
 *  coreOutToAgentMessages) against the branch as it stands now.
 *
 *  Read-only and isolated: the compression state is deep-copied before the
 *  kernel runs, and the result is never saved, counted against the session, or
 *  allowed to inject a nudge or fire an update check. `stateFor`'s own
 *  normalizations (sidecar rebuild, orphan-ref pruning) are shared verbatim
 *  with the existing read-only tools (`acp_status`, `search_context`, ...), so
 *  asking for a view does nothing those already do.
 *
 *  Failures are not swallowed: a builder that throws rejects the claim, so the
 *  consumer sees a broken hand-off rather than silently reverting to the
 *  uncompressed history this module exists to avoid. `inactive` is reserved for
 *  answers that are legitimately not a view. */
export const CONTEXT_VIEW_CHANNEL = "billion-context-pi:context-view:v1";
export const CONTEXT_VIEW_PROVIDER = "billion-context-pi";

export type ContextViewResult =
  | {
      status: "available";
      provider: typeof CONTEXT_VIEW_PROVIDER;
      sessionId: string;
      builtAt: number;
      messages: AgentMessage[];
    }
  | { status: "inactive"; provider: typeof CONTEXT_VIEW_PROVIDER; reason: string };

/** Request shape. `claim` must be called synchronously by the provider (event
 *  bus handlers run synchronously before `emit` returns), which is how the
 *  consumer distinguishes "no provider installed" from "provider answered". */
export interface ContextViewRequest {
  version: 1;
  sessionId: string;
  ctx: ExtensionContext;
  claim: (result: Promise<ContextViewResult>) => void;
}

/** Builds this adapter's projection for `ctx`'s session from its current
 *  branch. Supplied by the caller so this module stays free of the pipeline. */
export type ContextViewBuilder = (ctx: ExtensionContext) => Promise<AgentMessage[]>;

export function wireContextView(
  pi: ExtensionAPI,
  runtime: AcpRuntime,
  standDownIfProxied: (ctx: ExtensionContext) => boolean,
  buildView: ContextViewBuilder,
): void {
  // Capability probe, like `pi.sendMessage` in commands.ts: the event bus is a
  // newer extension surface, so a host (or test double) without one gets no
  // provider instead of failing extension load.
  const events = pi?.events;
  if (typeof events?.on !== "function") return;
  events.on(CONTEXT_VIEW_CHANNEL, (data) => {
    const req = asContextViewRequest(data);
    if (!req) return;
    req.claim(viewFor(runtime, standDownIfProxied, buildView, req));
  });
}

function asContextViewRequest(data: unknown): ContextViewRequest | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const req = data as Partial<ContextViewRequest>;
  if (req.version !== 1) return undefined;
  if (typeof req.sessionId !== "string" || typeof req.claim !== "function") return undefined;
  if (typeof req.ctx !== "object" || req.ctx === null) return undefined;
  return req as ContextViewRequest;
}

async function viewFor(
  runtime: AcpRuntime,
  standDownIfProxied: (ctx: ExtensionContext) => boolean,
  buildView: ContextViewBuilder,
  req: ContextViewRequest,
): Promise<ContextViewResult> {
  const inactive = (reason: string): ContextViewResult => ({
    status: "inactive",
    provider: CONTEXT_VIEW_PROVIDER,
    reason,
  });
  if (runtime.refused) return inactive("refused");
  if (standDownIfProxied(req.ctx)) return inactive("stood-down");
  if (req.ctx.sessionManager.getSessionId() !== req.sessionId) return inactive("session-mismatch");
  // The builder awaits I/O, so the branch can move under it. Growth is not a
  // problem: the caller asked for the branch as it stood when it asked, and its
  // own entry is still on that path. A rewind or fork landing in the window is:
  // the projection would describe a branch the caller is no longer on. Comparing
  // leaf ids for equality would call the ordinary case — a sibling tool result
  // landing mid-build — a branch move and refuse a view the caller needs.
  const sessionManager = req.ctx.sessionManager;
  const leafBefore = sessionManager.getLeafId?.();
  const messages = await buildView(req.ctx);
  const branch = sessionManager.getBranch?.();
  if (branch && leafBefore && !branch.some((entry) => entry.id === leafBefore)) {
    return inactive("branch-moved");
  }
  if (messages.length === 0) return inactive("empty");
  return {
    status: "available",
    provider: CONTEXT_VIEW_PROVIDER,
    sessionId: req.sessionId,
    builtAt: Date.now(),
    // Independent data, not a shallow copy: `coreOutToAgentMessages` hands back
    // the session's own message objects for anything it did not have to patch,
    // so a consumer mutating its answer in place would edit the session log.
    messages: structuredClone(messages),
  };
}
