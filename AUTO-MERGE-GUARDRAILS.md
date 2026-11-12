# billion-context-pi — Auto-Merge Guardrails & Review Discipline

> Evidence base for §7 of this repo's `AGENTS.md`. Derived from a full-history audit of this
> repo plus its siblings (`billion-context`, `acp-kernel`), filed under
> [billion-context#801](https://github.com/ranxianglei/billion-context/issues/801).
> **Positioning:** the authoritative rule / auto-merge-gate / reviewer-checklist text lives in
> [`AGENTS.md` §7](./AGENTS.md#7-review--auto-merge-discipline) (loaded every session — the single
> source of truth). This file is **evidence-only**: measured baseline + per-rule issue citations +
> blind-spot analysis. Rules/gate/checklist are NOT restated here, to avoid drift.
> Cross-repo changes stay manual/human.

## 1. Baseline facts (measured from this repo's history)

- 447 tracked items (317 PR / 130 issues); **241 merged, 0 closed-unmerged, 30 open**; only
  23 carry the `ework-agent-pr` marker. Most AI work predates the marker or lands under the
  owner PAT, so authorship cannot separate AI from human — classify by the `[bot] 🏷` comment
  prefix + PR marker instead.
- **Second-round ("重灾区") rate: of 33 merged PRs that drew human review, 14 (≈42%) needed
  ≥2 human review touches before merge** — the highest of the three repos (billion-context
  ≈27%, acp-kernel ≈25%). "≥2 human touches" approximates "needed a second review round." This
  adapter is the most host-coupled and therefore the least auto-merge-friendly; its gate must be
  the tightest.
- Commit mix is feat/fix-heavy (adapter surface work), not pure fixes — expect features to keep
  flowing through the same hot files.

## 2. Rules humans actually enforce (evidence)

> Rule text lives in `AGENTS.md` §7.1–§7.3; below is *why* each exists.

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
- **Anchor nudge pressure to provider-real usage, not token estimates**
  ([#227](https://github.com/ranxianglei/billion-context-pi/issues/227)).
- **Host-boundary refusals are load-bearing and multi-path.** OMP refusal, proxy stand-down
  (`BILLION_CONTEXT_PROXY` + `/bili/` baseUrl detection), and thin-plugin `/acp` shadowing — a
  change to one path silently regresses another.
- **Session sidecar format + log-replay rebuild are persistence contracts** — the `.acp.json`
  layout and log-replay rebuild ([#299](https://github.com/ranxianglei/billion-context-pi/issues/299))
  restore already-saved sessions; changing either breaks them. Replay must keep skipping errored /
  no-op / unparseable compress calls.

## 3. What AI cannot reliably self-judge (blind spots)

### 3.1 Repo-specific load-bearing surfaces (stay human-gated; enforced by `AGENTS.md` §7.4)
- `src/messages.ts` ref-tag patching + `src/tokens.ts` `countTokens` calibration — the
  prefix-cache incidents above show tag/token changes silently invalidate the cache.
- Host-detection / stand-down logic in the session-start path — easy to fix one host and regress
  another (Pi / OMP / proxy / thin-plugin).
- `src/state.ts` sidecar persistence format + `rebuild` log-replay semantics — breaks existing
  sessions.
- `src/update.ts` auto-update (needs a no-op release first, per the sibling convention).
- The exact `acp-kernel` pin (cross-repo ordering) and identity/session binding (prefer native
  stable ids over derived hashes).

### 3.2 Where the 42% second-round rate comes from
1. **Stale-base / concurrent-file churn** on the hot files (`src/messages.ts`,
   `src/runtime.ts`, `src/index.ts` event wiring).
2. **Incomplete first pass** — the reported repro passes, but an adjacent host path or the
   prefix-cache regression is missed. The classic miss: *"works in a fresh Pi session, but breaks
   the prefix cache or a non-Pi host."*

## Appendix
- **Gate + must-stay-human list + reviewer checklist:** see `AGENTS.md` §7.4 / §7.5 (single
  source of truth). If later promoted to a CI hard gate, §7.4 is the reference.
- **Sibling ownership split:** `acp-kernel` owns the kernel-side contracts (message-id/ref
  immutability, wire-artifact format, lossless round-trip, tool-pair atomicity); this repo
  consumes them faithfully. `billion-context` is the proxy host. See their `AGENTS.md §7`.
- **Owner decision (#801):** rules merged into `AGENTS.md §7`; cross-repo stays manual for now.
