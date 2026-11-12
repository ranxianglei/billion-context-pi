# REQ - Compression economics model + client comparison charts

- Task ID: `2026-09-15_compression-economics-model`
- Home Repo: `billion-context-pi`
- Created: 2026-09-15
- Status: Accepted
- Source: [#359](https://github.com/ranxianglei/billion-context-pi/issues/359) — owner
  request: re-derive compression economics; compare Codex / Claude Code / opencode / Pi
  compaction algorithms under one model (cache-invalidation timing, input/output/cache
  prices, fold position, frequency, context); produce a formula set; draw charts.

## Requirements

1. One parameterized cost model for context folding: price params (`w`, `r`, `q`, TTL),
   fold geometry (`V`, `S`, `h`/`f`, `σ=βS`), cadence (`k`, `g`), window cap (`L`).
   Must reproduce the #359 session's validated numbers (break-even ≈ a few turns ≪
   actual ~20-turn cadence → net-positive folding).
2. Mainstream-client comparison mapped onto the same variables, with assumptions stated.
3. Charts (PNG) illustrating: break-even vs fold size, fold position vs one-time cost,
   optimal fold size vs retention, client strategy costs.
4. Docs-only change: no code, no config default change (#359 is record-only per owner
   ruling — different models have different sweet spots).

## Non-goals

- Changing any default threshold or nudge behavior.
- Measuring real client internals (assumptions only, flagged as such).
