# F&O Expiry Prediction Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows-run Python app that reads the Kite Connect option chain for Nifty weekly, Nifty monthly and Bank Nifty monthly, predicts each expiry settlement (centre + 68%/90% bands), locks a prediction 3× a day, scores itself after each expiry and re-weights its signals, calibrated first by an NSE bhavcopy back-test.

**Architecture:** One process (`python -m fo_dash run`) hosts an APScheduler (collector / reassessment / settlement jobs), a pure-Python engine (pricing → signals → prediction → learner) over a SQLite store, and a FastAPI server on `127.0.0.1:8050` serving one static dashboard page that polls `/api/state`. A separate `python -m fo_dash backtest` command downloads NSE UDiFF bhavcopies and fits the prior weights. Everything that talks to Kite or the clock is injected, so the engine and orchestrator are tested with fakes.

**Tech Stack:** Python ≥3.12, `kiteconnect`, `fastapi`, `uvicorn`, `apscheduler` 3.x, `python-dotenv`, `requests`, `tzdata`, `winotify` (Windows only), `pytest`, `httpx` (FastAPI TestClient). No numpy/scipy — normal CDF via `math.erf`.

**Spec:** `docs/superpowers/specs/2026-11-19-fo-expiry-dashboard-design.md` (approved). Read it alongside this plan.

## Global Constraints

- Read-only on Kite: no order, GTT or alert calls anywhere in the code.
- Server binds `127.0.0.1` port `8050`; Kite redirect URL is `http://127.0.0.1:8050/kite/callback`.
- All times are `Asia/Kolkata` timezone-aware (`zoneinfo.ZoneInfo("Asia/Kolkata")`); `tzdata` is a hard dependency because Windows has no system tz database.
- Underlyings are data, not code: `UNDERLYINGS` in `fo_dash/config.py`; no module other than `config.py` and `demo.py` may contain the literal `"NIFTY"` or `"BANKNIFTY"` (tests excepted); the holiday check uses `UNDERLYINGS[0].spot_symbol`.
- Expiry dates come only from the instrument master (or bhavcopy `XpryDt` in the back-test); never computed from weekdays.
- Strike window ±8% of spot; snapshot every 5 min from 09:15 to 15:30; reassessments at 09:45, 12:30, 15:05; settlement job 15:45; change thresholds NIFTY 0.003, BANKNIFTY 0.004; stale after 10 min; holiday check at 09:20; token invalid after 06:00 IST each day.
- Every prediction carries bands; the API never returns a centre without `band68` and `band90`.
- Secrets (`KITE_API_KEY`, `KITE_API_SECRET`, access token) only in `.env` / `data/`; both are git-ignored.
- Signal names, fixed order everywhere: `("forward", "max_pain", "wall_centre", "gamma_pin", "pcr", "momentum", "pivot")`.
- Days-to-expiry buckets, fixed strings: `"gt5"`, `"2to5"`, `"le1"`.

## Review Focus

1. **Laptop asleep or app closed mid-session** — on resume, the gap is logged with start/end, missed reassessments are logged as missed (never back-filled), and the dashboard shows the data time and a stale flag. Tests: Task 11 `test_gap_logged_after_sleep`, `test_missed_reassessment_logged_not_backfilled`.
2. **Not logged in / token rolled over at 06:00** — jobs skip without raising, nothing is saved, the API reports `login_needed` and panels are marked stale rather than shown as live. Tests: Task 8 `test_token_invalid_after_0600_rollover`, Task 11 `test_snapshot_job_skips_when_logged_out`, Task 12 `test_state_reports_login_needed`.
3. **Expiry day rollover and weekly = monthly coincidence** (e.g. Monday 23-Nov-2026) — both NIFTY panels point at 23-Nov until 15:30, then roll to the next weekly / monthly. Tests: Task 3 `test_coinciding_weekly_and_monthly`, `test_rolls_after_close_on_expiry_day`.
4. **Illiquid strikes** (zero bid, missing ask, LTP below intrinsic, IV solver failing) — strike's IV is skipped, ATM IV falls back to nearest valid strike, and a snapshot with fewer than 5 valid IVs is flagged `quality="low"` with bands still produced from the remaining data or omitted with an explicit reason. Tests: Task 2 `test_iv_none_below_intrinsic`, Task 5 `test_atm_iv_falls_back_and_flags_low_quality`.
5. **Market holiday on a weekday** — no snapshots, no gap entries, no "missed reassessment" noise; dashboard shows "market closed (holiday)". Tests: Task 11 `test_holiday_detected_and_jobs_noop`.

---

## File Structure

```
fo_dash/
  __init__.py
  __main__.py          # CLI: run | backtest | status
  config.py            # constants, UnderlyingConfig, Settings (.env)
  models.py            # dataclasses shared by all modules
  pricing.py           # Black-76 price, implied vol, gamma, norm cdf
  expiry.py            # current weekly/monthly expiry from instrument master
  storage.py           # SQLite Store
  kite_client.py       # TokenStore, KiteSource (wraps kiteconnect), LoginRequired
  collector.py         # strike window, symbol mapping, collect() -> ChainSnapshot
  signals.py           # compute_signals()
  predict.py           # prior weights, dte_bucket(), predict()
  reassess.py          # compare() -> changed, reason
  learner.py           # score(), refit(), track_record()
  orchestrator.py      # Orchestrator: jobs, gaps, holiday, settlement
  platform_win.py      # keep_awake(), notify() with no-op fallbacks
  backtest/
    __init__.py
    bhavcopy.py        # download(), parse()
    run.py             # build_eod_snapshots(), run_backtest()
  web/
    __init__.py
    app.py             # create_app()
    state.py           # build_state()
    static/index.html
    static/app.js
tests/
  conftest.py          # shared fixtures: IST, instruments list, sample chain
  fixtures/bhavcopy_sample.csv
  test_*.py            # one per module
requirements.txt  requirements-dev.txt  .env.example  .gitignore
setup.bat  start.bat  README.md
```

---

### Task 1: Project skeleton, config and shared models

