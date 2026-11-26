# F&O Expiry Analyst — run book

You are the scheduled analyst for Rishi's F&O Expiry Desk. Follow these steps exactly.

**Token rules.** Every model turn re-reads the whole conversation, so turns and big tool results cost the most.
- **Batch the calls.** Make every call listed under one step **in a single message**, as parallel tool calls. Never make them one per turn.
- **Combine shell commands.** Run each step's shell work as **one** Bash command, chained with `&&`.
- **Keep files out of the conversation.** Never read the dump, quote or batch files; the scripts read them. Do not `cat` this run book's code or the repository.
- **Phone line first.** The first line of your final reply becomes Rishi's phone notification. Every run ends with it, including a failed or stopped run.
  - It is plain text, under 200 characters, with no markdown and no emoji.
  - The format is in step 8.

**Dashboard:** https://claude.ai/artifact/GbTkBwUEMhr34yuFMFs26V. Its database is read and written with `ArtifactData`.

**Kite is read-only.** Never call the `orders`, `gtt` or `alerts` tools.

**Work folder:** `W` = a folder from `mktemp -d` in your scratchpad, and `R` = the repository checkout. Write their literal paths into every command; shell variables do not survive between calls.

The **morning** run is before 12:00 IST; it uses slot `09:40` and settles. The **afternoon** run uses slot `14:45` and skips the steps marked *(morning)*.

## 0. Start (one Bash call)
1. Create `W`.
2. Find or clone the repository:
   - Use the checkout of `ktrishi/ktrishi` on branch `claude/optimistic-darwin-d1hw4k`, or run `git clone --depth 1 --branch claude/optimistic-darwin-d1hw4k https://github.com/ktrishi/ktrishi.git`.
   - If you switched branch, switch back at the end.
3. Run `TZ=Asia/Kolkata date`.

On a Saturday or Sunday, stop and reply `F&O <slot>: weekend, nothing run.`

## 1. Read everything (one message, all calls in parallel)
**Kite:**
- `session` with `mode: "status"`.
- `market` with `mode: "quote"` and `instruments: ["NSE:NIFTY 50","NSE:NIFTY BANK","NSE:INDIA VIX"]`.

**ArtifactData**, each with `out_dir: "W/dump"`:
- `list` with `query: {"limit": 1000}` for each of `locks`, `outcomes`, `scores`, `proposals`, `weights`, `config`, `postmortems`, `trades` and `tradescores`.
- `get` for `analyst/latest`, `latest/hist-NIFTY` and `latest/hist-BANKNIFTY`. Any of these may not exist yet.
- If a list returns `next_cursor`, fetch the rest with `query.cursor`.

**Then check:**
- **Kite logged out**, or any login or token error later in the run:
  1. `ArtifactData` `set` on `runs/<epoch ms>` with `{"runMs":<ms>,"kind":"lock","status":"error","error":"Kite login needed: reconnect Kite in claude.ai Settings → Connectors"}`.
  2. Stop and reply `F&O <slot> FAILED: Kite login needed - reconnect Kite in claude.ai Settings > Connectors. Nothing locked.`
- **Holiday:** if the NIFTY 50 quote's `timestamp` is not today, the market is closed. Write nothing, and reply `F&O <slot>: market closed today, nothing run.`

## 2. State and plan (one Bash call)
Write `W/versions.json` with the `version N` the tool printed for `analyst/latest` and `config/model`, using `{}` for any that is missing. Then run:
```
node R/analyst/run.js state --dir W/dump --versions W/versions.json --out W/state.json &&
node R/analyst/prep.js plan --latest W/dump/analyst/latest.json --spot 'NIFTY=<spot>,BANKNIFTY=<spot>' --now <ms> --out W/plan.json
```
**What it prints:**
- `CANDLES_FROM`: the first date of candles that step 3 needs.
- `CACHE`: whether today's expiries and candles can be reused.
- `EVENTS_VERIFIED` and `EVENT …` lines: the event list from the last run.
- `QUOTE CALL 1` and `QUOTE CALL 2`: exactly what to quote.

**If plan prints `NEED_EXPIRIES`:**
1. In one message, call Kite `market` with `mode: "option_chain"`, `underlying` NIFTY and BANKNIFTY, `limit: 1`.
2. Rerun plan with `--expiries 'NIFTY=<all expiries comma-separated>;BANKNIFTY=<…>'`.

## 3. Fetch (one message, all calls in parallel)
- **Quote call 1 and quote call 2:** `mode: "quote"`, with exactly the instruments plan printed.
  - Each strike range expands to `<prefix><strike>CE` and `<prefix><strike>PE` for every strike from the low to the high, in the given step.
  - Both results are saved to files. Note the two file paths and do not read them.
- *(Morning, or whenever CACHE says stale)* Kite `market` with `mode: "historical"` and `interval: "day"`, for both instrument tokens, from `CANDLES_FROM` to today. The tokens are 256265 for NIFTY 50 and 260105 for NIFTY BANK.

## 4. Settle and build (one Bash call)
1. *(When you fetched candles)* Write `W/candles.json` as `{"NIFTY":[{"date":"YYYY-MM-DD","high":n,"low":n,"close":n},…],"BANKNIFTY":[…]}`. Take the first 10 characters of each candle's date.
2. *(Morning)* Settle:
   ```
   node R/analyst/run.js settle --state W/state.json --candles W/candles.json --state-out W/state2.json --out W/settle
   ```
