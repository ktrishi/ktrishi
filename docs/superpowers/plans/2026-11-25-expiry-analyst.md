# Expiry Analyst Implementation Plan

> Executed inline (native), as Rishi chose for the previous plan. TDD for the Node module, then one fresh final review of the whole branch.

**Goal:** Add the scheduled analyst run, the self-correction logic, and the new dashboard views described in the spec.
**Spec:** `docs/superpowers/specs/2026-11-25-expiry-analyst-design.md`
**Tech:** Node ≥ 18 (`node:test`), the existing artifact page (vanilla JS + Chart.js), Claude scheduled tasks.

## Global constraints
- There is one engine. `analyst/engine.js` loads the `/*ENGINE-START*/…/*ENGINE-END*/` block from `artifact/fo_expiry_desk.html` at runtime, so the page and the analyst can never diverge.
- Overlay range multiplier is clamped to [1, `eventBandMax`]. Centre nudge is clamped to ±`nudgeCapSigma`·σ.
- Proposal rules need at least 6 settled expiries; the futures rule needs at least 8.
- Only the analyst writes `locks`, `outcomes`, `scores`, `postmortems`, `weights` and `proposals` (it creates them). The page writes only `latest/*` and the proposal `status` field.

## Review focus
1. **Malformed transcribed chain:** a duplicate strike, negative OI, or spot outside the window. The script must reject the input with a clear message and write nothing. Test: `validate rejects bad chain`.
2. **Expiry with locks but no settlement candle yet:** the expiry is left unsettled and retried next run. Test: `settle skips missing candle`.
3. **Overlay outside its caps:** the values are clamped and the reason is still recorded. Test: `overlay is clamped`.
4. **Proposal spam:** the same rule must not fire again while an earlier one is pending. Test: `no duplicate pending proposal`.
5. **Page opened before the analyst has ever run:** the new views show empty states, not errors. Covered by the manual check in Task 5.

### Task 1: Engine loader and lock builder (`analyst/engine.js`, `analyst/test/engine.test.js`)
- Exports `loadEngine(htmlPath)`, which returns `{computeSignals, predict, dteBucket, refit, scoreLocks, trackRecord, compare, PRIOR, PRIOR_K, ...}`.
- Exports `applyConfig(ws, cfg, idx)`. It drops signals listed in `cfg.dropped[idx]`, enforces `cfg.forwardFloor[idx]` on the forward weight, and multiplies `k68`/`k90` by `cfg.kScale[idx]`.
- Exports `validateChain(input)`, which throws an `Error` naming the problem.
- Exports `buildLock({idx, kind, chain, nowMs, weights, cfg, overlay, events, prevLock})`, which returns a lock doc. The doc carries:
  - model centre and ranges
  - final (overlay) centre and ranges
  - forward and spot
  - signal centres, supports, resistances and the PCR near the money
  - bucket, `changed` and `reason`
  - the `eventsHigh` flag
  - the overlay reasons
- Tests:
  - the engine loads, and max pain on the sample chain is 25200
  - `validate rejects bad chain`
  - `overlay is clamped`: band multiplier 2 is clamped to 1.3, and a nudge of 1σ is clamped to 0.25σ
  - `applyConfig` floor and drop

### Task 2: Settlement, post-mortem and proposals (`analyst/learn.js`, tests)
- `classifyMiss(lock, settlement, step)` returns `{type, pinHeld, z}`, following the spec's rules in order.
- `scoreLock(lock, settlement, step)` returns a score doc with errors for the model, the overlay and futures, plus `in68`, `in90` and the miss.
- `postmortem(idx, expiry, locks, settlement, step)` returns a doc with the narrative, the miss of the last lock, the closest signal and the lesson.
- `proposals(idx, recentScoresByExpiry, cfg, pending)` returns a list of new proposal docs, following the spec's rules.
- `applyApproved(cfg, approvedProposals)` returns `{cfg, appliedIds}`.
- Tests:
  - each miss type
  - `settle skips missing candle`, via `settleDue(locks, outcomes, candles, now)`
  - `no duplicate pending proposal`
  - widen proposal when the 68% range held only 3 times in 8
  - `applyApproved` changes `kScale`

### Task 3: CLI (`analyst/run.js`)
- `node analyst/run.js lock --input chain.json --state state.json` writes `out/locks.json` (ArtifactData batch entries).
- `node analyst/run.js settle --state state.json --candles candles.json` writes `out/settle.json` (batch entries).
- `state.json` is the db read the run did beforehand: config, weights, locks, outcomes, scores and pending proposals.
- Test: a CLI smoke test on fixtures produces valid batch entries.

### Task 4: Runbook and scheduled tasks
- `analyst/RUNBOOK.md` gives exact steps for the scheduled session:
  1. Locate or clone the repo.
  2. Read the db.
  3. Settle (09:40 only).
  4. Pull from Kite.
  5. Research events (Firecrawl, cm-market).
  6. Run the CLI.
  7. Write the batch via ArtifactData.
  8. Log the run.
- Create two scheduled tasks (fresh session each, connectors Kite, Firecrawl, cm-market, nse-bhavcopy) with crons `CRON_TZ=Asia/Kolkata 40 9 * * 1-5` and `CRON_TZ=Asia/Kolkata 45 14 * * 1-5`.

### Task 5: Page views (`artifact/fo_expiry_desk.html`)
- Remove the page-side locking and settlement calls.
- Load `analyst/latest`, `postmortems`, `proposals`, `config/model` and `runs`.
- Contract tab:
  - show the analyst overlay (final versus model) and its reasons
  - show "last locked" from the analyst
  - apply the config to live predictions
- New tabs:
  - **Analyst:** events, last run status, Kite login warning.
  - **Track record:** predictions vs settlement chart per index, plus three-way error KPIs (model / overlay / futures).
  - **Post-mortems:** one card per expiry.
  - **Proposals:** Approve / Reject.
- Republish, and syntax-check the page.

### Task 6: Seed and first run
- Seed `config/model` with defaults.
- Run the runbook once by hand now (market open), so the dashboard has a real first lock, analyst notes and events.
