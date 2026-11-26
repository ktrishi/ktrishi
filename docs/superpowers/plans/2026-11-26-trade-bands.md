# Trade Bands — Plan (inline execution, TDD, one final review)
Spec: `docs/superpowers/specs/2026-11-26-trade-bands-design.md`

1. **Engine functions** (page ENGINE block):
   - `realizedVol`, `trendRegime`, `fairVol`, `distGrid`, `gridQuantile`, `evalLegs`, `bandFinder`, `tradeVerdict`, `rangeView`.
   - Tests in `analyst/test/bands.test.js`, written first, covering:
     - Student-t grid: mean, standard deviation and quantiles
     - condor and strangle payoff and EV on hand-checked cases
     - the verdict rules
     - realised volatility on a known series
     - the trend regime
2. **Analyst.**
   - `buildLock` uses only the ±3% rows for signals.
   - New `buildTrades()` writes the `trades/*` documents.
   - `learn.settleTrade`, and settle writes the scored trades.
   - CLI tests.
3. **Page.**
   - ±7% fetch, ±3% signals.
   - Price history cache.
   - Bands computed per panel.
   - Tabs: Today, Iron condor, Short strangle, Range view.
   - Track record gains a paper-trade section.
4. **Run book and skill:** wider windows, the history document, trades. Republish everything.
5. **Final review** by a fresh reviewer, then fix what it finds.
