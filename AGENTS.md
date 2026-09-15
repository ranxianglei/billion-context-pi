# billion-context-pi Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**billion-context-pi** is the [Pi coding agent](https://github.com/nickthecook/pi) adapter for ACP (Active Context Pruning). It wires acp-kernel's compression pipeline into Pi's extension system, providing model-driven context management.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling, inlines acp-kernel) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Dep | `acp-kernel` (bundled at build time, zero runtime deps in dist) |
| Host | Pi `@earendil-works/pi-coding-agent` >=0.83 |

### Repository Info

| Field | Value |
|-------|-------|
| npm package | `billion-context-pi` |
| GitHub | https://github.com/ranxianglei/billion-context-pi |
| License | MIT |

## 2. Architecture

### Module Map

```
pi-acp/
├── src/
│   ├── index.ts              # Extension entry: wire hooks, tools, commands
│   ├── config.ts             # AdapterConfig: wraps kernel defaultConfig
│   ├── runtime.ts            # AcpRuntime: state store, lock, stateFor()
│   ├── state.ts              # State persistence (~/.pi/agent/sessions/*.acp.json)
│   ├── messages.ts           # Pi ↔ kernel message conversion + ref tag patching
│   ├── compress-tool.ts      # compress tool handler
│   ├── decompress-tool.ts    # decompress tool handler
│   ├── search-tool.ts        # search_context tool (delegates to kernel.searchBlocks)
│   ├── search-index.ts       # Builds SearchDoc[] from session log + ACP blocks
│   ├── status-tool.ts        # acp_status tool (delegates to kernel.buildStatusReport)
│   ├── commands.ts           # /acp slash command
│   ├── system-prompt.ts      # System prompt with compression philosophy
│   ├── update.ts             # Auto-update: checks npm, auto-installs latest
│   ├── tokens.ts             # Token estimation utilities
│   └── log.ts                # Debug logging
├── tests/                    # 45 tests
├── tsup.config.ts
└── package.json
```

### Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained (zero runtime deps)
2. **Tags use XML format** `<acp tokens="2" type="text">m00001</acp>` — written with hex escapes (`\x3c`, `\x3e`) to avoid Write/Edit tool stripping
3. **Assistant messages skip tag injection** — prevents model echo of XML tags
4. **Tags appended to END of text** — matches opencode-acp pattern
5. **Auto-update on session_start** — checks npm registry (6h throttle), auto-installs if newer
6. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.14"`, NEVER `"^0.0.14"`). Because acp-kernel is a build-time dependency that tsup bundles inline into `dist`, a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds. When bumping acp-kernel: set the exact version in `package.json`, run `npm install` to refresh the lockfile, then rebuild. The `package-lock.json` is committed and kept in sync.

## 3. Development Standards

### Build Commands

```bash
npm run build          # tsup bundle (inlines acp-kernel)
npm run typecheck      # TypeScript type checking
npm test               # node --import tsx --test tests/*.test.ts
```

### Local Testing

```bash
npm run build
cp dist/index.js ~/.pi/agent/npm/node_modules/billion-context-pi/dist/index.js
# Restart Pi to pick up changes
```

### Code Quality

- **No `as any`**, **No `@ts-ignore`**
- **No comments unless absolutely necessary**
- Hex escapes required for any `<acp>` XML in source files

## 4. Git Safety Rules