**Files:**
- Create: `fo_dash/__init__.py`, `fo_dash/config.py`, `fo_dash/models.py`, `requirements.txt`, `requirements-dev.txt`, `.gitignore`, `.env.example`, `tests/conftest.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Produces (`config.py`):
  - `IST = ZoneInfo("Asia/Kolkata")`
  - `@dataclass(frozen=True) class UnderlyingConfig: name: str; spot_symbol: str; strike_step: int; kinds: tuple[str, ...]; change_threshold: float`
  - `UNDERLYINGS: tuple[UnderlyingConfig, ...] = (UnderlyingConfig("NIFTY", "NSE:NIFTY 50", 50, ("weekly", "monthly"), 0.003), UnderlyingConfig("BANKNIFTY", "NSE:NIFTY BANK", 100, ("monthly",), 0.004))`
  - `VIX_SYMBOL = "NSE:INDIA VIX"`, `STRIKE_WINDOW_PCT = 0.08`, `SNAPSHOT_MINUTES = 5`, `REASSESS_TIMES = (time(9,45), time(12,30), time(15,5))`, `SETTLE_TIME = time(15,45)`, `MARKET_OPEN = time(9,15)`, `MARKET_CLOSE = time(15,30)`, `HOLIDAY_CHECK = time(9,20)`, `TOKEN_ROLLOVER = time(6,0)`, `STALE_MINUTES = 10`, `HOST = "127.0.0.1"`, `PORT = 8050`
  - `SIGNAL_NAMES = ("forward","max_pain","wall_centre","gamma_pin","pcr","momentum","pivot")`, `BUCKETS = ("gt5","2to5","le1")`
  - `@dataclass class Settings: api_key: str; api_secret: str; data_dir: Path` and `load_settings(env_file: Path | None = None) -> Settings` (reads `KITE_API_KEY`, `KITE_API_SECRET`, `FO_DATA_DIR` default `./data`; creates `data_dir`).
- Produces (`models.py`):
  - `OptionQuote(strike: float, opt_type: str, ltp: float, bid: float | None, ask: float | None, volume: int, oi: int)` — `opt_type` is `"CE"` or `"PE"`.
  - `ChainSnapshot(underlying: str, kind: str, expiry: date, future_expiry: date, taken_at: datetime, spot: float, future: float, vix: float | None, options: list[OptionQuote])`
  - `Signals(forward: float, max_pain: float | None, supports: list[float], resistances: list[float], wall_centre: float | None, pcr_total: float | None, pcr_atm: float | None, atm_iv: float | None, sigma_remaining: float | None, gamma_pin: float | None, pivot: float | None, momentum_3d: float | None, oi_change: dict[tuple[float, str], int], centres: dict[str, float], iv_by_strike: dict[tuple[float, str], float], quality: str)`
  - `WeightSet(weights: dict[str, float], k68: float, k90: float, version: str, source: str)` — `source` ∈ `"prior" | "backtest" | "live"`.
  - `Prediction(underlying: str, kind: str, expiry: date, made_at: datetime, dte_bucket: str, centre: float, band68: tuple[float, float] | None, band90: tuple[float, float] | None, probs_above: dict[float, float], weights: dict[str, float], weights_version: str, signals: Signals, note: str)`
  - All models are plain `@dataclass`; add `to_dict()` / `from_dict()` on `ChainSnapshot`, `Signals`, `Prediction` (dates as ISO strings, tuple keys as `"25000|CE"`).
- `tests/conftest.py` fixtures used by later tasks: `ist_dt(y,m,d,hh,mm)` helper; `instruments` (list of dicts in `kiteconnect.instruments("NFO")` shape: keys `instrument_token, tradingsymbol, name, expiry (date), strike, lot_size, instrument_type ("CE"|"PE"|"FUT"), segment, exchange`) containing NIFTY options for expiries 2026-11-23, 2026-12-01, 2026-12-08, 2026-12-29 at strikes 23000–27800 step 50, NIFTY FUT for 2026-11-23 and 2026-12-29, BANKNIFTY options for 2026-11-23 and 2026-12-29 at 57600–67600 step 100, BANKNIFTY FUT for both; `sample_chain` (the 5-strike chain in Task 5).

- [ ] **Step 1: Write the failing tests**

```python
def test_underlyings_config():
    names = [u.name for u in UNDERLYINGS]
    assert names == ["NIFTY", "BANKNIFTY"]
    assert UNDERLYINGS[0].kinds == ("weekly", "monthly") and UNDERLYINGS[0].strike_step == 50
    assert UNDERLYINGS[1].kinds == ("monthly",) and UNDERLYINGS[1].change_threshold == 0.004

