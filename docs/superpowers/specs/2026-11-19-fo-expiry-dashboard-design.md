# F&O Expiry Prediction Dashboard — Design

Date: 2026-11-19 · Owner: Rishi (personal use) · Status: ready for approval

## 1. Intent

A personal tool for Rishi's own trading that estimates where **Nifty (weekly and monthly expiry)** and **Bank Nifty (monthly expiry)** will settle on expiry day, from the live option chain, open-interest structure, implied volatility and price action. It reassesses the estimate 3 times a day, records every prediction and the reason it changed, scores itself after every expiry, and re-weights its signals from that record.

Why: Rishi wants a disciplined, repeatable read of expiry positioning (support/resistance from OI, max pain, implied range) instead of an ad-hoc look at the chain, plus an honest track record of how good that read is.

## 2. Goals, non-goals, anti-goals

**Goals**
- Live tracking of three contracts: Nifty current weekly, Nifty current monthly, Bank Nifty current monthly (when weekly and monthly coincide, e.g. 23-Nov-2026, both panels show the same expiry).
- For each: a central expiry estimate, 68% and 90% bands, probability of settling above/below key strikes, support and resistance levels, and the signals behind them.
- Formal reassessment 3× per trading day (≈09:45, 12:30, 15:05 IST), each logged with a short reason for any change.
- Post-expiry scoring and signal re-weighting ("learning"), with the track record shown on the dashboard.
- Initial signal weights fitted on 2–3 years of past expiries (NSE bhavcopy back-test), not guessed.

**Non-goals**
- Placing, modifying or suggesting orders. The app is read-only on Kite.
- Tick-by-tick streaming; a ~5-minute refresh is enough.
- Other underlyings (Fin Nifty, Midcap Nifty, Sensex, stocks) — can be added later; the engine must not hard-code "NIFTY".
- Running unattended without the daily Kite login (not possible within Kite/SEBI rules).

**Anti-goals (failure even if it "works")**
- Showing a single point prediction without bands. The headline is always centre + range.
- Showing stale data as if live. Every panel shows data time; stale (>10 min in market hours) or logged-out state is shown loudly.
- Over-fitting: weights that swing wildly expiry-to-expiry on a sample of ~50 weekly / 12 monthly expiries a year.
- Hard-coding expiry weekdays. Expiry dates come from the Kite instrument master (e.g. Nov-2026 monthly is Monday 23-Nov, not Tuesday).

## 3. Constraints

- Runs on Rishi's **Windows laptop**, during market hours (09:15–15:30 IST). It must cope with the laptop being off/asleep (gaps are logged, not silently filled).
- Data: **Zerodha Kite Connect API** (₹500/month; waived in a month after ₹2,000+ brokerage). The access token expires daily at ~06:00 IST, so one browser login per day is required.
- Kite quotes give LTP, bid/ask, volume and OI but **no IV/Greeks** — IV must be computed.
- Kite does **not** serve data for expired contracts — the back-test needs NSE F&O bhavcopy archives (`nsearchives.nseindia.com`), downloaded from Rishi's laptop (Indian IP; NSE blocks most cloud IPs).
- Kite quote endpoint: ≤500 instruments per call, ~1 request/second.
- Credentials (API key/secret, access token) stay on the laptop in a local `.env`/data folder; never committed.
- Development happens in a cloud sandbox that cannot reach `api.kite.trade`; it is tested against real option-chain snapshots captured via the Kite connector and saved as fixtures.

## 4. Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Scheduled Claude agent (via Kite connector) 3×/day, publishing a private claude.ai dashboard page | No data fee, no server, adds news/event judgement; but refreshes only 3×/day and consumes Claude usage | Not chosen |
| **B** | **Standalone Python app on Rishi's machine using Kite Connect, local live dashboard, rule-based engine with scheduled reassessments** | **Live (~5 min) updates, independent of Claude; ₹500/month data fee; no news/event reasoning unless an AI key is added later** | **Chosen by Rishi** |
| C | Cloud VPS hosting of B | Runs all day, phone access; ₹500–1,000/month and server upkeep | Not chosen (Windows laptop) |

## 5. Decided by Rishi

