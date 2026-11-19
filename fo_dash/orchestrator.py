"""Runs the day: setup, 5-minute snapshots, locked reassessments, gaps, settlement and learning."""
from __future__ import annotations

import functools
import logging
import threading
from datetime import date, datetime, time, timedelta
from typing import Callable

from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler

from fo_dash.collector import collect
from fo_dash.config import (HOLIDAY_CHECK, IST, MARKET_CLOSE, MARKET_OPEN, REASSESS_TIMES, SETTLE_TIME,
                            SNAPSHOT_MINUTES, UNDERLYINGS, UnderlyingConfig)
from fo_dash.expiry import _as_date, future_expiry_for, select_expiries
from fo_dash.kite_client import KiteSource, LoginRequired
from fo_dash.learner import refit, score
from fo_dash.models import Prediction
from fo_dash.platform_win import keep_awake, notify
from fo_dash.predict import PRIOR, dte_bucket, predict
from fo_dash.reassess import compare
from fo_dash.signals import compute_signals

log = logging.getLogger(__name__)


def _locked(fn):
    @functools.wraps(fn)
    def wrapper(self, *a, **kw):
        with self.lock:
            return fn(self, *a, **kw)
    return wrapper


def _ist(ts) -> datetime | None:
    if not isinstance(ts, datetime):
        return None
    return ts.replace(tzinfo=IST) if ts.tzinfo is None else ts.astimezone(IST)


