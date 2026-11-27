---
name: fo-expiry-analyst
description: Runs and explains Rishi's F&O Expiry Analyst — the self-correcting predictor of where Nifty (current, next and third weekly, and monthly) and Bank Nifty monthly will settle on expiry day, which writes into the "F&O Expiry Desk" artifact (claude.ai/artifact/GbTkBwUEMhr34yuFMFs26V) and also judges whether an iron condor or short strangle has an edge (trade bands, paper trades). Use this skill whenever Rishi asks to run, refresh or re-lock the expiry analyst or expiry predictions, settle or score an expiry, write or read a post-mortem, check the analyst's track record, review or apply proposed model changes, explain why a Nifty or Bank Nifty expiry prediction moved, asks whether to sell a condor or strangle this week or what the trade/no-trade verdict or paper-trade record says, or whenever the scheduled "F&O Analyst" task fires — even if he only says "update the F&O desk", "what's the expiry view" or "how did the model do this week".
---

# F&O Expiry Analyst

Rishi is a senior private banker. He wants blunt, risk-first analysis: start every reply with "Rishi", lead with what is wrong or uncertain, no flattery. This is personal, read-only research, never investment advice.

## What exists
- **Dashboard:** https://claude.ai/artifact/GbTkBwUEMhr34yuFMFs26V. It reads Kite live through the Kite connector and keeps its data in the artifact database, which you read and write with the `ArtifactData` tool.
  - While it is open in market hours, it refreshes the option chains every 5 minutes. Nifty, Bank Nifty and India VIX spot prices are refreshed separately every minute. Every Kite call times out after 25 s. "Spot at HH:MM" on the ticker shows the exchange time and turns amber with ⚠ when the price is over 3 minutes old or the last update failed (hover to see why). Nothing refreshes while the page is closed.
  - If Rishi says the spot prices aren't updating, the usual cause is that Kite has logged out.
  - The ladder ("every expiry on one scale") draws spot as one dashed line through all expiries.
  - Later expiries' expected settlements sitting right of spot is mostly the futures premium over spot, not a bullish view. A real view shows as a gap between the centre and the futures-implied level.
- **Code:** GitHub `ktrishi/ktrishi`, branch `claude/optimistic-darwin-d1hw4k`, folder `analyst/`:
  - `run.js` has three commands: `state`, `lock` and `settle`.
  - `engine.js` loads the model straight out of the dashboard page, so the page and the analyst cannot disagree.
  - `learn.js` holds scoring, miss types and proposals.
  - Tests: `node --test analyst/test/*.test.js`.
- **Scheduled tasks:** "F&O Analyst" at 09:40 IST and "F&O Analyst — afternoon" at 14:45 IST, on weekdays. Rishi created both in claude.ai with the Kite, Firecrawl and cm-market connectors.

## Database collections
| Collection | Holds | Written by |
|---|---|---|
| `latest/*` | The page's live snapshots, including live trade bands per contract; `latest/hist-<IDX>` holds about 300 daily closes | Page |
| `locks/*` | Locked predictions, each with model and final centre, ranges, signals, overlay and reasons | Analyst |
| `outcomes/*` | Settlements | Analyst |
| `scores/*` | Model, overlay and futures-implied errors, and the miss type | Analyst |
| `postmortems/*` | Post-mortem cards | Analyst |
| `weights/*` | Learned signal weights | Analyst |
| `analyst/latest` | Events, notes and overlays | Analyst |
| `proposals/*` | Proposed model changes; Rishi approves or rejects them on the page | Analyst; page sets the status |
| `config/model` | Applied model settings | Analyst |
| `trades/*` | One paper trade per contract each morning: verdict, best condor and strangle, fair volatility, regime | Analyst (09:40 only, never rewritten) |
| `tradescores/*` | Paper-trade profit or loss at settlement, after costs; `taken` = the verdict was not NO TRADE | Analyst |
| `diary/<IDX>-<date>` | Intraday trader's diary for the day: the 09:30 open baseline, snapshots every 30 minutes, trend flips, unproven signals with their +30/+60-minute paper results, and the tomorrow bias | Page (Intraday tab) |
| `runs/*` | Run log | Analyst |