- Approach B, for personal use (own trading decisions).
- Runs on his Windows laptop.
- Data via Kite Connect. The Kite Connect app is created (paid Connect plan) with redirect URL `http://127.0.0.1:8050/kite/callback`; postback URL left blank (no orders, so no order webhooks). The dashboard therefore serves on port 8050. API key and secret live only in the laptop's local `.env`.

## 6. Design

### 6.1 Components

```
 Kite Connect API ──► collector ──► SQLite (snapshots) ──► engine (signals → prediction)
        ▲                                   │                         │
   daily login                              ▼                         ▼
   (localhost callback)              scorer/learner ◄── outcomes   predictions log
                                            │                         │
 NSE bhavcopy (back-test) ─► backtester ────┘                         ▼
                                                        FastAPI + dashboard (127.0.0.1)
```

One Python process (`app`) runs a scheduler, the collector, the engine and the web server. A separate CLI command runs the back-test.

### 6.2 Data collection
- **Instrument master**: downloaded each morning; determines current weekly/monthly expiry for NIFTY and the current monthly for BANKNIFTY, strike lists and lot sizes.
- **Chain snapshot** every 5 minutes in market hours: index spot, the matching future, India VIX, and CE/PE quotes for strikes within ±8% of spot (Nifty ≈ ±40 strikes at 50-pt spacing; Bank Nifty at its 100-pt spacing). Stored as rows (time, underlying, expiry, strike, type, ltp, bid, ask, volume, oi).
- **Daily OHLC** of the indices (Kite historical) for price-based levels.
- Trading-day detection: if no fresh index quote by 09:20, treat the day as a holiday and skip.

