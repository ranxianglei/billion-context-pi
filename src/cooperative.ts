import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logInfo } from "./log.js";

// Cooperative proxy mode ("内外呼应", billion-context issue #1): when the
// model's baseUrl routes through a billion-context proxy (the `/bili/`
// zero-config prefix), the proxy owns compression end-to-end (state, folding,
// ref tags, philosophy prompt, nudges — it injects them at the wire level).
// This extension then becomes the "inside" half: it announces itself on every
// provider request (x-bili-plugin headers), skips its own in-process
// pipeline, and forwards the 4 native tools to the proxy's
// POST /__bili/plugin/tool. Protocol spec: billion-context PLUGIN.md.
// Without a `/bili/` baseUrl (or with ACP_COOPERATIVE_PROXY=0) behavior is
// byte-identical to the standalone extension.

export const PLUGIN_AGENT_NAME = "pi";

const BILI_SEGMENT = "bili";

export function proxyBaseFromUrl(baseUrl: string | undefined): string | undefined {
    if (!baseUrl) return undefined;
    try {
        const url = new URL(baseUrl);
        const segments = url.pathname.split("/").filter((s) => s.length > 0);
        if (!segments.includes(BILI_SEGMENT)) return undefined;
        return `${url.protocol}//${url.host}`;
    } catch {
        return undefined;
    }
}

export function proxyBaseForContext(ctx: ExtensionContext): string | undefined {
    if (process.env.ACP_COOPERATIVE_PROXY === "0") return undefined;
    return proxyBaseFromUrl(ctx.model?.baseUrl) ?? proxyBaseFromEnv();
}

/** MITM transparent-proxy mode has no `/bili/` prefix to detect (the baseUrl
 *  is the real provider URL). The proxy's own launcher (`bili pi`) exports
 *  BILLION_CONTEXT_PROXY alongside HTTPS_PROXY + the CA vars; trusting it
 *  requires no probe — a stale value surfaces as a tool-forward error. */
export function proxyBaseFromEnv(): string | undefined {
    const raw = process.env.BILLION_CONTEXT_PROXY?.trim();
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        return url.protocol === "http:" || url.protocol === "https:" ? `${url.protocol}//${url.host}` : undefined;
    } catch {
        return undefined;
    }
}

export async function forwardToolToProxy(proxyBase: string, conversationId: string, tool: string, args: unknown): Promise<string> {
    const resp = await fetch(`${proxyBase}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool, args }),
    });
    const text = await resp.text();
    let json: { ok?: boolean; result?: string; error?: string };
    try {
        json = JSON.parse(text) as { ok?: boolean; result?: string; error?: string };
    } catch {
        throw new Error(`bili proxy tool ${tool} failed (${resp.status}): ${text.slice(0, 200)}`);
    }
    if (!resp.ok || !json.ok) {
        throw new Error(`bili proxy tool ${tool} failed (${resp.status}): ${json.error ?? "unknown error"}`);
    }
    return json.result ?? "";
}

/** Forward a tool execution to the proxy when this session is in cooperative
 *  mode. Returns undefined when NOT behind a proxy (caller runs the local
 *  handler); returns the proxy's result text otherwise. */
export async function tryForwardTool(tool: string, params: unknown, ctx: ExtensionContext): Promise<string | undefined> {
    const proxyBase = proxyBaseForContext(ctx);
    if (proxyBase === undefined) return undefined;
    const conversationId = ctx.sessionManager.getSessionId();
    logInfo("cooperative", { event: "tool-forward", tool, conversationId, proxyBase });
    return forwardToolToProxy(proxyBase, conversationId, tool, params);
}
