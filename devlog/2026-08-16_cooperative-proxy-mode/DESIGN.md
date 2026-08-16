# DESIGN - Cooperative proxy mode

- Task ID: `2026-08-16_cooperative-proxy-mode`
- Home Repo: `billion-context-pi`
- Created: 2026-08-16
- Status: Accepted

## 1. Goals & Non-Goals

- **Goals**: proxy-owns-compression when behind the proxy; native tools forwarded; real session identity; zero change when standalone.
- **Non-Goals**: MITM detection; config keys; changes to delegate tools (they keep working — their prompt is injected locally even in cooperative mode).

## 2. Mechanism

Detection is **stateless and per-call**: `proxyBaseForContext(ctx)` reads `ctx.model.baseUrl` (typed on pi-ai's `Model`) and matches a `bili` path segment (`http://host[:port]/bili/...` → `http://host[:port]`). No cached mode flag → model switches mid-session are picked up on the very next call. `ACP_COOPERATIVE_PROXY=0` short-circuits detection off.

Four integration points:

1. **`before_provider_headers`** (pi SDK hook, types.d.ts:869 — headers mutate-in-place): sets `x-bili-plugin: pi` + `x-bili-plugin-conversation: ctx.sessionManager.getSessionId()`. No-op unless proxied.
2. **`context` event**: early return `{ messages: event.messages }` (identity) — the proxy runs processTurn (tags/folding/nudges) at the wire level; running it locally too would double-transform.
3. **`before_agent_start`**: skip `buildAcpSystemPrompt` (the proxy injects the philosophy); keep `ACP_DELEGATE_PROMPT` (pi-side feature) when delegate enabled; return `undefined` otherwise.
4. **Tool `execute` (×4)**: `tryForwardTool(name, params, ctx)` → POST `${proxyBase}/__bili/plugin/tool` `{conversationId, tool, args}` → return `result` as the native tool-result text. `undefined` return = not proxied → local handler runs unchanged. Proxy errors throw (consistent with local handlers, which re-throw after logThrow).

`session_before_compact` cancel stays unconditional: pi's compaction must never run — the proxy manages context in cooperative mode too.

## 3. Alternatives considered

- **Cached mode flag set on `session_start`/`model_select`**: rejected — stale on mid-session model switches; per-call read is O(len(url)) and always fresh.
- **Fetch patching for headers**: rejected — pi-ai owns the HTTP stack; the SDK provides the exact hook (`before_provider_headers`).
- **Forwarding inside the `handleX` functions**: rejected — the forward must bypass local state entirely (the proxy executes against ITS remembered view); putting it at the top of `execute` makes that structural.
- **Keeping local compression when proxied**: rejected — double compression; exactly what the protocol exists to prevent.
