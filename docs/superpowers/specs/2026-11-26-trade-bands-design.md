# Trade Bands (iron condor, short strangle, range view) — Design

Date: 2026-11-26 · Owner: Rishi · Status: approved by Rishi 2026-11-26

## Intent
Rishi wants a band where risk and reward favour him, for Nifty (current, next and third weekly, and monthly) and Bank Nifty (monthly). He wants it for three uses:
- **(A) Iron condor:** defined risk.
- **(B) Short strangle:** loss not capped.
- **(C) Range view:** a view only, no trade.

A **Today** tab gives one trade / paper-trade / no-trade verdict per contract and structure. The money at stake is his family's, so the tool must say NO TRADE whenever the edge is not there, and it must prove any edge on paper before recommending real size.

## Honest framing (goal definition)
- Option prices already embed the market's distribution. An edge exists only when our fair volatility, estimated conservatively, is below implied volatility: the variance risk premium.
- Tail events can erase that edge.
- Every number is therefore an **expected value under our distribution**, with tail losses shown beside it. A win rate alone is never the deciding figure.
- Until about 8 settled paper trades exist for an index, the best possible verdict is **PAPER-TRADE ONLY**.

## Model (shared engine block in the page, so the analyst runs the same code)
- **Fair volatility.**
  - Blend realised volatility: 0.5·RV10 + 0.3·RV20 + 0.2·RV60.
  - Floor it at 0.8 × implied volatility: never assume the market over-prices by more than 20%.
  - High-impact event before expiry: fair volatility = max(fair, IV), so no edge is assumed.
  - Strong trend: fair volatility × 1.15.
  - No price history available: fair volatility = IV.
- **Trend regime.**
  - **Strong up:** close > DMA20 > DMA50 > DMA200, and DMA20 is rising over 5 days.
  - **Strong down:** the mirror image.
  - Anything else is **range**.
- **Distribution.**
  - Centred on the **futures-implied forward**, not the model centre, which is unproven.
  - Student-t shape with ν = 4, scaled so its standard deviation is σ_fair = F · vol · √T.
  - Held as a discrete grid of 801 points over ±6σ.
- **Candidates.**
  - Short strikes: the nearest listed strikes to the p-quantile (put side) and the (1−p)-quantile (call side), for p = 0.10, 0.15 … 0.40.
  - Condor wings: about 0.5σ beyond the shorts, rounded to listed strikes.
- **Evaluating each candidate.**
  - Credit = short premiums − long premiums, at market last traded prices.
  - EV = E[payoff] under the grid − costs.
  - Costs: Nifty 1 point and Bank Nifty 3 points of slippage per leg, plus ₹60 per leg per lot converted to points using the lot size.
  - Also reported: chance of profit, break-evens, maximum loss (condor), and loss at 2σ and 3σ moves (both structures).
  - Score: condor EV / maximum loss; strangle EV / |3σ loss|.
- **Verdict.**
  - **NO TRADE** if any of these holds: strong trend; a high-impact event before expiry together with EV ≤ 0; best EV ≤ 0; or score below the threshold (condor 4%, strangle 3%).
  - Otherwise **PAPER-TRADE ONLY** when the index has fewer than 8 settled paper trades, else **TRADE**.
  - Always give the single deciding reason.
- **Range view.** Distribution quantiles 10/20/30/50/70/80/90 for each contract, and the 30–70, 20–80 and 10–90 bands.

## Data
- **Strike windows.**
  - The page fetches strikes within ±7% for every expiry.
  - Signals (max pain, walls, PCR) still use ±3%. The page and the analyst both filter to that.
  - The analyst quotes ±4% for weeklies and ±7% for monthlies, using 2 quote calls whose results are saved to file.
- **Price history.**
  - The page fetches about 300 daily candles once a day per index and stores the closes in `latest/hist-<IDX>`.
  - The analyst reads that document. If it is more than 3 days old, it uses no realised volatility: fair volatility = IV, the conservative choice.
- **Paper trades.**
  - Each morning the analyst writes `trades/<key>-<expiry>-<date>`: the verdict, plus the legs and credit of the best condor and best strangle.
  - Settlement scores their P&L at expiry, net of costs.
  - The Track record tab shows paper P&L, win rate and worst loss.

## Changes made during the build (reported to Rishi)
1. **Distribution: market smile instead of a symmetric Student-t.**
   - A symmetric distribution against a skewed market makes selling puts look falsely attractive. That is the side where crashes hurt.
   - The build therefore reads the distribution from the out-of-the-money smile (a quadratic in log-moneyness, flat beyond the quoted strikes) and lowers every strike's volatility by implied − fair.
   - With fair = implied, every structure's EV is exactly minus its costs. This is tested.
2. **Shorts no nearer than the 30/70 quantiles.**
   - Left free, the optimiser drifts to p = 0.40, which is close to a short straddle.
   - An expiry-only payoff understates the day-to-day gamma and mark-to-market risk of near-the-money shorts.
3. **Analyst weekly window ±5%, not ±4%.** The third weekly's wings fall outside ±4%. The analyst still uses 2 quote calls.
4. **After the independent review:**
   - **Fair volatility on calendar time.** Realised volatility is per trading session, but implied volatility is quoted on calendar T. Comparing them directly invented about a 20% edge over weekends.
   - **Paper gate.** It counts distinct expiries, not daily trades, and needs a positive paper P&L of at least half what the model expected.
   - **Smile extrapolation.** It follows the end tangent, so the density has no jump. EV counts only the volatility edge (`modelErr` removed), so fair = implied gives exactly −costs.
   - **Tail losses at the wider of fair and implied σ.**
   - **Shorts capped at 20/80.**
   - **NO TRADE also applies** on expiry day, for any high-impact event, for an unconfirmed medium event, when history is too short, and when prices are stale. Expired contracts are dropped from the view.
   - **History age limit of 4 calendar days** (not 3), so the Monday and post-holiday runs still have fresh closes.

## Non-goals
Live Kite margin (not exposed by the connector), order placement, and any automatic trading.

## Defaults
Costs, thresholds, the ν = 4 shape, the 0.8 volatility floor and the 1.15 trend factor are all changeable through the existing Proposals and config route.
