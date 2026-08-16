# REQ - Cooperative proxy mode (内外呼应)

- Task ID: `2026-08-16_cooperative-proxy-mode`
- Home Repo: `billion-context-pi`
- Created: 2026-08-16
- Status: Done
- Priority: P1
- Owner: awork
- References: dog/billion-context#1, ranxianglei/billion-context#161 (protocol half), PLUGIN.md spec in billion-context

## 1. Background & Problem Statement

- **Context**: billion-context issue #1 asks for inside/outside cooperation: keep the external proxy but install a plugin inside the agent so the combination feels native. The proxy-side protocol (`/__bili/plugin/manifest`, `/__bili/plugin/tool`, `x-bili-plugin` headers) landed in billion-context PR #161. This repo is the fully in-process implementation — the natural first "inside" adopter.
- **Current behavior (symptom)**: the extension is either/or: it runs its own in-process pipeline, and the only proxy-related behavior is mutual exclusion by convention (users must disable one side manually).
- **Expected behavior**: when the model baseUrl routes through the proxy (`/bili/` prefix), the extension keeps its 4 native tools but forwards execution to the proxy, skips its own in-process pipeline, and announces pi's real session identity. Without a proxy, byte-identical standalone behavior.
- **Impact**: native tool UX + real session identity + zero schema drift (proxy serves schemas), with the proxy as single compression authority.

## 2. Reproduction

N/A (feature).

## 3. Constraints & Non-Goals

- **Constraints**: no behavior change without a `/bili/` baseUrl; no `as any`; no comments unless necessary; pi SDK hooks only (no fetch patching).
- **Non-Goals**: changing the delegate subsystem (kept working in cooperative mode via its own prompt); MITM-mode proxy detection (no `/bili/` prefix to detect — out of scope for v1); a config-file key for cooperative mode (env kill-switch suffices for v1).
