# WORKLOG - Cooperative proxy mode

- Task ID: `2026-08-16_cooperative-proxy-mode`
- Home Repo: `billion-context-pi`
- Status: Done
- Updated: 2026-08-16 02:55

## 1. Summary

- **What was done**: Added cooperative proxy mode ("有外用外"): when the model baseUrl routes through a billion-context proxy (`/bili/` prefix), the extension forwards its 4 native tools to the proxy's tool endpoint, announces pi's session identity via `x-bili-plugin*` headers, and skips its own in-process pipeline. Standalone behavior unchanged.
- **Why**: billion-context issue #1 (内外呼应) — native tool UX + real session identity with the proxy as single compression authority. First adopter of the plugin protocol shipped in ranxianglei/billion-context#161.
- **Behavior / compatibility changes**: Yes, additive. Without `/bili/` in the model baseUrl (or with `ACP_COOPERATIVE_PROXY=0`) every path is byte-identical to before.
- **Risk level**: Low (detection is a pure URL check per call; all gated branches early-return).

## 2. Change Log

### Key Files

- `src/cooperative.ts` (new) — `proxyBaseFromUrl` / `proxyBaseForContext` (stateless per-call detection), `forwardToolToProxy` (POST `/__bili/plugin/tool`, error surfaces), `tryForwardTool` (undefined = run local handler).
- `src/index.ts` — `wireProviderHeaders` (`before_provider_headers` hook); cooperative early-return in `wireContextTransform` (identity messages) and `wireSystemPrompt` (philosophy from proxy, delegate prompt kept).
- `src/compress-tool.ts` / `src/decompress-tool.ts` / `src/search-tool.ts` / `src/status-tool.ts` — `tryForwardTool` branch at top of `execute`.
- `tests/cooperative.test.ts` (new, 7 tests) — URL detection matrix; header injection (+absence without proxy); context identity passthrough; system-prompt ownership; live HTTP forward (conversation id, tool name, args passthrough, result text); proxy error propagation; `ACP_COOPERATIVE_PROXY=0` kill switch (local pipeline runs).
- `README.md` — "Cooperative proxy mode (内外呼应)" section.
- `CONFIGURATION.md` — `ACP_COOPERATIVE_PROXY` env var (summary table + full section).

## 3. Verification

- `npm run typecheck` clean.
- `npm test`: 300 tests, 299 pass + 1 **pre-existing failure on pristine master** (`e2e-compress-config.test.ts`: "a 2w limit fires the compress nudge at 2w tokens" — verified failing on clean master checkout before my changes; unrelated to this feature).
- `npm run build` OK (dist 477 KB).
- New suite: 7/7.

## 4. Notes / Follow-ups

- ~~MITM-mode (transparent proxy, no `/bili/` prefix) is NOT detected~~ — **landed in this PR (follow-up commit)**: the billion-context launcher now exports `BILLION_CONTEXT_PROXY` next to `HTTPS_PROXY` for `bili pi`/`codex`/`claude`; `proxyBaseForContext` falls back to it (trusted without probing — a stale value surfaces as a tool-forward error). MITM cooperative mode works end-to-end.
- `x-bili-plugin-context-window` (new): `before_provider_headers` reports `ctx.model.contextWindow` from inside pi; the proxy treats it as the authoritative native window (outranks its table/registry; operator `compress.modelContextLimit` still wins).
- `GET /__bili/plugin/status?conversationId=` (new proxy endpoint): context-level visibility (contextTokens = input+cache-read, contextLimit, blocks, requests) for plugin status UIs.
- Fixed a usage-application race in the proxy's plugin stream passthrough: usage is applied BEFORE `res.end()` so the client's next request (status fetch / follow-up turn reading `lastInputTokens` for nudges) always sees it.
- `before_provider_headers` exists in the pi SDK as of this version; if an older pi host lacks it, registration is ignored harmlessly (extension `on` overloads).
- Cross-repo dependency: the proxy half must merge first (ranxianglei/billion-context#161) — the endpoints this forwards to only exist there. No code-level version coupling (protocol is HTTP + manifest).