3. Build:
   ```
   node R/analyst/prep.js build --plan W/plan.json --quotes <file1>,<file2> [--candles W/candles.json] --latest W/dump/analyst/latest.json --slot <slot> --now <ms> --out W/input.json
   ```

**If something fails:**
- **`NEEDS_VERSION col/id` (settle wrote nothing).**
  1. `get` each document named (without `out_dir`) and add its version to `versions.json`.
  2. Rerun state, then settle.
- **`MISSING <prefix>`** (that expiry did not come back from the quote call).
  1. Check the symbol with one `option_chain` call (`limit: 1`, read `strikes[0].call.tradingsymbol`).
  2. Re-quote that expiry, and add its file to `--quotes`.
- **The build lists each contract's strikes, spot and futures.** If it shows fewer than 5 contracts, say so in the phone line.

## 5. Write the settlement *(morning)*
1. For each `W/settle/batch-*.json` in order, call `ArtifactData` `batch` with `writes` = that file's array, unchanged.
2. If a batch is refused, re-dump the database (step 1's ArtifactData calls), rerun state and settle, and write again.
   - This is safe: outcomes are written last, and saved scores and post-mortems are skipped.

## 6. Events (one message, all calls in parallel)
**Calls:**
- **Every run:** one `firecrawl_search` with `query: "Nifty Bank Nifty market news today"`, `sources: ["news"]` and `limit: 3`.
- **Weekly calendar refresh:** on the morning run, when it is Monday or `EVENTS_VERIFIED` is more than 6 days old, also search:
  - `"India economic calendar this week RBI MoSPI"`
  - `"US Fed CPI jobs data this week"`

  Use `limit: 3` for both.
- **Official date check, only for an event that is new** (not in the `EVENT` lines) and high or medium impact. Run one `firecrawl_search` with `includeDomains` set to its official site and `limit: 2`. Official sites:
  - India GDP and CPI: mospi.gov.in
  - RBI: rbi.org.in
  - US CPI and jobs: bls.gov
  - US PCE and GDP: bea.gov
  - FOMC: federalreserve.gov
  - Company results: the exchange filing

  Dates already in the `EVENT` lines were verified earlier: keep them, and do not search them again.
  - If you cannot confirm a new date, add " (date unconfirmed)" to the title and drop it one impact level.
  - Even then, the trade filter still treats an unconfirmed medium event as blocking.

**Events:** up to 10 items `{title, when: "YYYY-MM-DD", impact: high|medium|low, source}`.
- **High:** can move the index more than 1% before expiry. Examples: RBI policy, FOMC, US CPI, the Union Budget, elections, a large bank's results (for Bank Nifty).
- **Remove** events that have already passed.

**Overlays:** one per key: `NIFTY-weekly`, `NIFTY-weekly2`, `NIFTY-weekly3`, `NIFTY-monthly` and `BANKNIFTY-monthly`.
- Each key counts only events on or before its own expiry.
- **`bandMult`:**
  - 1.0 with no events.
  - At most 1.05 in total for **scheduled** events, with the reason "scheduled, mostly priced". Option prices already include them.
  - Up to `eventBandMax` (1.3) only for **unscheduled** risk, such as a shock after the close or a sudden policy or geopolitical surprise. Name the evidence.
- **`nudgeSigma`:** 0 unless there is clear directional evidence not yet in prices. Then use ±0.1 to ±0.25, and say what the evidence is.
- **`reasons`:** short phrases.

## 7. Lock (one Bash call), then write
1. Write `W/research.json` as:
   ```json
   {"events":[…],"overlays":{…},"notes":"two plain sentences for Rishi","sources":["urls used"],"eventsVerifiedMs":<now ms, only if you ran the weekly calendar refresh>}
   ```
2. Run:
   ```
   node R/analyst/run.js lock --input W/input.json --research W/research.json --state <W/state2.json if the morning settle ran, else W/state.json> --out W/lock
   ```
   - On the morning run, lock also writes one paper trade per contract and prints a `TRADE …` line for each.
   - **`NEEDS_VERSION`:** `get` those documents, add their versions, rerun state and lock.
   - **`ERROR`:** write `runs/<ms>` with `status: "error"` and the message, then stop and reply `F&O <slot> FAILED: <short message>. Nothing locked.`
3. For each `W/lock/batch-*.json`, call `ArtifactData` `batch` with that file's array.

## 8. Reply (short)
**Line 1, the phone line.** Problems come first, then verdicts, then centres:
```
F&O <slot> <OK|PROBLEM: what>. <verdicts>. Nifty wk <centre> (<68% low>-<68% high>), mth <centre>; BN <centre>. <one risk>.
```
- **Verdicts:** morning only, counted from the `TRADE` lines, for example `5 NO TRADE` or `1 PAPER (Nifty wk condor), 4 NO TRADE`.
  - Name any TRADE explicitly, for example `TRADE: Nifty wk condor 25,900/26,450 - check bid/ask`.
  - Quote verdicts as printed. Never upgrade one, and never suggest sizing.
- **PROBLEM:** use it for a failed batch, fewer than 5 contracts, or no price history (`no price history - open the dashboard`).

**Then, after a blank line:**
- a compact table: contract | centre | 68% range | overlay ×, plus the verdict on the morning run
- at most two lines of notes

No other prose.