Same as acp-kernel. See [acp-kernel AGENTS.md §4](https://github.com/ranxianglei/acp-kernel/blob/master/AGENTS.md).

### PR Merge — Absolute Prohibition

PR merges are **human-only**. The Agent MUST NEVER merge any PR.

### Problem Discovery & Fix Reporting (MANDATORY)

Problems discovered or fixed while working MUST leave a trace in the issue tracker — never fixed silently and moved on.

1. **Discovered a problem** (bug, defect, wrong behavior, spec violation) — whether while working on this project or any sibling project — file an issue in the project the problem belongs to: repro/steps, impact, root cause (if known), suggested fix.
2. **Fixed a problem** — after the fix, submit an issue to the owning project recording the problem and how it was fixed. For problems in this project: https://github.com/ranxianglei/billion-context-pi/issues . If the fix ships as a PR, the PR MUST reference its issue (`Fixes #N`); a bare PR without an issue is not acceptable — file the issue first, then link it. An existing PR for the fix counts, but it should carry an accompanying issue.

## 5. Release Workflow

Same baseline as acp-kernel (branch naming, CI auto-publish, PR-merge-is-human-only, pre-flight checks, release-commit convention). See [acp-kernel AGENTS.md §5](https://github.com/ranxianglei/acp-kernel/blob/master/AGENTS.md). Release branches: `YYYY-MM-DD_release-v{VERSION}`.

### Cross-repo dependency: acp-kernel MUST ship first

`acp-kernel` is pinned in **devDependencies** (exact version, no `^`) and **bundled inline** at build time (tsup does NOT mark it `external`), so `dist/index.js` is self-contained.

⚠️ **Publishing order is strict:**
1. Release `acp-kernel` first (open + merge its release PR, wait for CI publish).
2. **Verify it is live on npm:** `npm view acp-kernel version` returns the new version.
3. THEN release billion-context-pi.

Rationale: billion-context-pi CI runs `npm ci`, which installs the exact `acp-kernel` version pinned in `package.json`. A release branch that bumps `acp-kernel` to a not-yet-published version fails CI at install time.

### Local pre-validation (saves a round-trip)

Before waiting for npm, validate the upgrade path locally using acp-kernel's own master build (skip if acp-kernel is already published):

```bash
# 1. In acp-kernel (on master):
npm run build

# 2. In billion-context-pi: overlay the new dist onto node_modules (local only, do NOT commit)
cp ~/projects/acp-kernel/dist/index.js     node_modules/acp-kernel/dist/index.js
cp ~/projects/acp-kernel/dist/index.js.map node_modules/acp-kernel/dist/index.js.map

# 3. Bump package.json (both lines, see below), then run billion-context-pi CI checks
npm run typecheck && npm test && npm run build
```

### billion-context-pi release commit — TWO version fields

Unlike acp-kernel (one line), a billion-context-pi release commit bumps BOTH its own version AND the `acp-kernel` dependency:

```diff
   "name": "billion-context-pi",
-  "version": "0.1.12",
+  "version": "0.1.13",
   ...
-  "acp-kernel": "0.0.14",
+  "acp-kernel": "0.0.15",
```

After editing, refresh the lockfile and commit it together:
```bash
npm install                              # updates package-lock.json
npm run typecheck && npm test && npm run build
```
Commit message: `release v{VERSION}` (same convention as acp-kernel). The commit touches `package.json` + `package-lock.json` (2 files).

## 6. npm Publishing

```bash
npm run build
npm test
npm publish
```

CI auto-publishes on release branch merge. Manual publish only as fallback.

## 7. Review & Auto-Merge Discipline

> Distilled from a full-history audit of this repo + siblings ([billion-context#801](https://github.com/ranxianglei/billion-context/issues/801)). Full cited material: [AUTO-MERGE-GUARDRAILS.md](./AUTO-MERGE-GUARDRAILS.md). Measured: of merged PRs that drew human review, ≈42% needed a 2nd+ round — the highest of the three repos, because this adapter is the most host-coupled. Gate accordingly.

### 7.1 Before you start
- **Duplicate screening first.** Search open AND closed issues/PRs for the same fix before implementing; link existing work, don't start parallel work.
- **One issue = one scope.** Split extra findings into separate issues/PRs; never bundle unrelated changes or mass whitespace/reformatting.
- **Open a PR, never just push a branch.** A bare branch is not a deliverable.

### 7.2 Review discipline
- **Rebase to CURRENT master before claiming mergeable**; after rebase re-run typecheck + full test + build. A stale base is the top cause of second-round rework.
- **Watch hot-file contention** (`src/messages.ts`, `src/runtime.ts`, `src/index.ts` event wiring): if another open PR rewrites the same region, resolve by union of intent, then prove it with tests.
- **Cover ALL host paths, not just the repro.** This repo runs under Pi, refuses OMP, stands down behind the proxy, and coexists with the thin plugin. A host/session-detection change must verify every path — a fix in one silently regresses another.
- **Done = evidence.** Actually run the changed behavior. For tag/token changes assert CACHE HIT RATE, not just correctness.
- **Deterministic tests** — no port/env luck.

### 7.3 Correctness guardrails
- **Prefix-cache stability is a correctness property.** Ref-tag rendering, token snapshots, and `countTokens` density calibration must not invalidate the prefix cache (#343 first-turn hit rate fell to 20–30%; #171 recomputation re-billed 61k tokens). Verify hit-rate regressions explicitly.
- **Anchor nudge pressure to provider-real usage**, not estimates (#227).
- **Never silently clobber user config**; reject malformed input loudly rather than merging into defaults or dropping fields.
- **Prefer native stable session ids** over derived hashes that drift on switch.
- **Symptom ≠ mechanism** — check upstream/host logs before attributing a bug to this plugin.
- **Honest output** for degenerate states; **mask secrets in logs**.
- **Docs** kept zh/en in sync and placed where the actual reader sees them.

### 7.4 Auto-merge gate (this repo only)
A bugfix may **auto-merge** only if ALL hold:
1. Single-module scoped; no architectural change.
2. A regression test reproduces the original bug and now passes.
3. Green on the rebased head (typecheck + full test + build).
4. Touches NO load-bearing surface: ref-tag rendering / token calibration, host detection / stand-down, `.acp.json` sidecar format or log-replay rebuild, `src/update.ts`, the `acp-kernel` pin, identity/session binding.
5. Pure `fix:` — no new capability surface.
6. Clean diff: no unrelated changes, no mass whitespace/reformat, no generated/lock churn.
7. References its issue via `Fixes #N`.

**Must stay human:** any item in rule 4, wire/message-shape changes, config schema, persistence format/version, cross-repo dependencies, `src/update.ts` (needs a no-op release first), identity/session-binding logic, feat/refactor/architecture, security, or any fallback/default-value change (a product decision).

> **Scope note:** auto-merge applies to THIS repo only. Cross-repo changes (acp-kernel bumps, anything spanning repos) remain manual/human.

### 7.5 Reviewer focus — the "重灾区"
Of merged PRs that drew review, ≈42% needed a 2nd+ round. Two drivers dominate, and they are exactly where auto-merge is unsafe:
1. **Stale-base / concurrent-file churn** on the hot files above.
2. **Incomplete first pass** — the repro passes but an adjacent host path or the prefix-cache regression is missed.
A reviewer walks 7.1 → 7.5 in order.
