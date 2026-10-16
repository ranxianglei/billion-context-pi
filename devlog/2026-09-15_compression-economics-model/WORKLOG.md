# WORKLOG - Compression economics model + client comparison charts

- Task ID: `2026-09-15_compression-economics-model`
- Home Repo: `billion-context-pi`
- Branch: `2026-09-15_compression-economics-model` (base `origin/master`)
- Related: [#359](https://github.com/ranxianglei/billion-context-pi/issues/359)

## Steps

1. Derived the cost model from first principles and cross-checked against the #359
   corrected economics (re-pay = `(1−h)V′`, summary output priced at the output rate).
   Key results:
   - One-time fold cost `ΔC₁(h,S) = (w−r)(1−h)(V−S) + qβS − rS` (exact), with an
     upper-bound variant charging full `w` on the re-paid tail.
   - Per-turn saving `Δs = (1−β)·S·r̄`; break-even `n*(S,h) = ΔC₁/Δs`, strictly
     decreasing in `S` for fixed `h`.
   - Oscillating-regime optimum `S* = sqrt(2·g·(w−r)·(1−h)·Vmin / r̄)` when `qβ > r`.
   - Worked example (`V≈70K, S≈50K, h≈0.33, β=0.05`): `n* ≈ 2.9` turns exact
     (3.1–3.8 under convention/price variants) ≪ actual `k ≈ 20` → net-positive.
2. Mapped Codex CLI / Claude Code / opencode / Pi-ACP onto `(V̄, S, h)` with stated
   assumptions; computed per-turn costs (9.1 / 13.9 / 13.7 / 7.9 K-units).
3. Generated 4 charts via `gen.mjs` (SVG→PNG, resvg): break-even curve, fold-position
   vs one-time cost, optimal fold size vs retention, client strategy bars. All visually
   verified (no clipped labels, glyphs render).
4. Wrote `docs/compression-economics.md` (formulas, worked example, client table,
   policy implications, limitations) and the devlog entry.

## Changed files

- `docs/compression-economics.md` (new)
- `docs/assets/compression-economics/*.png` (new, 4 charts)
- `devlog/2026-09-15_compression-economics-model/{REQ,WORKLOG}.md` (new)

## Verification

- Docs-only change; no build/test impact. Chart PNGs rendered and inspected.
- Formula sanity: exact `ΔC₁` equals the increment over a cache-hit baseline; upper
  bound ≥ exact; `n*` monotonic in `S`; `S*` interior optimum requires `qβ > r`.

## Iteration 2 — estimator + live pricing (@dog request on #359)

- Added `estimator/index.html`: self-contained zero-dependency interactive
  estimator (sliders V/S/h/β/g/Vmin/k, 17 price presets incl. custom, live
  ΔC₁/$ Δs n* S* C(S) verdict + two canvas charts). GitHub markdown cannot run
  JS; page is hosted in-repo for GitHub Pages / local opening.
- Fetched current mainstream pricing from BerriAI/litellm
  `model_prices_and_context_window.json` @ commit `7e3ca14` (2026-09-15);
  mapped to (w,r,q) and added doc §7 with table + two new charts:
  `pricing-nstar-vs-S.png` (break-even by pricing class) and
  `pricing-absolute-cost.png` ($/100 turns at S*).
- Key finding: current-gen pricing is nearly vendor-homogeneous (r≈0.1
  everywhere; earlier "OpenAI cache-read = 0.5×" assumption was GPT-4o-era) →
  n*(S) ≈ 3.4–4.3 at S=50K across all classes; S* set by geometry, absolute $
  ∝ input price.
- `/acp` economics readout: feasibility assessed (recompute last-fold geometry
  via firstFoldStartTokens() from data already in the status handler; optional
  priceProfile config; no state-schema change) — documented as proposed in
  doc §7.3, implementation deferred pending owner decision.