class Orchestrator:
    def __init__(self, store, source: KiteSource, now_fn: Callable[[], datetime],
                 notify_fn=notify, keep_awake_fn=keep_awake):
        self.store, self.source, self.now_fn = store, source, now_fn
        self.notify_fn, self.keep_awake_fn = notify_fn, keep_awake_fn
        self.status = {"login": "ok", "day": "unknown", "last_error": None}
        self.instruments: list[dict] | None = None
        self.expiries: dict[str, dict[str, date]] = {}
        self.fut_exp: dict[tuple[str, date], date] = {}
        self.tokens: dict[str, int] = {}
        self.hlc: dict[str, tuple[float, float, float]] = {}
        self.close3: dict[str, float] = {}
        self.setup_day: date | None = None
        self.last_preds: dict[tuple[str, str], Prediction] = {}
        self.lock = threading.RLock()  # jobs, web login and state reads never interleave

    # ---- helpers
    def panels(self) -> list[tuple[UnderlyingConfig, str]]:
        return [(cfg, kind) for cfg in UNDERLYINGS for kind in cfg.kinds]

    def _logged_in(self) -> bool:
        ok = self.source.is_logged_in()
        self.status["login"] = "ok" if ok else "login_needed"
        return ok

    def _day(self, today: date) -> str:
        st = self.store.day_status(today) or "unknown"
        self.status["day"] = st
        return st

    def _gap_once(self, start: datetime, end: datetime | None, what: str) -> None:
        if what not in {g[2] for g in self.store.gaps(start.date())}:
            self.store.log_gap(start, end, what)

    def _check_holiday(self, now: datetime) -> None:
        q = self.source.quote([UNDERLYINGS[0].spot_symbol]).get(UNDERLYINGS[0].spot_symbol, {})
        ts = _ist(q.get("timestamp"))
        self.store.set_day_status(now.date(), "trading" if ts and ts.date() == now.date() else "holiday")

    @_locked
    def current_expiries(self, now: datetime | None = None) -> dict[str, dict[str, date]]:
        """Expiries for the panels, rolled forward once an expiry has closed (15:30 on expiry day)."""
        now = now or self.now_fn()
        if self.instruments:
            stale = any(e < now.date() or (e == now.date() and now.time() >= MARKET_CLOSE)
                        for kinds in self.expiries.values() for e in kinds.values())
            if stale or not self.expiries:
                self.expiries = {cfg.name: select_expiries(self.instruments, cfg, now) for cfg in UNDERLYINGS}
                for cfg in UNDERLYINGS:
                    for e in self.expiries[cfg.name].values():
                        if (cfg.name, e) not in self.fut_exp:
                            self.fut_exp[(cfg.name, e)] = future_expiry_for(self.instruments, cfg, e)
        return {k: dict(v) for k, v in self.expiries.items()}

    # ---- jobs
    @_locked
    def morning_setup(self) -> None:
        now = self.now_fn()
        today = now.date()
        if not self._logged_in():
            return
        try:
            self.instruments = self.source.instruments("NFO")
            self.expiries = {cfg.name: select_expiries(self.instruments, cfg, now) for cfg in UNDERLYINGS}
            self.fut_exp = {(cfg.name, e): future_expiry_for(self.instruments, cfg, e)
                            for cfg in UNDERLYINGS for e in self.expiries[cfg.name].values()}
            quotes = self.source.quote([cfg.spot_symbol for cfg in UNDERLYINGS])
            if now.time() >= HOLIDAY_CHECK and now.weekday() < 5:
                ts = _ist(quotes.get(UNDERLYINGS[0].spot_symbol, {}).get("timestamp"))
                self.store.set_day_status(today, "trading" if ts and ts.date() == today else "holiday")
            for cfg in UNDERLYINGS:
                tok = quotes.get(cfg.spot_symbol, {}).get("instrument_token")
                if not tok:
                    continue
                self.tokens[cfg.name] = tok
                past = [c for c in self.source.daily_candles(tok, 6) if _ist(c["date"]) is None or _ist(c["date"]).date() < today]
                if past:
                    p = past[-1]
                    self.hlc[cfg.name] = (p["high"], p["low"], p["close"])
                if len(past) >= 3:
                    self.close3[cfg.name] = past[-3]["close"]
            self.setup_day = today
            self.status["last_error"] = None
        except LoginRequired:
            self.status["login"] = "login_needed"
        except Exception as e:
            log.exception("morning setup failed")
            self.status["last_error"] = f"setup: {e}"
        self._day(today)
        self.settle_job()  # back-fill any expiry whose settlement was missed (laptop shut at 15:45)

    def _in_session(self, now: datetime) -> bool:
        return now.weekday() < 5 and MARKET_OPEN <= now.time() <= MARKET_CLOSE

    @_locked
    def snapshot_job(self) -> None:
        now = self.now_fn()
        today = now.date()
        if not self._in_session(now) or self._day(today) == "holiday":
            return
        if not self._logged_in():
            return
        if self.setup_day != today:
            self.morning_setup()
            if self.setup_day != today:
                return
        if self.store.day_status(today) is None:
            if now.time() < HOLIDAY_CHECK:
                return  # nothing is saved until the holiday check has run
            try:
                self._check_holiday(now)
            except LoginRequired:
                self.status["login"] = "login_needed"
                return
            except Exception as e:
                self.status["last_error"] = f"holiday check: {e}"
                return
        if self._day(today) == "holiday":
            return
        expiries = self.current_expiries(now)
        prev = self.store.last_snapshot_time(today)
        open_dt = datetime.combine(today, MARKET_OPEN, tzinfo=IST)
        if prev and now - prev > timedelta(minutes=2 * SNAPSHOT_MINUTES):
            self.store.log_gap(prev, now, "snapshots")
        elif prev is None and now - open_dt > timedelta(minutes=15):
            self.store.log_gap(open_dt, now, "snapshots")
        try:
            snaps: dict[tuple[str, date], object] = {}
            for cfg, kind in self.panels():
                expiry = expiries.get(cfg.name, {}).get(kind)
                if expiry is None:
                    continue
                key = (cfg.name, expiry)
                if key not in snaps:
                    snaps[key] = collect(self.source, cfg, kind, expiry, self.fut_exp[key], self.instruments, now)
                    self.store.save_snapshot(snaps[key])
                snap = snaps[key]
                sig = compute_signals(snap, self.store.oi_before(cfg.name, expiry, open_dt),
                                      self.hlc.get(cfg.name), self.close3.get(cfg.name))
                bucket = dte_bucket(today, expiry)
                ws = self.store.current_weights(cfg.name, bucket) or PRIOR[bucket]
                p = predict(cfg.name, kind, expiry, now, sig, ws)
                self.store.save_prediction(p, locked=False, changed=False, reason="")
                self.last_preds[(cfg.name, kind)] = p
            self.status["last_error"] = None
        except LoginRequired:
            self.status["login"] = "login_needed"
        except Exception as e:
            log.exception("snapshot failed")
            self.status["last_error"] = f"snapshot: {e}"

    @_locked
    def reassess_job(self, slot: time) -> None:
        now = self.now_fn()
        today = now.date()
        what = f"missed reassessment {slot:%H:%M}"
        if now.weekday() >= 5 or self._day(today) == "holiday":
            return
        if not self._logged_in():
            self._gap_once(datetime.combine(today, slot, tzinfo=IST), None, what)
            return
        self.last_preds = {}
        self.snapshot_job()
        if not self.last_preds:
            self._gap_once(datetime.combine(today, slot, tzinfo=IST), None, what)
            return
        changed_keys: dict[tuple[str, date], tuple[str, str]] = {}
        for cfg, kind in self.panels():
            p = self.last_preds.get((cfg.name, kind))
            if p is None:
                continue
            prev = self.store.last_locked(cfg.name, kind, p.expiry)
            changed, reason = compare(prev.prediction if prev else None, p, cfg.change_threshold)
            self.store.save_prediction(p, locked=True, changed=changed, reason=reason)
            if changed and (cfg.name, p.expiry) not in changed_keys:
                changed_keys[(cfg.name, p.expiry)] = (f"{cfg.name} {kind} {p.expiry:%d-%b}", reason)
        for title, body in changed_keys.values():
            self.notify_fn(title, body)

    @_locked
    def check_missed_reassessments(self) -> None:
        now = self.now_fn()
        today = now.date()
        if now.weekday() >= 5 or self.setup_day != today or self._day(today) != "trading":
            return
        locked = self.store.locked_times(today)
        for slot in REASSESS_TIMES:
            slot_dt = datetime.combine(today, slot, tzinfo=IST)
            if now - slot_dt > timedelta(minutes=5) and slot not in locked:
                self._gap_once(slot_dt, None, f"missed reassessment {slot:%H:%M}")

    @_locked
    def settle_job(self) -> None:
        """Settle every expiry that has locked predictions but no outcome yet (today after 15:30, or missed days)."""
        now = self.now_fn()
        today = now.date()
        if not self._logged_in():
            return
        try:
            for cfg in UNDERLYINGS:
                due = [e for e in self.store.unsettled_expiries(cfg.name)
                       if e < today or (e == today and now.time() >= MARKET_CLOSE)]
                due = [e for e in due if (today - e).days <= 25]
                if not due:
                    continue
                if cfg.name not in self.tokens:
                    q = self.source.quote([cfg.spot_symbol]).get(cfg.spot_symbol, {})
                    if not q.get("instrument_token"):
                        continue
                    self.tokens[cfg.name] = q["instrument_token"]
                closes = {_ist(c["date"]).date(): float(c["close"])
                          for c in self.source.daily_candles(self.tokens[cfg.name], 30) if _ist(c["date"])}
                for expiry in due:
                    if expiry not in closes:
                        log.warning("settlement candle for %s %s not available yet", cfg.name, expiry)
                        continue
                    self._settle(cfg, expiry, closes[expiry], now)
        except LoginRequired:
            self.status["login"] = "login_needed"
        except Exception as e:
            log.exception("settlement failed")
            self.status["last_error"] = f"settlement: {e}"

    def _settle(self, cfg: UnderlyingConfig, expiry: date, settlement: float, now: datetime) -> None:
        self.store.save_outcome(cfg.name, expiry, settlement)
        locked = [lp.prediction for kind in cfg.kinds for lp in self.store.predictions(cfg.name, kind, expiry)]
        rows = score(locked, settlement)
        self.store.save_scores(rows)
        for bucket in sorted({r.bucket for r in rows}):
            backtests = [ws for _, b, ws in self.store.weights_history(cfg.name) if b == bucket and ws.source == "backtest"]
            prior = backtests[-1] if backtests else PRIOR[bucket]
            ws = refit(self.store.scores(cfg.name, bucket, last_n_expiries=20), prior, now=now)
            self.store.save_weights(cfg.name, bucket, ws, now)

    # ---- scheduling
    def start(self, run: bool = True) -> BackgroundScheduler:
        s = BackgroundScheduler(timezone=IST, executors={"default": ThreadPoolExecutor(1)},
                                job_defaults={"coalesce": True, "misfire_grace_time": 60, "max_instances": 1})
        wk = "mon-fri"
        s.add_job(self.morning_setup, "cron", id="setup-0915", day_of_week=wk, hour=9, minute=15)
        s.add_job(self.morning_setup, "cron", id="setup-0920", day_of_week=wk, hour=9, minute=20, second=30)
        s.add_job(self.snapshot_job, "cron", id="snapshot", day_of_week=wk, hour="9-15", minute="*/5", second=10)
        for t in REASSESS_TIMES:
            s.add_job(self.reassess_job, "cron", id=f"reassess-{t:%H%M}", args=[t], day_of_week=wk, hour=t.hour, minute=t.minute)
        s.add_job(self.check_missed_reassessments, "cron", id="missed", day_of_week=wk, hour="9-15", minute="*/5", second=40)
        # first try at 15:45, then every 15 min until 17:45 in case the closing candle is late
        s.add_job(self.settle_job, "cron", id="settle", day_of_week=wk, hour=f"{SETTLE_TIME.hour}-17", minute="*/15")
        s.add_job(self.keep_awake_fn, "cron", id="awake-on", args=[True], day_of_week=wk, hour=9, minute=10)
        s.add_job(self.keep_awake_fn, "cron", id="awake-off", args=[False], day_of_week=wk, hour=15, minute=50)
        if run:
            now = self.now_fn()
            if now.weekday() < 5 and time(9, 10) <= now.time() <= time(15, 50):
                self.keep_awake_fn(True)
            if now.weekday() < 5 and now.time() >= MARKET_OPEN:
                self.morning_setup()
            s.start()
        return s