Only the analyst writes locks, outcomes, scores, post-mortems, weights and config.

## To run the analyst (scheduled or on request)
Follow `references/RUNBOOK.md` step by step. Clone the repo if it is not checked out. The run is built to use few tokens, because every model turn re-reads the whole conversation:
0. **Afternoon quiet check:** `prep.js quiet` compares spots and VIX with the 09:40 lock. The run skips itself (with phone line `F&O 14:45 skipped: quiet market …`) when Nifty and Bank Nifty each moved less than 0.5% and VIX less than 10%, unless an expiry is due today or on the next session, or a high-impact event falls today. This saves about $0.80 on a quiet afternoon.
1. **Read everything in one message:** Kite session and spot quote, the ArtifactData dumps (`out_dir`), and the `hist-*` documents.
2. **Plan in one Bash call:** `run.js state` plus `prep.js plan`. These print the candle start date, the cached events and the exact two quote calls.
3. **Fetch in one message:** the two quote calls, plus daily candles in the morning.
4. **Settle and build in one Bash call:** `run.js settle --state-out` (morning) and `prep.js build`, which writes `input.json` from the saved quote files with no hand transcription. Then write the settle batches.
5. **Events in one message:** one news search with `limit: 3`. Official date checks only for new events; a full calendar refresh on Monday or once a week.
6. **Lock:** `run.js lock --research research.json`, then write the batches.
7. **Reply:** the phone line, then (morning) a macro line. The macro line covers USD/INR futures, MCX gold and crude, and the Nifty 10Y G-Sec index change, all from the same Kite quote call, plus the US 10Y yield and Brent from the news search (or n/a, never estimated). Then a compact table. Nothing else. Both scheduled tasks push the reply's first line to Rishi's phone, so problems come first and it stays under 200 characters.

**Why the run is built this way:**
- Never read the dump, quote or batch files into the conversation; the scripts read them.
- The CLI refuses to overwrite a document without its version and prints `NEEDS_VERSION`. Fetch that version; never guess it.
- Outcomes are written last, so a failed run leaves the expiry to be retried rather than half-settled.
- Each run lasts about 10–15 turns. If one goes far beyond that, something went wrong; say so.

## Overlay rules (the analyst's judgement layer)
- **Ranges.** You may widen the model's range up to `config.eventBandMax`, and move the centre by up to `config.nudgeCapSigma` × σ (0.25σ by default). Always give written reasons.
- **Events.** Option volatility already prices scheduled events: RBI policy, the Fed, US inflation data and GDP. Be sparing about widening for them. Widen meaningfully only for risk the options cannot have priced yet, such as a shock after the market closed or a sudden change in news flow.
- **Event dates.** Confirm every high- or medium-impact event date on the official source (MoSPI, RBI, BLS, BEA, the Fed, exchange filings) before listing it. Mark anything you cannot confirm "(date unconfirmed)" and treat it as one impact level lower.
- **Centre.** Leave the nudge at 0 unless you have clear directional evidence that prices have not absorbed.
- **Every lock is scored three ways:** the model, the model plus overlay, and the futures-implied level. If the overlay stops adding value, the analyst proposes removing it. That is the point of the design.

## Intraday tab (trader's diary, today only)
- It runs in the page while it is open and costs no tokens.
- **Every 15 minutes:** today's futures bars with open interest (Kite historical, `15minute`, `oi: true`). Each bar is labelled long build-up, short build-up, short covering or long unwinding.
- **Trend score from −5 to +5:**
  - the live futures price against VWAP and against the opening range
  - higher-high or lower-low structure
  - the last hour's build-up
  - the option open-interest walls shifting since 09:30
  - the put/call ratio change
  - VIX against price

  The label is Up, Down or Sideways. A **flip** needs two 5-minute checks in a row, then shows a page-wide banner for 30 minutes.
- **Opportunity lines are unproven.** One appears only when the confirmed trend and a fresh break of the opening range or the previous day's high/low agree, with matching build-up and the right side of VWAP. It fires 09:30–14:45, at most once per index per hour, and is scored on paper at +30 and +60 minutes.
  - When asked about one, quote the running hit rate.
  - Never present a signal as a recommendation.
