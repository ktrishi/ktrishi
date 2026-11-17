# Tiwari Family Wealth: consolidated dashboard

One dashboard replaces V2 (`TjLmMzRCzx2z6L6vfjnJnk`), V4 (`JugU6z3ho2ceWqt9CfrTpC`) and the standalone pages.
It is published at the V4 URL, https://claude.ai/artifact/JugU6z3ho2ceWqt9CfrTpC, which is already pinned.

## What changed

The V4 page already carried the full data model (holdings, MTF, F&O, credit, insurance, tax, estate,
history, snapshots, lineage). This layer adds what the other dashboards had and V4 lacked:

| Tab | Purpose | Replaces |
|---|---|---|
| **Update & Audit** | Runs the audit and a live NSE price check every time the page opens; one-click full update (fires `TW Update Now`) | V2 Update / Asset Health / Anomalies / Audit; V4 Maintain button |
| **Behavioural** | Six investor biases matched to live figures in the book | V2 Behavioral tab, *Tiwari Behavioral Ledger* (27-Aug, stale) |
| **History** | Daily net-worth log, month ends, plan vs actual at 11% from 12-Oct-2026 | V2 History, Plan vs Actual |
| **Export** | CSV or JSON for holdings, funds, equity and MTF, liabilities, derivatives, history, audit and advice, following the member filter | — (new) |

The status bar under the header shows the audit result, portfolio score, build time, NAV date and
live NSE result on every open.

### Live NSE check (on open)
- Uses the `cm-market` connector (`cm_get_stock_quote`, `cm_get_index_quote`) with the viewer's own
  credentials. It asks for permission once, then runs automatically on every open.
- Covers listed equity, MTF lines, option underlyings, NIFTY 50, NIFTY BANK and INDIA VIX.
- **Overlay only.** MODEL is never changed, so the headline still matches the audited build to the
  rupee. Booked prices change only through the full update.
- Flags short option legs that live spot has reached or come within 2% of.

### Underlying audit (in the browser, on open)
These checks run alongside the engine audit from `tw4_engine.js`:
arithmetic (quantity × price = value), MTF quantity within the holding, MTF lines adding up to the
MTF total, derived vs statement MTF loans, class totals tying to the audited totals, reconciliation
to `prodAudit` (Δ₹0), stock price, ETF price and NAV freshness, missing folio, cost or ISIN,
Regular plans, tiny positions, estimates, real-estate valuation age, stale option books, expired legs,
and booked vs live price deviation (more than 8%).

## Install on the PC (required, or the next build drops these tabs)

`build_v4.js` inlines `tw4_app.js` from disk, so the daily 10:00 IST run rebuilds the page from
the unpatched file. Until the patch is applied, these tabs survive only until the next run.

1. Copy `tw5_consolidated.js` and `patch_tw4_app.py` into `Knowledge Base\financial\reports`.
2. In that folder run:
   ```
   python patch_tw4_app.py
   node -c tw4_app.js
   node build_v4.js ../Tiwari_Wealth_V4.html
   ```
   The script backs up `tw4_app.js` (`.bak.<epoch>_tw5`), prepends the module and applies five
   asserted exact-string patches. It is idempotent; `--check` reports the patch state without
   changing anything.
3. Nothing else changes. The routines already republish V4 **without** `capabilities`, which keeps
   the new declaration (`downloads` plus the `cm-market` connector). Do not pass `capabilities: {}`.

## ETF prices (`price_etfs.py`)
Demat ETF rows carry an ISIN but no NSE symbol, so the symbol-based price step never priced them.
`price_etfs.py` downloads NSE's official CM bhavcopy for `nav_calendar.last_session()` and matches by ISIN.
Before ~19:00 IST the day's bhavcopy is not out, so the script reports SKIP; the 23:30 IST run prices them.
`inspect` shows the row layout, a plain run is a dry run, `--apply` backs up and writes. Exit 0 ok / SKIP, 2 some
ISINs missing or STALE, 1 download or layout problem.

## Schedule
`TW Update Now` runs at 10:30 and 23:30 IST. The 23:30 run picks up that day's NAVs (AMFI publishes ~23:00)
and the official closing bhavcopy (stocks and ETFs). The morning run syncs Kite and FoF NAVs.

## Retiring V2
V2 still publishes from `gen_artifact_v2.js`, and `audit.js` is still the reconciliation source that
`build_v4.js` checks against, so keep the build. V2 is unpinned; do not share its link.

## Not merged on purpose
Client portfolio reviews (not family wealth), an undeployed growth-sleeve plan, the September F&O desk
(superseded by the Derivatives tab), and market-research pages.

Informational only. Not investment, tax or legal advice.