def test_load_settings_reads_env(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(f"KITE_API_KEY=k\nKITE_API_SECRET=s\nFO_DATA_DIR={tmp_path/'d'}\n")
    s = load_settings(env)
    assert (s.api_key, s.api_secret) == ("k", "s") and s.data_dir.is_dir()

def test_prediction_roundtrip(sample_prediction):
    assert Prediction.from_dict(sample_prediction.to_dict()) == sample_prediction
```

- [ ] **Step 2: Run** `pytest tests/test_config.py -v` — Expected: FAIL (`ModuleNotFoundError: fo_dash`).
- [ ] **Step 3: Implement** the files above. `requirements.txt`: `kiteconnect>=5.0`, `fastapi>=0.110`, `uvicorn>=0.29`, `apscheduler>=3.10,<4`, `python-dotenv>=1.0`, `requests>=2.31`, `tzdata`, `winotify>=1.1; sys_platform == "win32"`. `requirements-dev.txt`: `-r requirements.txt`, `pytest>=8`, `httpx>=0.27`. `.gitignore`: `.env`, `data/`, `.venv/`, `__pycache__/`. `.env.example` lists the three variables with placeholder values.
- [ ] **Step 4: Run** `pip install -r requirements-dev.txt && pytest tests/test_config.py -v` — Expected: 3 passed.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: project skeleton, config and models"`

---

### Task 2: Black-76 pricing, implied vol, gamma

**Files:** Create `fo_dash/pricing.py` · Test `tests/test_pricing.py`

**Interfaces:**
- Produces: `norm_cdf(x: float) -> float`, `norm_pdf(x: float) -> float`, `black76_price(F: float, K: float, T: float, iv: float, opt_type: str) -> float` (r = 0), `implied_vol(price: float, F: float, K: float, T: float, opt_type: str) -> float | None`, `gamma(F: float, K: float, T: float, iv: float) -> float`, `year_fraction(now: datetime, expiry: date) -> float` (calendar time to expiry 15:30 IST ÷ 365 days; floor at 1 minute).

- [ ] **Step 1: Write the failing tests**

```python
def test_atm_call_price():
    assert black76_price(100, 100, 1.0, 0.2, "CE") == pytest.approx(7.9656, abs=1e-4)

def test_put_call_parity():
    c = black76_price(25200, 25000, 0.02, 0.14, "CE"); p = black76_price(25200, 25000, 0.02, 0.14, "PE")
    assert c - p == pytest.approx(200, abs=1e-6)

def test_iv_roundtrip():
    px = black76_price(25200, 25400, 0.015, 0.15, "CE")
    assert implied_vol(px, 25200, 25400, 0.015, "CE") == pytest.approx(0.15, abs=1e-4)

def test_iv_none_below_intrinsic():
    assert implied_vol(150, 25200, 25000, 0.01, "CE") is None   # intrinsic is 200
    assert implied_vol(0, 25200, 25400, 0.01, "CE") is None

def test_gamma_peaks_at_the_money():
    g = [gamma(25200, k, 0.02, 0.14) for k in (24800, 25200, 25600)]
    assert g[1] > g[0] and g[1] > g[2]

def test_year_fraction_to_expiry_close():
    assert year_fraction(ist_dt(2026,11,23,9,30), date(2026,11,23)) == pytest.approx(6/24/365, rel=1e-6)
```

- [ ] **Step 2: Run** `pytest tests/test_pricing.py -v` — Expected: FAIL (import error).
- [ ] **Step 3: Implement.** `implied_vol` uses bisection on iv ∈ [0.01, 3.0] to tolerance 1e-6 / max 100 iterations; return `None` if `price <= 0`, `price < intrinsic - 1e-9`, or price above the iv=3.0 value.
- [ ] **Step 4: Run** `pytest tests/test_pricing.py -v` — Expected: 6 passed.
- [ ] **Step 5: Commit** `git commit -am "feat: Black-76 pricing and implied vol"` (add new files first).

---

### Task 3: Expiry selection from the instrument master

**Files:** Create `fo_dash/expiry.py` · Test `tests/test_expiry.py`

**Interfaces:**
- Consumes: `UnderlyingConfig`, `MARKET_CLOSE`, conftest `instruments`.
- Produces: `select_expiries(instruments: list[dict], cfg: UnderlyingConfig, now: datetime) -> dict[str, date]` — keys are exactly `cfg.kinds`. An expiry is "live" if `expiry > now.date()` or (`expiry == now.date()` and `now.time() < MARKET_CLOSE`). `weekly` = earliest live option expiry for `cfg.name`; `monthly` = earliest live `FUT` expiry for `cfg.name` (monthly options and futures share expiry). `future_expiry_for(instruments, cfg, option_expiry: date) -> date` = earliest FUT expiry ≥ `option_expiry`.

- [ ] **Step 1: Write the failing tests**

```python
NIFTY, BANK = UNDERLYINGS

def test_coinciding_weekly_and_monthly(instruments):
    assert select_expiries(instruments, NIFTY, ist_dt(2026,11,19,13,0)) == {"weekly": date(2026,11,23), "monthly": date(2026,11,23)}

def test_still_current_during_expiry_day(instruments):
    assert select_expiries(instruments, NIFTY, ist_dt(2026,11,23,15,0))["weekly"] == date(2026,11,23)

def test_rolls_after_close_on_expiry_day(instruments):
    assert select_expiries(instruments, NIFTY, ist_dt(2026,11,23,15,31)) == {"weekly": date(2026,12,1), "monthly": date(2026,12,29)}

def test_banknifty_monthly_only(instruments):
    assert select_expiries(instruments, BANK, ist_dt(2026,11,19,13,0)) == {"monthly": date(2026,11,23)}

def test_future_for_weekly(instruments):
    assert future_expiry_for(instruments, NIFTY, date(2026,12,8)) == date(2026,12,29)
```

- [ ] **Step 2: Run** `pytest tests/test_expiry.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** `select_expiries` and `future_expiry_for` (filter on `name == cfg.name`).
- [ ] **Step 4: Run** — Expected: 5 passed.
- [ ] **Step 5: Commit** `git commit -m "feat: expiry selection from instrument master"`

---

### Task 4: SQLite store

**Files:** Create `fo_dash/storage.py` · Test `tests/test_storage.py`

**Interfaces:**
- Consumes: models from Task 1.
- Produces `class Store(path: Path)` (creates schema on init; `:memory:` allowed):
  - `save_snapshot(s: ChainSnapshot) -> int`; `latest_snapshot(underlying: str, kind: str, expiry: date) -> ChainSnapshot | None`; `last_snapshot_time(day: date) -> datetime | None`; `snapshots_on(day: date) -> int`
  - `oi_before(underlying: str, expiry: date, before: datetime) -> dict[tuple[float, str], int]` — OI by (strike, type) from the latest snapshot strictly before `before`, any kind (empty dict if none).
  - `save_prediction(p: Prediction, locked: bool, changed: bool, reason: str) -> int`
  - `predictions(underlying: str, kind: str, expiry: date, locked_only: bool = True) -> list[LoggedPrediction]` ordered by `made_at`; `last_locked(underlying, kind, expiry) -> LoggedPrediction | None`; `latest_prediction(underlying, kind, expiry) -> LoggedPrediction | None` (locked or not)
  - `@dataclass class LoggedPrediction: prediction: Prediction; locked: bool; changed: bool; reason: str`
  - `locked_times(day: date) -> set[time]` — HH:MM of locked predictions that day.
  - `save_outcome(underlying: str, expiry: date, settlement: float) -> None`; `outcome(underlying, expiry) -> float | None`
  - `save_scores(rows: list[ScoreRow]) -> None`; `scores(underlying: str, bucket: str | None = None, last_n_expiries: int | None = None) -> list[ScoreRow]` (`ScoreRow` from Task 9 — define the table now: `underlying, kind, expiry, made_at, bucket, centre, sigma, settlement, err_pct, in68, in90, signal_errs_json, forward_err_pct`)
  - `save_weights(underlying: str, bucket: str, ws: WeightSet, created_at: datetime) -> None`; `current_weights(underlying: str, bucket: str) -> WeightSet | None` (latest); `weights_history(underlying: str) -> list[tuple[datetime, str, WeightSet]]`
  - `log_gap(start: datetime, end: datetime | None, what: str) -> None`; `gaps(day: date) -> list[tuple[datetime, datetime | None, str]]`
  - `set_day_status(day: date, status: str) -> None` / `day_status(day: date) -> str | None` (`"trading"` | `"holiday"`)
- Snapshot/prediction bodies stored as JSON via `to_dict()`; index columns for lookups. Use one `sqlite3` connection with `check_same_thread=False` and a `threading.Lock` around writes (scheduler and web threads share it).

- [ ] **Step 1: Write the failing tests** — roundtrip each pair (`save_snapshot`/`latest_snapshot`, `save_prediction`/`predictions`, `save_weights`/`current_weights` returns the newest of two, `log_gap`/`gaps`, `set_day_status`/`day_status`), plus:

```python
def test_oi_before_uses_previous_snapshot(store, sample_chain):
    a = replace(sample_chain, taken_at=ist_dt(2026,11,18,15,25))
    b = replace(sample_chain, taken_at=ist_dt(2026,11,19,10,0), options=[replace(o, oi=o.oi + 10) for o in sample_chain.options])
    store.save_snapshot(a); store.save_snapshot(b)
    oi = store.oi_before("NIFTY", sample_chain.expiry, ist_dt(2026,11,19,9,15))
    assert oi[(25300.0, "CE")] == 800
```

- [ ] **Step 2: Run** `pytest tests/test_storage.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** `Store`.
- [ ] **Step 4: Run** — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "feat: SQLite store"`

---

### Task 5: Signals

**Files:** Create `fo_dash/signals.py` · Test `tests/test_signals.py`

**Interfaces:**
- Consumes: `ChainSnapshot`, `pricing.*`.
- Produces: `compute_signals(snap: ChainSnapshot, oi_prev_close: dict[tuple[float,str],int], prev_day_hlc: tuple[float,float,float] | None, close_3d_ago: float | None) -> Signals`.

Definitions (spec §6.3; the parts the signature doesn't determine):
- `T = year_fraction(snap.taken_at, snap.expiry)`, `T_f = year_fraction(snap.taken_at, snap.future_expiry)`; **forward** = `snap.future` if expiries equal, else `spot + (future - spot) * T / T_f`.
- **max_pain**: over the chain's strikes K, minimise `Σ_CE oi·max(0, K−k) + Σ_PE oi·max(0, k−K)`; ties → strike nearest forward.
- **supports**: PE strikes `< spot` sorted by OI desc, top 3; **resistances**: CE strikes `> spot` sorted by OI desc, top 3. **wall_centre** = OI-weighted mean of `supports[0]` and `resistances[0]` (None if either missing).
- **pcr_total** = ΣPE oi / ΣCE oi; **pcr_atm** = same over the 11 strikes nearest forward.
- **IV per strike**: price = mid of bid/ask when both > 0 and `(ask−bid) ≤ 0.2·mid`, else LTP; `implied_vol` on that; skip None. **atm_iv** = mean of CE and PE IV at the strike nearest forward, else the nearest strike with any valid IV. **sigma_remaining** = `forward · atm_iv · sqrt(T)`.
- **gamma_pin**: among strikes within `forward ± 2·sigma_remaining`, argmax of `(oi_CE + oi_PE) · gamma(forward, K, T, iv_K)` where `iv_K` falls back to `atm_iv`.
- **pivot** = `(H + L + C) / 3` from `prev_day_hlc`; **momentum_3d** = `spot / close_3d_ago − 1`.
- **oi_change** = current OI − `oi_prev_close` per (strike, type) present in both.
- **centres** (only for signals that exist): `forward`; `max_pain`; `wall_centre`; `gamma_pin`; `pcr` = `forward + clamp(pcr_atm − 1, −0.5, 0.5) · 0.5 · sigma_remaining`; `momentum` = `forward · (1 + 0.5·momentum_3d)` clamped to `forward ± sigma_remaining`; `pivot`.
- **quality** = `"low"` if fewer than 5 strikes have a valid IV or `atm_iv is None`, else `"ok"`.

`sample_chain` (conftest): NIFTY monthly, expiry = future_expiry = 2026-11-23, taken 2026-11-19 13:00, spot 25180, future 25200, strikes 25000–25400 step 100; CE OI 100, 200, 300, 800, 500; PE OI 600, 700, 400, 200, 100; option prices = `black76_price(25200, K, T, 0.14, type)` rounded to 0.05 with bid = price − 0.5, ask = price + 0.5.

- [ ] **Step 1: Write the failing tests**

```python
def test_oi_structure(sample_chain):
    s = compute_signals(sample_chain, {}, None, None)
    assert s.forward == 25200
    assert s.max_pain == 25200
    assert s.supports == [25100, 25000]
    assert s.resistances == [25300, 25400, 25200]
    assert s.wall_centre == pytest.approx(25206.67, abs=0.01)
    assert s.pcr_total == pytest.approx(2000 / 1900, abs=1e-4)

def test_atm_iv_and_sigma(sample_chain):
    s = compute_signals(sample_chain, {}, None, None)
    assert s.atm_iv == pytest.approx(0.14, abs=0.005)
    assert s.sigma_remaining == pytest.approx(25200 * s.atm_iv * math.sqrt(year_fraction(sample_chain.taken_at, sample_chain.expiry)), rel=1e-6)
    assert s.quality == "ok"

def test_weekly_forward_scales_basis(sample_chain):
    snap = replace(sample_chain, kind="weekly", future_expiry=date(2026,12,29))
    s = compute_signals(snap, {}, None, None)
    assert 25180 < s.forward < 25200

def test_oi_change_and_pivot(sample_chain):
    s = compute_signals(sample_chain, {(25300.0, "CE"): 500}, (25400, 25100, 25228), 25000)
    assert s.oi_change[(25300.0, "CE")] == 300
    assert s.pivot == pytest.approx(25242.67, abs=0.01)
    assert s.momentum_3d == pytest.approx(0.0072, abs=1e-4)

def test_atm_iv_falls_back_and_flags_low_quality(sample_chain):
    bad = [replace(o, bid=0, ask=None, ltp=0) if o.strike != 25400 else o for o in sample_chain.options]
    s = compute_signals(replace(sample_chain, options=bad), {}, None, None)
    assert s.atm_iv is not None and s.quality == "low"
```

- [ ] **Step 2: Run** `pytest tests/test_signals.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** `compute_signals` per the definitions above.
- [ ] **Step 4: Run** — Expected: 5 passed.
- [ ] **Step 5: Commit** `git commit -m "feat: option-chain signals"`

---

### Task 6: Prediction (blend, bands, probabilities)

**Files:** Create `fo_dash/predict.py` · Test `tests/test_predict.py`

**Interfaces:**
- Consumes: `Signals`, `WeightSet`, `norm_cdf`.
- Produces:
  - `PRIOR: dict[str, WeightSet]` keyed by bucket, `source="prior"`, `version="uncalibrated"`, `k68=1.0`, `k90=1.645`, weights:
    - `gt5`: forward .60, max_pain .10, wall_centre .10, gamma_pin .05, pcr .05, momentum .05, pivot .05
    - `2to5`: forward .45, max_pain .15, wall_centre .15, gamma_pin .10, pcr .05, momentum .05, pivot .05
    - `le1`: forward .35, max_pain .20, wall_centre .20, gamma_pin .15, pcr .05, momentum .025, pivot .025
  - `dte_bucket(today: date, expiry: date) -> str` — count weekdays d with `today < d ≤ expiry`; 0–1 → `"le1"`, 2–5 → `"2to5"`, else `"gt5"`.
  - `predict(underlying: str, kind: str, expiry: date, made_at: datetime, signals: Signals, ws: WeightSet) -> Prediction` — centre = Σ wᵢ·centreᵢ / Σ wᵢ over signals present in `signals.centres`; bands = centre ± k·sigma_remaining; `probs_above[K] = 1 − Φ((K − centre)/(k68·sigma_remaining))` for K in supports ∪ resistances ∪ {max_pain}; if `sigma_remaining` is None: `band68 = band90 = None`, `probs_above = {}`, `note = "no implied volatility — range unavailable"`; `weights` is the renormalised set actually used; `note` also carries `"uncalibrated"` when `ws.source == "prior"`.

- [ ] **Step 1: Write the failing tests**

```python
def test_dte_buckets():
    assert dte_bucket(date(2026,11,19), date(2026,11,23)) == "2to5"
    assert dte_bucket(date(2026,11,20), date(2026,11,23)) == "le1"
    assert dte_bucket(date(2026,11,23), date(2026,11,23)) == "le1"
    assert dte_bucket(date(2026,11,12), date(2026,11,23)) == "gt5"

def test_prior_weights_sum_to_one():
    for ws in PRIOR.values():
        assert sum(ws.weights.values()) == pytest.approx(1.0)

def test_blend_renormalises_and_bands(make_signals):
    sig = make_signals(centres={"forward": 25000, "max_pain": 25200}, sigma_remaining=200, supports=[25000], resistances=[25300], max_pain=25200)
    ws = WeightSet({"forward": .5, "max_pain": .5, "wall_centre": .2}, 1.0, 1.645, "v", "live")
    p = predict("NIFTY", "weekly", date(2026,11,23), ist_dt(2026,11,19,12,30), sig, ws)
    assert p.centre == pytest.approx(25100)
    assert p.band68 == pytest.approx((24900, 25300)) and p.band90 == pytest.approx((24771, 25429))
    assert p.probs_above[25300] == pytest.approx(0.1587, abs=1e-4)
    assert p.weights == pytest.approx({"forward": .5, "max_pain": .5})

def test_no_iv_means_no_bands_and_explicit_note(make_signals):
    p = predict("NIFTY", "weekly", date(2026,11,23), ist_dt(2026,11,19,12,30), make_signals(centres={"forward": 25000}, sigma_remaining=None), PRIOR["2to5"])
    assert p.band68 is None and "range unavailable" in p.note and "uncalibrated" in p.note
```

(`make_signals` is a conftest factory returning a `Signals` with defaults for omitted fields.)

- [ ] **Step 2: Run** `pytest tests/test_predict.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: 4 passed.
- [ ] **Step 5: Commit** `git commit -m "feat: prediction blend and bands"`

---

### Task 7: Reassessment comparison and reason text

**Files:** Create `fo_dash/reassess.py` · Test `tests/test_reassess.py`

**Interfaces:**
- Produces: `compare(prev: Prediction | None, cur: Prediction, threshold: float) -> tuple[bool, str]`. Changed if `prev is None`, or `|cur.centre − prev.centre| / prev.centre > threshold`, or `supports[0]` or `resistances[0]` differ. Reason joins (with `"; "`) every item that differs, in this order and format, numbers with Indian-style thousands commas and no decimals except PCR (2 dp): `centre 25,300 → 25,400`, `put wall 25,000 → 25,300`, `call wall 25,500 → 25,600`, `PCR 0.92 → 1.15` (PCR item only when |Δ| ≥ 0.05). `prev is None` → `(True, "first prediction of the series")`. Unchanged → `(False, "no material change")`.
- Produces: `fmt_level(x: float) -> str` (e.g. `25,300`, `1,02,500` for ≥ 1 lakh) for reuse by the UI state.

- [ ] **Step 1: Write the failing tests**

```python
def test_first_prediction(pred):
    assert compare(None, pred(25300), 0.003) == (True, "first prediction of the series")

def test_small_move_unchanged(pred):
    assert compare(pred(25300), pred(25350), 0.003) == (False, "no material change")

def test_centre_move_changed(pred):
    changed, reason = compare(pred(25300), pred(25400), 0.003)
    assert changed and reason == "centre 25,300 → 25,400"

def test_wall_shift_changed_even_if_centre_flat(pred):
    changed, reason = compare(pred(25300, support=25000, pcr=0.92), pred(25320, support=25300, pcr=1.15), 0.003)
    assert changed and reason == "centre 25,300 → 25,320; put wall 25,000 → 25,300; PCR 0.92 → 1.15"

def test_fmt_level_indian_grouping():
    assert fmt_level(62627.75) == "62,628" and fmt_level(102500) == "1,02,500"
```

(`pred` is a local factory building a `Prediction` with the given centre, `supports=[support]`, `resistances=[25500]`, `pcr_atm=pcr`.)

- [ ] **Step 2–4:** run (FAIL) → implement → run (5 passed).
- [ ] **Step 5: Commit** `git commit -m "feat: reassessment comparison and reasons"`

---

### Task 8: Kite client, token store and chain collector

**Files:** Create `fo_dash/kite_client.py`, `fo_dash/collector.py` · Test `tests/test_kite_client.py`, `tests/test_collector.py`

**Interfaces:**
- Produces (`kite_client.py`):
  - `class LoginRequired(Exception)`
  - `class TokenStore(path: Path)`: `save(token: str, now: datetime) -> None`; `load(now: datetime) -> str | None` — returns None if no file or the token was saved before the most recent 06:00 IST at or before `now`.
  - `class KiteSource(kite, token_store: TokenStore, api_secret: str, now_fn: Callable[[], datetime], sleep_fn=time.sleep)` where `kite` is a `kiteconnect.KiteConnect` (tests pass a fake with the same methods):
    - `login_url() -> str`; `complete_login(request_token: str) -> None` (calls `kite.generate_session(request_token, api_secret=...)`, saves `access_token`, calls `kite.set_access_token`)
    - `is_logged_in() -> bool` (token loads → `set_access_token`, True)
    - `instruments(exchange: str = "NFO") -> list[dict]`
    - `quote(symbols: list[str]) -> dict[str, dict]` — chunks of 500, ≥1.0 s between calls via `sleep_fn`
    - `daily_candles(instrument_token: int, days: int) -> list[dict]` (`historical_data(..., "day")`)
    - Any `kiteconnect.exceptions.TokenException`, or no valid token, raises `LoginRequired`.
- Produces (`collector.py`):
  - `strike_window(spot: float, step: int, pct: float = STRIKE_WINDOW_PCT) -> list[float]` — multiples of `step` within `[spot·(1−pct), spot·(1+pct)]`.
  - `option_symbols(instruments: list[dict], name: str, expiry: date, strikes: list[float]) -> dict[str, tuple[float, str]]` — `"NFO:<tradingsymbol>" → (strike, "CE"|"PE")`.
  - `future_symbol(instruments, name: str, future_expiry: date) -> str`
  - `collect(source: KiteSource, cfg: UnderlyingConfig, kind: str, expiry: date, future_expiry: date, instruments: list[dict], now: datetime) -> ChainSnapshot` — one `quote()` call covering spot, VIX, future and all option symbols; bid/ask from `depth.buy[0].price` / `depth.sell[0].price` (0 → None); spot strike window uses the quoted spot.

- [ ] **Step 1: Write the failing tests**

```python
def test_token_invalid_after_0600_rollover(tmp_path):
    ts = TokenStore(tmp_path / "token.json"); ts.save("abc", ist_dt(2026,11,19,9,0))
    assert ts.load(ist_dt(2026,11,19,23,0)) == "abc"
    assert ts.load(ist_dt(2026,11,20,5,59)) == "abc"
    assert ts.load(ist_dt(2026,11,20,6,0)) is None

def test_quote_batches_500_and_rate_limits(fake_kite, tmp_path):
    sleeps = []
    src = make_source(fake_kite, tmp_path, sleep_fn=sleeps.append, logged_in=True)
    src.quote([f"NFO:X{i}" for i in range(1200)])
    assert [len(c) for c in fake_kite.quote_calls] == [500, 500, 200] and len(sleeps) == 2

def test_token_exception_becomes_login_required(fake_kite, tmp_path):
    fake_kite.raise_token_error = True
    with pytest.raises(LoginRequired):
        make_source(fake_kite, tmp_path, logged_in=True).quote(["NSE:NIFTY 50"])

def test_strike_window():
    w = strike_window(25371, 50)
    assert w[0] == 23350 and w[-1] == 27400 and all(k % 50 == 0 for k in w)

def test_collect_builds_snapshot(fake_kite, tmp_path, instruments):
    snap = collect(make_source(fake_kite, tmp_path, logged_in=True), UNDERLYINGS[0], "weekly", date(2026,11,23), date(2026,11,23), instruments, ist_dt(2026,11,19,13,0))
    assert snap.spot == 25371.1 and snap.future == 25397 and snap.vix == 16.25
    assert {o.opt_type for o in snap.options} == {"CE", "PE"} and len(snap.options) == 2 * len(strike_window(25371.1, 50))
```

(`fake_kite` in conftest: records `quote_calls`, returns quotes in the `kiteconnect` shape — `last_price`, `volume`, `oi`, `ohlc`, `timestamp`, `depth{buy,sell}[{price,quantity,orders}]` — with NIFTY 50 at 25371.1, NIFTY26NOVFUT at 25397, INDIA VIX 16.25, options priced via `black76_price`, OI 1,00,000 per strike.)

- [ ] **Step 2: Run** `pytest tests/test_kite_client.py tests/test_collector.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** — Expected: 5 passed.
- [ ] **Step 5: Commit** `git commit -m "feat: Kite client, token store, chain collector"`

---

### Task 9: Scoring and learning

**Files:** Create `fo_dash/learner.py` · Test `tests/test_learner.py`

**Interfaces:**
- Produces:
  - `@dataclass class ScoreRow: underlying: str; kind: str; expiry: date; made_at: datetime; bucket: str; centre: float; sigma: float | None; settlement: float; err_pct: float; in68: bool | None; in90: bool | None; signal_errs: dict[str, float]; forward_err_pct: float` — errors are signed % of settlement: `(predicted − settlement) / settlement · 100`; `signal_errs[name]` uses that signal's centre.
  - `score(locked: list[Prediction], settlement: float) -> list[ScoreRow]` — `in68 = |settlement − centre| ≤ (band68 half-width)`; `None` when bands absent.
  - `refit(rows: list[ScoreRow], prior: WeightSet, lam: float = 10.0, now: datetime) -> WeightSet` — rows for one underlying and one bucket. `n` = number of distinct expiries in rows. Data weights ∝ `1 / (mean(err²) + 0.01)` per signal over rows where that signal exists; final weight = `(n/(n+lam))·data + (lam/(n+lam))·prior`, renormalised; signals with no data keep prior share. Band multipliers: `z = |settlement − centre| / sigma` over rows with sigma; if ≥ 5 rows, `k68_data` = 68th percentile of z, `k90_data` = 90th; shrink to prior with the same `n/(n+lam)`; else keep prior k. Result `source="live"`, `version=f"live-{now:%Y%m%d%H%M}"`. If `prior.source == "backtest"` the shrinkage target is the back-test set (that is the "prior").
  - `track_record(rows: list[ScoreRow]) -> dict` — keys: `expiries` (count), `mean_abs_err_pct`, `forward_mean_abs_err_pct`, `within_0_5pct`, `within_1pct` (fractions), `cov68`, `cov90` (fractions over rows with bands), `beats_baseline` (`mean_abs_err_pct < forward_mean_abs_err_pct`), `last10` (list of per-expiry dicts using the last locked prediction of each expiry: expiry, centre, settlement, err_pct, in68).

- [ ] **Step 1: Write the failing tests**

```python
def test_score_marks_band_hits(locked_preds):
    rows = score(locked_preds(centre=25300, band68=(25100, 25500)), settlement=25450)
    assert rows[0].in68 is True and rows[0].err_pct == pytest.approx((25300 - 25450) / 25450 * 100)

def test_refit_shrinks_toward_prior(score_rows):
    prior = WeightSet({"forward": .5, "max_pain": .5}, 1.0, 1.645, "uncalibrated", "prior")
    rows = score_rows(n_expiries=10, errs={"forward": 0.4, "max_pain": 0.2})   # % errors, constant
    ws = refit(rows, prior, lam=10, now=ist_dt(2026,11,23,15,45))
    # data weights: 1/(0.16+0.01) vs 1/(0.04+0.01) -> 0.2273 / 0.7727; half-way to prior
    assert ws.weights["max_pain"] == pytest.approx(0.5 * 0.7727 + 0.25, abs=1e-3)
    assert sum(ws.weights.values()) == pytest.approx(1.0) and ws.source == "live"

def test_single_expiry_cannot_swing_weights(score_rows):
    prior = WeightSet({"forward": .5, "max_pain": .5}, 1.0, 1.645, "uncalibrated", "prior")
    ws = refit(score_rows(n_expiries=1, errs={"forward": 5.0, "max_pain": 0.0}), prior, lam=10, now=ist_dt(2026,11,23,15,45))
    assert abs(ws.weights["max_pain"] - 0.5) <= 0.5 / 11 + 1e-9

def test_bands_keep_prior_below_five_rows(score_rows):
    prior = WeightSet({"forward": 1.0}, 1.0, 1.645, "uncalibrated", "prior")
    ws = refit(score_rows(n_expiries=3, errs={"forward": 1.0}), prior, now=ist_dt(2026,11,23,15,45))
    assert (ws.k68, ws.k90) == (1.0, 1.645)

def test_track_record_baseline_flag(score_rows):
    tr = track_record(score_rows(n_expiries=4, errs={"forward": 0.6}, model_err=0.9))
    assert tr["beats_baseline"] is False and tr["expiries"] == 4
```

- [ ] **Step 2–4:** run (FAIL) → implement → run (5 passed).
- [ ] **Step 5: Commit** `git commit -m "feat: scoring and shrinkage learner"`

---

### Task 10: NSE bhavcopy back-test

**Files:** Create `fo_dash/backtest/__init__.py`, `fo_dash/backtest/bhavcopy.py`, `fo_dash/backtest/run.py`, `tests/fixtures/bhavcopy_sample.csv` · Test `tests/test_backtest.py`

**Interfaces:**
- Produces (`bhavcopy.py`):
  - `URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip"`
  - `download(day: date, cache_dir: Path, session: requests.Session) -> Path | None` — cached zip if present; else GET with a desktop browser `User-Agent` and `Referer: https://www.nseindia.com/`; 404 → None (holiday); other errors retry 3× with 2 s back-off then raise; caller enforces ≥1 s between requests.
  - `@dataclass class BhavRow: trade_date: date; symbol: str; instr: str ("IDO"|"IDF"); expiry: date; strike: float | None; opt_type: str | None; close: float; settle: float; underlying: float; oi: int; volume: int`
  - `parse(path: Path, symbols: set[str]) -> list[BhavRow]` — reads the CSV (inside a zip or plain); UDiFF columns used: `TradDt, TckrSymb, FinInstrmTp, XpryDt, StrkPric, OptnTp, ClsPric, SttlmPric, UndrlygPric, OpnIntrst, TtlTradgVol`; keeps only `FinInstrmTp ∈ {IDO, IDF}` and `TckrSymb ∈ symbols`.
- Produces (`run.py`):
  - `build_eod_snapshots(rows: list[BhavRow], cfg: UnderlyingConfig, kind: str) -> list[ChainSnapshot]` — for one trade date: `taken_at` = trade date 15:30 IST; `spot` = `UndrlygPric`; `future` = IDF `ClsPric` for the nearest future ≥ the option expiry; options' `ltp` = `ClsPric`, bid/ask None; `kind == "monthly"` → only expiries that have an IDF row; `"weekly"` → the nearest option expiry. Only the current (nearest live) expiry of that kind.
  - `run_backtest(store: Store, start: date, end: date, cache_dir: Path, session: requests.Session, sleep_fn=time.sleep) -> dict` — per weekday: download, parse, build snapshots for every (cfg, kind) in `UNDERLYINGS`, `compute_signals` (prev-close OI from the prior trade day's rows; `prev_day_hlc=None` because bhavcopy has no index high/low, so `pivot` is absent in the back-test; `close_3d_ago` from `UndrlygPric` three trade days back), `predict` with `PRIOR[bucket]`; settlement for an expiry = `UndrlygPric` on the expiry date; `score` all EOD predictions; `refit` per underlying per bucket with `lam=0` against `PRIOR`; save each result with `source="backtest"`, `version=f"backtest-{end:%Y%m%d}"`; returns `{"days": int, "expiries": {underlying: int}, "track_record": {underlying: dict}, "skipped_days": int}`.
- Fixture `bhavcopy_sample.csv`: real UDiFF header, two trade dates (2026-11-19, 2026-11-23) with NIFTY IDO rows for the 2026-11-23 expiry at strikes 25000–25400 (CE/PE), one NIFTY IDF row, plus a RELIANCE STO row and a BANKNIFTY IDO row to prove filtering.

- [ ] **Step 1: Write the failing tests**

```python
def test_parse_filters_symbols_and_types():
    rows = parse(FIXTURES / "bhavcopy_sample.csv", {"NIFTY"})
    assert {r.symbol for r in rows} == {"NIFTY"} and {r.instr for r in rows} == {"IDO", "IDF"}
    ce = next(r for r in rows if r.strike == 25300 and r.opt_type == "CE" and r.trade_date == date(2026,11,19))
    assert ce.oi > 0 and ce.underlying > 0

def test_eod_snapshot_shape():
    rows = [r for r in parse(FIXTURES / "bhavcopy_sample.csv", {"NIFTY"}) if r.trade_date == date(2026,11,19)]
    (snap,) = build_eod_snapshots(rows, UNDERLYINGS[0], "monthly")
    assert snap.expiry == date(2026,11,23) and snap.taken_at == ist_dt(2026,11,19,15,30) and len(snap.options) == 10

def test_run_backtest_with_cached_files(tmp_path, store):
    cache = tmp_path / "cache"; cache.mkdir()
    write_fixture_as_daily_zips(FIXTURES / "bhavcopy_sample.csv", cache)   # helper in test file
    report = run_backtest(store, date(2026,11,19), date(2026,11,23), cache, session=OfflineSession(), sleep_fn=lambda s: None)
    assert report["expiries"]["NIFTY"] == 1
    assert store.current_weights("NIFTY", "2to5").source == "backtest"

def test_download_404_is_holiday(tmp_path):
    assert download(date(2026,11,24), tmp_path, FakeSession(status=404)) is None
```

- [ ] **Step 2: Run** `pytest tests/test_backtest.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** the modules and fixture (build fixture prices with `black76_price` so the IVs are sane).
- [ ] **Step 4: Run** — Expected: 4 passed.
- [ ] **Step 5: Commit** `git commit -m "feat: NSE bhavcopy back-test"`

---

### Task 11: Orchestrator and scheduling

**Files:** Create `fo_dash/orchestrator.py`, `fo_dash/platform_win.py` · Test `tests/test_orchestrator.py`

**Interfaces:**
- Consumes: everything above.
- Produces (`platform_win.py`): `keep_awake(on: bool) -> None` (Windows: `ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)` / `0x80000000` to release; no-op elsewhere); `notify(title: str, body: str) -> None` (`winotify` on Windows; log only elsewhere).
- Produces (`orchestrator.py`):
  - `class Orchestrator(store: Store, source: KiteSource, now_fn: Callable[[], datetime], notify_fn=notify, keep_awake_fn=keep_awake)`
  - `status: dict` — `{"login": "ok"|"login_needed", "day": "trading"|"holiday"|"unknown", "last_error": str | None}`
  - `panels() -> list[tuple[UnderlyingConfig, str]]` — `[(cfg, kind) for cfg in UNDERLYINGS for kind in cfg.kinds]`
  - `morning_setup() -> None` — at/after 09:15: load instruments, `select_expiries` per cfg, cache `future_expiry_for`; at/after 09:20, if the `UNDERLYINGS[0].spot_symbol` quote `timestamp` date ≠ today → `store.set_day_status(today, "holiday")`, else `"trading"`. Fetch prev-day HLC and close 3 trade days back per underlying via `daily_candles`.
  - `snapshot_job() -> None` — no-op outside 09:15–15:30, on holiday, or if logged out (sets `status["login"]`). If the previous snapshot today is older than `2 × SNAPSHOT_MINUTES`, `log_gap(prev, now, "snapshots")` (also at first snapshot of the day if it is after 09:30: gap from 09:15). For each panel: `collect` → `save_snapshot` → `compute_signals` (`oi_prev_close = store.oi_before(name, expiry, today 09:15)`) → `predict` with `store.current_weights(name, bucket) or PRIOR[bucket]` → `save_prediction(locked=False, changed=False, reason="")`. Panels sharing (underlying, expiry) reuse one collected snapshot.
  - `reassess_job(slot: time) -> None` — skip if holiday / logged out (log gap `"missed reassessment HH:MM"` when logged out); run `snapshot_job()` first; for each panel compare against `store.last_locked`, save locked with `(changed, reason)`; `notify_fn` once per changed (underlying, expiry) — panels sharing an expiry notify once — with title `"<UNDERLYING> <kind> <expiry dd-Mon>"` and the reason as body.
  - `check_missed_reassessments() -> None` — for each slot in `REASSESS_TIMES` that is more than 5 min past and not in `store.locked_times(today)`, and not already logged, log gap `"missed reassessment HH:MM"`; no-op on holidays and before `morning_setup`; never creates predictions.
  - `settle_job() -> None` — for each panel whose expiry == today: settlement = today's daily candle close of the index (`daily_candles(token, 1)`); `save_outcome`; `score` all locked predictions for that expiry → `save_scores`; for each bucket present, `refit(store.scores(name, bucket, last_n_expiries=20), prior=<latest backtest WeightSet or PRIOR[bucket]>)` → `save_weights`.
  - `start() -> BackgroundScheduler` — APScheduler, `timezone=IST`, `coalesce=True`, `misfire_grace_time=60`: `morning_setup` cron mon–fri 09:15 and 09:20 plus once on start; `snapshot_job` cron mon–fri `minute="*/5"` hours 9–15; `reassess_job` cron at each `REASSESS_TIMES`; `check_missed_reassessments` every 5 min; `settle_job` at `SETTLE_TIME`; `keep_awake_fn(True)` at 09:10, `False` at 15:50 (and set immediately on start if within that window).

- [ ] **Step 1: Write the failing tests** (fake source + mutable fake clock fixture `clock`; `orch` fixture wires them with an in-memory `Store`)

```python
def test_snapshot_job_skips_when_logged_out(orch, clock, store):
    orch.source.logged_in = False; clock.set(2026,11,19,10,0)
    orch.snapshot_job()
    assert orch.status["login"] == "login_needed" and store.last_snapshot_time(date(2026,11,19)) is None

def test_snapshot_job_saves_three_panels_two_snapshots(orch, clock, store):
    clock.set(2026,11,19,10,0); orch.morning_setup(); orch.snapshot_job()
    assert store.latest_prediction("NIFTY", "weekly", date(2026,11,23)) is not None
    assert store.latest_prediction("BANKNIFTY", "monthly", date(2026,11,23)) is not None
    assert store.snapshots_on(date(2026,11,19)) == 2   # NIFTY weekly==monthly shares one snapshot

def test_gap_logged_after_sleep(orch, clock, store):
    clock.set(2026,11,19,10,0); orch.morning_setup(); orch.snapshot_job()
    clock.set(2026,11,19,11,30); orch.snapshot_job()
    assert (ist_dt(2026,11,19,10,0), ist_dt(2026,11,19,11,30), "snapshots") in store.gaps(date(2026,11,19))

def test_missed_reassessment_logged_not_backfilled(orch, clock, store):
    clock.set(2026,11,19,13,0); orch.morning_setup(); orch.check_missed_reassessments()
    whats = [g[2] for g in store.gaps(date(2026,11,19))]
    assert "missed reassessment 09:45" in whats and "missed reassessment 12:30" in whats
    assert store.predictions("NIFTY", "weekly", date(2026,11,23), locked_only=True) == []

def test_reassess_locks_and_notifies_on_change(orch, clock, store, notes):
    clock.set(2026,11,19,9,45); orch.morning_setup(); orch.reassess_job(time(9,45))
    assert len(notes) == 2 and "first prediction of the series" in notes[0][1]

def test_holiday_detected_and_jobs_noop(orch, clock, store):
    orch.source.index_timestamp = ist_dt(2026,11,18,15,30)
    clock.set(2026,11,19,9,20); orch.morning_setup(); clock.set(2026,11,19,13,0)
    orch.snapshot_job(); orch.check_missed_reassessments()
    assert store.day_status(date(2026,11,19)) == "holiday" and store.gaps(date(2026,11,19)) == []

def test_settle_job_scores_and_refits(orch, clock, store):
    clock.set(2026,11,23,9,45); orch.morning_setup(); orch.reassess_job(time(9,45))
    orch.source.index_close = 25410.0; clock.set(2026,11,23,15,45); orch.settle_job()
    assert store.outcome("NIFTY", date(2026,11,23)) == 25410.0
    assert store.current_weights("NIFTY", "le1").source == "live"
```

(The fake source exposes `logged_in`, `index_timestamp`, `index_close`, and serves `sample_chain`-like quotes; `notes` captures `notify_fn` calls.)

- [ ] **Step 2: Run** `pytest tests/test_orchestrator.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** `Orchestrator`, `platform_win`.
- [ ] **Step 4: Run** `pytest -v` (whole suite) — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "feat: orchestrator, scheduling, gaps and settlement"`

---

### Task 12: Web API and dashboard page

**Files:** Create `fo_dash/web/__init__.py`, `fo_dash/web/app.py`, `fo_dash/web/state.py`, `fo_dash/web/static/index.html`, `fo_dash/web/static/app.js` · Test `tests/test_web.py`

**Interfaces:**
- Produces:
  - `build_state(store: Store, orch: Orchestrator, now: datetime) -> dict` with this shape:
    ```
    {"status": {"login": "ok"|"login_needed", "day": ..., "data_time": iso|None, "stale": bool,
                "next_reassessment": "HH:MM"|None, "calibration": "uncalibrated"|"backtest-prior"|"live"},
     "panels": [{"key": "NIFTY-weekly", "underlying", "kind", "expiry": iso, "expiry_label": "Mon 23-Nov",
                 "dte_bucket", "spot", "future", "vix",
                 "prediction": {"centre", "band68": [lo,hi]|None, "band90": [lo,hi]|None,
                                "probs_above": [[strike, p], ...], "note"},
                 "signals": {"max_pain", "pcr_total", "pcr_atm", "atm_iv", "sigma_remaining", "gamma_pin", "pivot", "quality"},
                 "supports": [...], "resistances": [...], "weights": {...},
                 "oi_chart": {"strikes": [...], "ce_oi": [...], "pe_oi": [...], "ce_chg": [...], "pe_chg": [...]},
                 "drift": [{"time", "centre", "lo68", "hi68", "spot"}],     # locked predictions this series
                 "log": [{"time", "centre", "changed", "reason"}]}],
     "gaps": [{"start", "end", "what"}],
     "track_record": {underlying: track_record(...) dict, "weights": {underlying: {bucket: WeightSet as dict}}}}
    ```
    `stale` = logged out, or in market hours on a trading day with `data_time` older than `STALE_MINUTES`. `calibration` reflects the `source` of the weights used by the NIFTY weekly panel's latest prediction (`prior` → `uncalibrated`, `backtest` → `backtest-prior`, `live` → `live`).
  - `create_app(store: Store, orch: Orchestrator, source: KiteSource, now_fn) -> FastAPI` — `GET /` serves `static/index.html`; `GET /static/*`; `GET /api/state`; `GET /kite/login` → 302 to `source.login_url()`; `GET /kite/callback?request_token=…&status=success` → `source.complete_login`, set `orch.status["login"]="ok"`, call `orch.morning_setup()`, 302 to `/`; callback with `status != success` → 302 to `/?login=failed`.
- Page: three panel columns (stack on narrow screens) laid out per spec §6.8; status bar turns red when `stale` or `login_needed` and shows a "Log in to Kite" button linking `/kite/login`; Chart.js `4.4.1` from `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js` for the OI bar chart (CE vs PE with OI-change overlay) and the drift line chart; `app.js` polls `/api/state` every 60 s; numbers formatted Indian style; the centre is never rendered without its 68%/90% range text, and when bands are null the panel shows `prediction.note` in place of the range.

- [ ] **Step 1: Write the failing tests** (FastAPI `TestClient`; `app` fixture builds `create_app` with the fake source/orchestrator from Task 11 conftest fixtures)

```python
def test_state_reports_login_needed(client, orch):
    orch.status["login"] = "login_needed"
    st = client.get("/api/state").json()
    assert st["status"]["login"] == "login_needed" and st["status"]["stale"] is True

def test_state_panels_have_bands(client, orch, clock):
    clock.set(2026,11,19,10,0); orch.morning_setup(); orch.snapshot_job()
    st = client.get("/api/state").json()
    assert [p["key"] for p in st["panels"]] == ["NIFTY-weekly", "NIFTY-monthly", "BANKNIFTY-monthly"]
    for p in st["panels"]:
        assert p["prediction"]["band68"] and p["prediction"]["band90"]
    assert st["status"]["calibration"] == "uncalibrated"

def test_stale_after_ten_minutes(client, orch, clock):
    clock.set(2026,11,19,10,0); orch.morning_setup(); orch.snapshot_job(); clock.set(2026,11,19,10,11)
    assert client.get("/api/state").json()["status"]["stale"] is True

def test_callback_completes_login(client, orch):
    r = client.get("/kite/callback?request_token=rt&status=success", follow_redirects=False)
    assert r.status_code == 302 and orch.source.completed_with == "rt" and orch.status["login"] == "ok"

def test_index_served(client):
    assert "Log in to Kite" in client.get("/").text
```

- [ ] **Step 2: Run** `pytest tests/test_web.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** `state.py`, `app.py`, `index.html`, `app.js`.
- [ ] **Step 4: Run** `pytest -v` — Expected: all pass. Then start the app against the fake source (`python -m fo_dash run --demo`, see Task 13) and take a Playwright screenshot of `http://127.0.0.1:8050/` at 1280×900 and 390×844 to check the layout renders, charts draw and nothing overflows.
- [ ] **Step 5: Commit** `git commit -m "feat: web API and dashboard page"`

---

### Task 13: CLI, Windows scripts and README

**Files:** Create `fo_dash/__main__.py`, `fo_dash/demo.py`, `setup.bat`, `start.bat`, `README.md`; Modify `CLAUDE.md` (replace "repository is empty" with commands/architecture) · Test `tests/test_cli.py`

**Interfaces:**
- Produces: `main(argv: list[str] | None = None) -> int` with subcommands:
  - `run [--demo]` — `load_settings()`, build `KiteConnect(api_key)`, `TokenStore(data_dir/"token.json")`, `KiteSource`, `Store(data_dir/"fo_dash.sqlite")`, `Orchestrator`, `orch.start()`, `uvicorn.run(create_app(...), host=HOST, port=PORT)`, and open the browser to `http://127.0.0.1:8050/`. `--demo` swaps in `fo_dash/demo.py`: a deterministic fake `KiteSource` (same methods) serving a sample chain around Nifty 25,371 / Bank Nifty 62,628 and a clock pinned to 2026-11-19 13:00 IST so the dashboard can be seen without Kite.
  - `backtest --from YYYY-MM-DD --to YYYY-MM-DD` — runs `run_backtest` with cache `data_dir/"bhavcopy"`, prints a summary per underlying (expiries, mean abs error %, vs futures baseline, band coverage).
  - `status` — prints login state, last snapshot time, current weights source per underlying.
- `setup.bat`: `py -3.12 -m venv .venv`, `.venv\Scripts\pip install -r requirements.txt`, copy `.env.example` to `.env` if missing, then print "Edit .env with your Kite API key and secret".
- `start.bat`: `.venv\Scripts\python -m fo_dash run`.
- README sections: what it does (and does not — no orders, no point predictions), first-time setup (Python 3.12 install with "Add to PATH", `setup.bat`, edit `.env`), daily use (start, click "Log in to Kite"), run the back-test once (`.venv\Scripts\python -m fo_dash backtest --from 2024-07-08 --to <today>`; UDiFF files start 08-Jul-2024), optional Task Scheduler entry (trigger weekdays 09:00, action `start.bat`, "start in" the repo folder), where data lives and how to back it up, how to read the dashboard (centre + bands, "uncalibrated" label, track record vs futures baseline).

- [ ] **Step 1: Write the failing tests**

```python
def test_cli_help_lists_commands(capsys):
    with pytest.raises(SystemExit): main(["--help"])
    out = capsys.readouterr().out
    assert all(c in out for c in ("run", "backtest", "status"))

def test_backtest_requires_dates():
    with pytest.raises(SystemExit): main(["backtest"])
```

- [ ] **Step 2–4:** run (FAIL) → implement → run `pytest -v` (all pass).
- [ ] **Step 5: First-run checklist on Rishi's laptop** (manual, recorded in README "Verify your install"): `setup.bat` succeeds; `start.bat` opens the dashboard; "Log in to Kite" round-trips to `/kite/callback` and the status bar turns green; within 5 min all three panels show live spot/future/VIX matching Kite; `python -m fo_dash backtest --from 2024-07-08 --to <today>` completes and the calibration label changes to "backtest-prior".
- [ ] **Step 6: Commit** `git commit -m "feat: CLI, Windows scripts, README"`

---

## Self-review notes

- Spec coverage: §6.2 → Tasks 3, 8, 11; §6.3 → 2, 5; §6.4 → 6; §6.5 → 7, 11; §6.6 → 9, 11; §6.7 → 10; §6.8 → 12; §6.9 → 11, 13; anti-goals → Global Constraints + Review Focus. §6.10 items are out of scope by the spec.
- Pivot is absent in the back-test (no index high/low in bhavcopy), so its weight is learned only from live expiries; the learner already keeps prior share for signals without data.
