# billion-context-pi — Auto-Merge Guardrails & Review Discipline

> Evidence base for §7 of this repo's `AGENTS.md`. Derived from a full-history audit of this
> repo plus its siblings (`billion-context`, `acp-kernel`), filed under
> [billion-context#801](https://github.com/ranxianglei/billion-context/issues/801).
> Goal: let the safe majority of bugfixes merge without a human round-trip while keeping the
> load-bearing surfaces human-gated so the big-picture direction does not drift.
> Cross-repo changes stay manual/human.

## 1. Baseline facts (measured from this repo's history)

- 447 tracked items (317 PR / 130 issues); **241 merged, 0 closed-unmerged, 30 open**; only
  23 carry the `ework-agent-pr` marker. Most AI work predates the marker or lands under the
  owner PAT, so authorship cannot separate AI from human — classify by the `[bot] 🏷` comment
  prefix + PR marker instead.
- **Second-round ("重灾区") rate: of 33 merged PRs that drew human review, 14 (≈42%) needed
  ≥2 human review touches before merge** — the highest of the three repos (billion-context
  ≈27%, acp-kernel ≈25%). "≥2 human touches" is an approximation of "needed a second review
  round." This adapter is the most host-coupled and therefore the least auto-merge-friendly;
  its gate must be the tightest.
- Commit mix is feat/fix-heavy (adapter surface work), not pure fixes — expect features to
  keep flowing through the same hot files.

## 2. Rules humans actually enforce

### 2.A Already codified in AGENTS.md
§4 Git Safety + PR-merge prohibition (defers to acp-kernel), §5 Release Workflow incl. strict
cross-repo ordering (**acp-kernel MUST ship first**) + the two-field release commit (own
version *and* the `acp-kernel` dep), Key Design Decision #6 (exact-version pin on
`acp-kernel`), and the code-quality rules (no `as any` / `@ts-ignore`, hex-escaped tags).

### 2.B Implicit rules observed in review threads
- **Prefix-cache stability is a correctness property, not a perf nicety.**
  - [#343](https://github.com/ranxianglei/billion-context-pi/issues/343) compression
    invalidated the prefix cache → first-turn hit rate dropped to 20–30%.
  - [#333](https://github.com/ranxianglei/billion-context-pi/issues/333) frequent compression
    kept dropping the cache.
  - [#171](https://github.com/ranxianglei/billion-context-pi/issues/171) density-calibration ×
    missing snapshot caused tag recomputation → 61k tokens re-billed.
  ⇒ A change to ref-tag rendering / token snapshots / `countTokens` calibration must be
    verified by **cache hit-rate**, not just "the output looks correct."
- **Anchor nudge pressure to provider-real usage, not token estimates**
  ([#227](https://github.com/ranxianglei/billion-context-pi/issues/227) `decideNudge` pressure
  should anchor to the provider's real usage).
- **Host-boundary refusals are load-bearing and multi-path.** OMP refusal, proxy stand-down
  (`BILLION_CONTEXT_PROXY` + `/bili/` baseUrl detection), and thin-plugin `/acp` shadowing.
  A change to host/session detection must verify **every** host path (pi / omp / proxy /
  thin-plugin), because a fix in one path silently regresses another.
- **Session sidecar format + log-replay rebuild are persistence contracts.** The `.acp.json`
  sidecar layout and the log-replay rebuild ([#299](https://github.com/ranxianglei/billion-context-pi/issues/299))
  restore already-saved sessions; changing either breaks them. Replay must keep skipping
  errored / no-op / unparseable compress calls.
- Cross-repo process rules identical to the siblings: dedupe-first, one-issue-one-scope,
  PR-not-bare-branch, evidence-before-done, deterministic tests.

## 3. What AI cannot reliably self-judge (blind spots)

### 3.1 Repo-specific load-bearing surfaces (stay human-gated)
- `src/messages.ts` ref-tag patching + `src/tokens.ts` `countTokens` calibration → prefix-cache impact.
- Host-detection / stand-down logic in the session-start path (OMP, proxy, thin-plugin).
- `src/state.ts` sidecar persistence format + `rebuild` log-replay semantics.
- `src/update.ts` auto-update (needs a no-op release first, per the sibling convention).
- The exact `acp-kernel` pin (cross-repo ordering).
- Identity / session binding (prefer native stable session ids over derived hashes).

### 3.2 Where the 42% second-round rate comes from
1. **Stale-base / concurrent-file churn** on the hot files (`src/messages.ts`,
   `src/runtime.ts`, `src/index.ts` event wiring).
2. **Incomplete first pass** — the reported repro passes, but an adjacent host path or the
   prefix-cache regression is missed. The classic miss in this repo: *"works in a fresh Pi
   session, but breaks the prefix cache or a non-Pi host."*

## 4. Auto-merge gate

A bugfix may **auto-merge** ONLY if ALL hold:
1. Single-module scoped; no architectural change.
2. A regression test reproduces the original bug and now passes.
3. Green **on the rebased head** (typecheck + full test + build).
4. Touches **NO** §3.1 load-bearing surface (tag rendering / token calibration, host
   detection / stand-down, sidecar format / replay, `update.ts`, the `acp-kernel` pin,
   identity binding).
5. Pure `fix:` — no new capability surface.
6. Clean diff (no unrelated / whitespace / lock churn).
7. References its issue via `Fixes #N`.

**Must stay human:** anything in rule 4, wire/message-shape changes, config schema,
persistence format/version, cross-repo dependencies, `src/update.ts` (needs a no-op release
first), identity/session-binding logic, feat/refactor/architecture, security, or any
fallback/default-value change (a product decision).

## 5. Reviewer checklist (walk in order)
1. Is the base current master? Rebase + re-run typecheck/test/build if stale.
2. Is a touched file also being rewritten by another open PR? (semantic-conflict risk)
3. Does the diff touch a §3.1 surface? If yes → **human gate, stop.**
4. Does the fix cover **all** host paths (pi / omp / proxy / thin-plugin), not just the repro?
5. For tag/token changes: is there **cache-hit-rate** evidence, not just correctness?
6. Regression test present + deterministic (no port/env luck)?
7. Diff clean — every line on-purpose?

## Appendix
- **Sibling ownership split:** `acp-kernel` owns the kernel-side contracts (message-id/ref
  immutability, wire-artifact format, lossless round-trip, tool-pair atomicity); this repo
  consumes them faithfully. `billion-context` is the proxy host. See their `AGENTS.md §7`.
- **Owner decision (#801):** rules merged into `AGENTS.md §7`; cross-repo stays manual for now.
