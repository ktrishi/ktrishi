# Intraday F&O Tracker — Design

Date: 2026-11-27 · Owner: Rishi · Status: approved by Rishi 2026-11-27 ("ok")

## Intent
A trader's diary for **today**, for Nifty and Bank Nifty. It answers four questions:
- Which way is the trend, and how strong is it?
- Is a reversal building?
- Is a quick long or short setup forming?
- What is the bias for tomorrow?

It also shows Rishi's own open F&O positions against the day's levels. It uses little data and makes no orders.

## Decisions (Rishi, 2026-11-27)
- **Positions:** both the market-wide build-up and his own Kite positions. His positions are shown live and **never stored**.
- **Alerts:** dashboard only. A trend change is flagged on the page at once while it is open; there are no phone alerts.
- **Signals:** shown, labelled **unproven**. Each one is logged as a paper trade, scored 30 and 60 minutes later, and the hit rate is displayed.

## Data
The tracker runs in the page while it is open and costs no tokens.
- **Every 5 minutes, with the existing refresh:**
  - the futures quote: price, open interest and VWAP (`average_price`)
  - the option open-interest walls and the near-the-money put/call ratio, from the existing panels
  - VIX
  - positions (net view)
- **Every 15 minutes:** today's 15-minute futures candles with open interest, one call per index. The day is rebuilt from these, so a late open still shows the morning.
- **Levels:**
  - the previous day's high, low and close
  - pivot, R1/S1 and the central pivot range (from the cached history document)
  - the opening range (the first two 15-minute bars)
  - VWAP
  - the strongest call and put open-interest walls

## Engine (shared block, tested)
- **`buildupOf`:** each bar is long build-up, short build-up, short covering, long unwinding or neutral. Thresholds are 0.05% of price and 0.05% of open interest.
- **`trendScore`:** a score from −5 to +5. Its inputs:
  - price against VWAP (±1)
  - higher-high/higher-low structure over 4 bars (±1)
  - an opening-range break (±1)
  - the dominant build-up over the last 4 bars (±1)
  - the open-interest walls shifting since the open (±1)
  - the put/call ratio change since the open (±0.5)
  - VIX against price (±0.5)

  The label is Up at +2 or more, Down at −2 or less, and Sideways otherwise.
- **`trendTracker`:** the label must hold for two consecutive checks before it replaces the confirmed one. That replacement is a flip.
- **`reversalWatch`:** price within 0.15% of a wall that opposes the trend, together with the opposite build-up.
- **`signalCheck`:**
  - **Long:** the trend is Up, and the bar closes through the opening-range high or the previous day's high, with long build-up or short covering, above VWAP.
  - **Short:** the mirror image.
  - **Each signal gives** an entry (the close), an invalidation level (the closer of VWAP and the bar's extreme) and a target (the next level, or 1.5× the risk).
  - **Limits:** 09:30–14:45 only, at most one signal per index per hour.
- **`scoreSignal`:** the result in points at +30 and +60 minutes, and whether the invalidation was hit first.
- **`tomorrowBias`:** after 15:25. It weighs the close against VWAP, the close's place in the day's range, the day's open-interest change against its price change, and the put/call ratio change.
- **`parseOptionSymbol` and `positionRisk`:** each strike's distance from spot. A **breach** flag shows when a short strike is within 0.5% of spot or beyond it.

## Storage
- **`diary/<IDX>-<date>`:** `{open:{walls, pcr, vix}, snaps[≤14], flips[], signals[], bias}`, written at 30-minute boundaries and on each flip or signal.
- **Positions:** never written.

## Page
- **Tab:** "Intraday", second after Today. A flip shows a warning on the tab label and a page-wide banner for 30 minutes.
- **Per index:**
  - the trend label and its reasons
  - the levels ladder
  - a build-up strip
  - a price/VWAP chart with open interest
  - signals with their paper results
  - the diary table
  - the tomorrow bias
- **Positions card:** at the top.

## Capability change
The Kite MCP tools become `["market", "portfolio"]`; portfolio is read-only. claude.ai asks Rishi once to allow it.