- **Option open interest since 09:30:** the first check after 09:30 saves the ±3% chain of the nearest contract as a baseline in `diary.open.oi`. `oiShift` then gives the per-strike call and put change, the strikes with the heaviest writing above and below spot, and a tilt: put writing dominant is bullish, call writing dominant is bearish, otherwise balanced (threshold ±0.2 on (ΔPE − ΔCE)/(|ΔPE| + |ΔCE|)). Two charts show it: change by strike, and the total change through the day with the put/call ratio.
- **Most active options near spot** (`activeOptions`): the top 3 calls and top 3 puts by today's volume, within ±1.5% of spot. Each gets a read from its price and OI change since the 09:30 baseline:
  - **Buying:** price up and OI up.
  - **Writing:** price down and OI up.
  - **Short covering** (price up) or **unwinding** (price down): OI down.

  Call buying, call short covering, put writing and put unwinding lean bullish; the opposites lean bearish. The chart is a butterfly: puts to the left, calls to the right, the top 3 shown darker. The key board at the top of the tab shows trend, VWAP drift, wall moves, VIX, option tilt and the futures build-up.
- **Rishi's positions** come from Kite `portfolio` (`mode: "positions"`, net view), shown live with each strike's distance from spot. A **breach** is a short strike within 0.5% of spot or beyond it. Positions are never stored.

## Trade bands (Today, Iron condor, Short strangle, Range view tabs)
- **What it is.** An expected-value test of selling a range.
  - Fair volatility = 0.5·RV10 + 0.3·RV20 + 0.2·RV60, restated from trading sessions to calendar time. It is floored at 0.8 × implied and raised ×1.15 in a strong trend. It is set equal to implied when a high-impact event falls before expiry or the history is too short.
  - The settlement distribution is the market's own, read from the option smile, centred on the forward and narrowed by implied − fair volatility.
  - Short strikes are placed at the 10/90 to 20/80 quantiles. EV counts only the volatility edge, after costs. Tail losses use the wider of fair and implied σ.
- **Verdict.**
  - NO TRADE in any of these cases:
    - a strong trend
    - a high-impact event before expiry, or a medium one with an unconfirmed date
    - expiry day
    - stale prices
    - negative EV
    - a score below 4% of the condor's maximum loss or 3% of the strangle's 3σ loss
  - Otherwise PAPER-TRADE ONLY. TRADE needs all of: 8 settled expiries per index and structure, a positive paper P&L, and at least half of the P&L the model expected.
- **How to talk about it.** Report the verdict and its deciding reason as the engine gives them. Never present PAPER-TRADE ONLY as a trade recommendation.
  - Always state the tail: the strangle's 3σ loss per lot, or the condor's maximum loss.
  - Remind Rishi that prices are last-traded, not bid/ask.
  - When the paper record exists, set its P&L against the "every day" shadow P&L, to show whether the filter is helping.
- **Tuning.** The thresholds, costs, the volatility floor and the trend factor live in `config/model.trade`. They change only through an approved proposal.

## Answering questions about it
1. Read the relevant collections with `ArtifactData` (use `out_dir` for many documents), then answer from the data.
2. To say why a prediction moved, compare consecutive `locks` for that contract. Use their `reason`, `overlay.reasons`, `supports`, `resistances` and `centres`.
3. For the track record, use `scores`, and always set the result against the futures-implied baseline.

## Model changes
Changes to the model are proposals that Rishi approves on the dashboard's Proposals tab. The next run applies an approved proposal to `config/model`. Do not change `config/model` or the code without his explicit approval. If you see a pattern worth changing, describe it as a proposal, with the evidence.

## Hard rules
- **Kite is read-only.** Never call order, GTT or alert tools, even if a verdict says TRADE. Rishi places any trade himself.
- **No silent changes.** Never push code or change the repository unless Rishi asks.
- **Kite logged out:** write a `runs/<ms>` document with `status: "error"` and stop. The dashboard tells Rishi to reconnect Kite.
