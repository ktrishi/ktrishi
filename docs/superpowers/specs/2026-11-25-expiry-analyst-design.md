# Expiry Analyst — Design

Date: 2026-11-25 · Owner: Rishi · Status: approved by Rishi 2026-11-25 (option B)

## Intent
Turn the F&O Expiry Desk artifact (https://claude.ai/artifact/GbTkBwUEMhr34yuFMFs26V) into a self-correcting predictor of Nifty weekly, Nifty monthly and Bank Nifty monthly expiry settlement. It adds market events from multiple sources, scores itself after every expiry, explains its misses, tracks predictions against settlements graphically, and proposes model changes for Rishi's approval.

## Honest ceiling (goal definition)
The futures price is the market's own estimate. "Best" means two things, both shown on the page:
- the model beats the plain futures price on mean absolute error over time;
- its 68% and 90% ranges hold about as often as they claim.

## Approach (chosen: B, from A/B/C run-frequency options)
- **Page** (existing artifact)
  - It keeps the live numeric engine, reading the full option chain through the Kite connector.
  - It **stops locking and settling**. It writes only `latest/*` snapshots and proposal decisions.
  - New views:
    - Analyst (events, overlay, reasons)
    - Predictions vs settlement chart across expiries
    - Post-mortem cards
    - Proposals with Approve / Reject
- **Analyst run**
  - A scheduled Claude task, in a fresh session, at 09:40 and 14:45 IST, Monday to Friday.
  - Connectors: Kite, Firecrawl, cm-market, nse-bhavcopy.
  - Steps:
    1. Pull the option chains for strikes within ±3% of spot, plus spot, futures and VIX.
    2. Research events.
    3. Run the page's own engine (extracted from the HTML) in Node.
    4. Apply the event overlay.
    5. Write the locked prediction and the analyst notes to the artifact database.
  - The 09:40 run also settles every expired, unsettled expiry. It writes the post-mortem, refits weights and raises proposals.
- **Overlay limits**
  - Range multiplier between 1.0 and `eventBandMax` (default 1.3).
  - Centre nudge of at most `nudgeCapSigma` × σ (default 0.25σ).
  - Written reasons are required for both.
- **Scoring**
  - Three estimates are scored on every lock: the model, the model plus overlay, and the futures price.
  - This shows whether the news layer adds value.

## Self-correction
- **Miss type**, recorded per locked prediction. It is the first rule that matches, in this order:
  1. `in_range`: the settlement is inside the 68% range.
  2. `event_shock`: there was a high-impact event and z > k68.
  3. `trend_breakout`: the settlement is beyond the strongest wall at lock time and z > 1.
  4. `vol_surprise`: the realised move from spot is more than 1.5σ.
  5. `vol_overpriced`: the realised move is less than 0.3σ.
  6. `other_miss`: none of the above.

  Separately, `pin_held` is flagged when the settlement is within one strike step of max pain or the gamma pin.
- **Automatic adjustment:** small weight shifts use the existing shrinkage refit (λ = 10, last 20 expiries), so one expiry moves a weight by at most 1/11.
- **Proposals:** structural changes need approval. Each rule looks at the last 8 settled expiries of an index and only fires with at least 6 of them.
  - **68% range held < 50%:** propose widening, by raising `kScale` to the observed 68th-percentile z.
  - **68% range held > 85%:** propose narrowing.
  - **Overlay error > model error by more than 10%:** propose `nudgeCapSigma` = 0.
  - **Event-week error > 1.5 × other-week error:** propose raising `eventBandMax` by 0.1.
  - **Model error > futures error, with at least 8 expiries:** propose a `forwardFloor` of 0.6.
  - **A signal has the worst error in at least 6 of the 8 expiries:** propose dropping it.
- **Applying approvals:** approved proposals are applied by the next analyst run to `config/model`. Both the page and the analyst read that config.

## Database (artifact db)
| Collection | Contents |
|---|---|
| `latest/<key>` | Page snapshot |
| `locks/<key>-<expiry>-<date>-<HHMM>` | One locked prediction: model and overlay centres and ranges, signal centres, futures and spot, events flag, reasons |
| `outcomes/<IDX>-<expiry>` | Settlement value |
| `scores/<lockid>` | Errors for the model, the overlay and futures; `in68`; miss type |
| `postmortems/<IDX>-<expiry>` | Narrative, miss type, closest signal, lesson |
| `weights/<IDX>-<bucket>` | Weights (unchanged shape) |
| `analyst/latest` | Events list and per-contract overlay and reasons |
| `proposals/<id>` | Status: pending / approved / rejected / applied |
| `config/model` | `kScale`, `eventBandMax`, `nudgeCapSigma`, `dropped`, `forwardFloor` |
| `runs/<ts>` | Run log: status and error |

## Constraints
- **Read-only on Kite.** No orders.
- **Kite connector session:** lasts about 7 days. A run that hits a login error logs it to `runs/` and the page shows "Kite login needed".
- **Number transcription:** Kite output is transcribed into compact JSON (strike, CE/PE OI and last price). The script validates it: strikes are unique, OI is non-negative, and spot is within the strike window.
- **No options back-test in the cloud:** NSE archives are blocked from here. The laptop back-test stays optional.

## Left to the builder
- Wording of the post-mortem narrative.
- Event search queries.
- Chart styling.