### 6.3 Signals (per contract, per snapshot)
1. **Forward**: futures price (the market's no-view expected settlement).
2. **Max pain**: strike minimising total option-writer payout.
3. **OI walls**: top 3 put-OI strikes below spot (supports) and top 3 call-OI strikes above spot (resistances); OI-weighted centre of the strongest put and call walls.
4. **OI change**: change in OI per strike since previous close and since previous reassessment (shows walls moving / writers rolling).
5. **PCR**: total and near-ATM (±5 strikes) put/call OI ratio, used as a tilt.
6. **Implied distribution**: IV per strike via Black-76 from option mid-price and the future; ATM IV gives expected move σ = F·IV·√(T/365); probability of settling above/below each strike from that distribution.
7. **Gamma concentration**: strike with the largest net OI-weighted gamma near spot (assumption: option writers are net short both calls and puts; documented as an assumption).
8. **Price levels**: previous day high/low/close pivots and recent swing levels, shown for context and used as a minor signal.
9. **Momentum**: short-horizon return (e.g. 3-day), used as a small drift term.

### 6.4 Prediction
- **Centre** = weighted blend of the signal "centres" (forward, max pain, OI-wall centre, gamma pin, PCR/momentum tilts applied to forward).
- Weights depend on **days-to-expiry bucket** (>5, 2–5, ≤1 trading days): pinning signals (max pain, walls, gamma) are expected to matter more near expiry; the learner decides by how much.
- **Bands**: centre ± k68·σ_remaining and ± k90·σ_remaining, where σ_remaining comes from ATM IV and k-multipliers are calibrated so that historically ~68%/90% of settlements fall inside.
- Output per contract: centre, bands, P(settle > each key strike), top supports/resistances, each signal's value and weight, a data quality flag.

### 6.5 Reassessment schedule
- Snapshots every 5 min refresh the dashboard's live numbers.
- At ≈09:45, 12:30 and 15:05 IST the engine **locks a formal prediction** into the log. If the centre moves by more than a threshold (default 0.3% for Nifty / 0.4% for Bank Nifty) or a top support/resistance changes, it records a rule-generated reason ("put wall shifted 25,000 → 25,300; PCR 0.92 → 1.15") and raises a Windows notification.
- Only locked predictions are scored; that's the track record.

### 6.6 Scoring and learning
- **Settlement value** = the index closing value on expiry day (NSE final settlement for index options).
- After each expiry: absolute and % error of every locked prediction, error of each individual signal, and whether the 68%/90% bands contained the settlement.
- **Re-weighting**: per underlying and per days-to-expiry bucket, weights are refitted on the rolling history of signal errors (e.g. inverse-error weighting or constrained least squares), **shrunk towards the back-test prior** so a single expiry cannot swing them sharply. Band multipliers are re-calibrated from coverage.
- Every weight change is versioned; the dashboard shows the current weights and the track record (hit rate within ±0.5%/±1%, band coverage, mean error, vs a naive "futures price" baseline). If the model doesn't beat the futures-price baseline, the dashboard says so.

### 6.7 Back-test (initial calibration)
- CLI command downloads NSE F&O bhavcopy (daily, UDiFF format) for NIFTY and BANKNIFTY options over the last 2–3 years plus index closes, reconstructs end-of-day chains for each day before each expiry, computes the same signals, and fits the initial weights and band multipliers.
- Back-test is end-of-day only (intraday history isn't available free); the dashboard marks weights as "back-test prior" until enough live expiries accumulate.
- Until the back-test has run, predictions are labelled **"uncalibrated"**.

### 6.8 Dashboard (local web page, 127.0.0.1 only)

```
┌ Status: Kite ✔ logged in · data 13:05:12 IST · next reassessment 15:05 ─────────┐
├─ NIFTY weekly (exp Mon 23-Nov, 2 days) ─┬─ NIFTY monthly ─┬─ BANKNIFTY monthly ─┤
│ Spot 25,371  Fut 25,397  VIX 16.25      │  (same layout)   │  (same layout)      │
│ Expected settle 25,350                  │                  │                     │
│ 68%: 25,180–25,520  90%: 25,060–25,640  │                  │                     │
│ Supports 25,300 · 25,000 · 24,800        │                  │                     │
│ Resists  25,500 · 25,600 · 26,000        │                  │                     │
│ Max pain 25,300 · PCR 1.08 · ATM IV 13.9 │                  │                     │
│ P(>25,500) 22%   P(<25,000) 9%          │                  │                     │
│ [OI by strike bar chart, CE vs PE, with OI change overlay]                    │
│ [Prediction drift chart across the series: centre + bands vs spot]            │
│ Reassessment log: 12:30 centre 25,300→25,350 — put wall moved up …            │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Track record: last 10 expiries, error, band coverage, vs futures baseline; weights│
└──────────────────────────────────────────────────────────────────────────────────┘
```
- Auto-refreshes every 60 s from a JSON endpoint. Stale or logged-out state turns the status bar red with a "Log in to Kite" button.

### 6.9 Operations on Windows
- Python 3.12 + a virtual environment; `setup.bat` installs dependencies; `start.bat` starts the app and opens the dashboard.
- Optional Windows Task Scheduler entry to start the app at 09:00 on weekdays.
- While running in market hours the app asks Windows not to sleep; if the laptop does sleep, missed snapshots/reassessments are logged as gaps.
- Daily login: the dashboard's "Log in to Kite" button opens Kite's login page; Kite redirects to `http://127.0.0.1:8050/kite/callback`, and the app exchanges the token and stores it locally until ~06:00 next day.
- All data in a local folder (SQLite database + logs), backed up by simply copying the folder.

### 6.10 Later (not in first build)
- Optional AI commentary: an Anthropic API key in `.env` enables a short Claude-written market-context note at each reassessment (events, global cues, FII flows) that can nudge the band width; off by default.
- NSE participant-wise OI (FII/Pro/Client positioning) as an extra signal, from the same NSE archive.
- More underlyings.

## 7. Calls made by Claude (open to correction)
- Stack: Python 3.12, `kiteconnect` SDK, FastAPI + a single static HTML/JS page with Chart.js, APScheduler, SQLite. Chosen for being simple to run on Windows with no extra services.
- Strike window ±8% of spot; 5-minute snapshot interval; reassessment times 09:45 / 12:30 / 15:05; change thresholds 0.3% / 0.4%.
- Days-to-expiry buckets and shrinkage-towards-prior learning instead of any ML model, because of small sample sizes.
- Writers-short assumption for gamma.
- Build order: (1) collector + engine + dashboard + log with prior weights labelled uncalibrated; (2) back-test + learner; (3) optional AI commentary.

## 8. Left to the builder
- Exact weight-fitting method within "shrinkage towards prior" and its strength.
- IV solver details, handling of illiquid/zero-bid strikes.
- Database schema, code layout, test structure.
- Visual styling of the dashboard.
