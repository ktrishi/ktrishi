"""Assemble the JSON the dashboard page renders."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta

from fo_dash.config import MARKET_CLOSE, MARKET_OPEN, REASSESS_TIMES, STALE_MINUTES, UNDERLYINGS
from fo_dash.learner import track_record
from fo_dash.predict import PRIOR

OI_CHART_PCT = 0.04


def _calibration(version: str | None) -> str:
    if not version or version == "uncalibrated":
        return "uncalibrated"
    return "backtest-prior" if version.startswith("backtest") else "live"


def _when(dt: datetime, now: datetime) -> str:
    return f"{dt:%H:%M}" if dt.date() == now.date() else f"{dt:%d-%b %H:%M}"


def _panel(store, orch, cfg, kind, now) -> dict:
    key = f"{cfg.name}-{kind}"
    expiry = orch.current_expiries(now).get(cfg.name, {}).get(kind)
    base = {"key": key, "underlying": cfg.name, "kind": kind, "expiry": None, "expiry_label": None,
            "dte_bucket": None, "spot": None, "future": None, "vix": None, "prediction": None, "signals": None,
            "supports": [], "resistances": [], "weights": {}, "oi_chart": {"strikes": [], "ce_oi": [], "pe_oi": [],
            "ce_chg": [], "pe_chg": []}, "drift": [], "log": [], "data_time": None}
    if expiry is None:
        return base
    base.update(expiry=expiry.isoformat(), expiry_label=f"{expiry:%a} {expiry.day}-{expiry:%b}")
    snap = next((s for s in (store.latest_snapshot(cfg.name, k, expiry) for k in (kind, *cfg.kinds)) if s), None)
    lp = store.latest_prediction(cfg.name, kind, expiry)
    if snap:
        base.update(spot=snap.spot, future=snap.future, vix=snap.vix, data_time=snap.taken_at.isoformat())
    if lp:
        p, s = lp.prediction, lp.prediction.signals
        base.update(
            dte_bucket=p.dte_bucket,
            prediction={"centre": p.centre, "band68": list(p.band68) if p.band68 else None,
                        "band90": list(p.band90) if p.band90 else None,
                        "probs_above": [[k, v] for k, v in sorted(p.probs_above.items())], "note": p.note,
                        "made_at": p.made_at.isoformat(), "weights_version": p.weights_version},
            signals={"forward": s.forward, "max_pain": s.max_pain, "pcr_total": s.pcr_total, "pcr_atm": s.pcr_atm,
                     "atm_iv": s.atm_iv, "sigma_remaining": s.sigma_remaining, "gamma_pin": s.gamma_pin,
                     "pivot": s.pivot, "quality": s.quality},
            supports=s.supports, resistances=s.resistances, weights=p.weights,
        )
        if snap:
            lo, hi = snap.spot * (1 - OI_CHART_PCT), snap.spot * (1 + OI_CHART_PCT)
            ce = {o.strike: o.oi for o in snap.options if o.opt_type == "CE"}
            pe = {o.strike: o.oi for o in snap.options if o.opt_type == "PE"}
            strikes = sorted(k for k in set(ce) | set(pe) if lo <= k <= hi)
            base["oi_chart"] = {"strikes": strikes, "ce_oi": [ce.get(k, 0) for k in strikes],
                                "pe_oi": [pe.get(k, 0) for k in strikes],
                                "ce_chg": [s.oi_change.get((k, "CE")) for k in strikes],
                                "pe_chg": [s.oi_change.get((k, "PE")) for k in strikes]}
    locked = store.predictions(cfg.name, kind, expiry)
    base["drift"] = [{"time": _when(l.prediction.made_at, now), "centre": l.prediction.centre,
                      "lo68": l.prediction.band68[0] if l.prediction.band68 else None,
                      "hi68": l.prediction.band68[1] if l.prediction.band68 else None,
                      "forward": l.prediction.signals.forward} for l in locked]
    base["log"] = [{"time": _when(l.prediction.made_at, now), "centre": l.prediction.centre, "changed": l.changed,
                    "reason": l.reason} for l in reversed(locked)]
    return base


def build_state(store, orch, now: datetime) -> dict:
    with orch.lock:
        return _build_state(store, orch, now)


def _build_state(store, orch, now: datetime) -> dict:
    today = now.date()
    logged_in = orch.source.is_logged_in()
    login = "ok" if logged_in else "login_needed"
    day = store.day_status(today) or orch.status.get("day") or "unknown"
    data_time = store.last_snapshot_time(today)
    in_session = now.weekday() < 5 and MARKET_OPEN <= now.time() <= MARKET_CLOSE and day != "holiday"
    stale = login == "login_needed" or (in_session and (data_time is None or now - data_time > timedelta(minutes=STALE_MINUTES)))
    nxt = next((t for t in REASSESS_TIMES if t > now.time()), None) if now.weekday() < 5 and day != "holiday" else None
    panels = [_panel(store, orch, cfg, kind, now) for cfg, kind in orch.panels()]
    first = panels[0]["prediction"] if panels else None
    tr = {cfg.name: track_record(store.scores(cfg.name)) for cfg in UNDERLYINGS}
    tr["weights"] = {cfg.name: {b: asdict(store.current_weights(cfg.name, b) or PRIOR[b]) for b in PRIOR} for cfg in UNDERLYINGS}
    return {
        "status": {"login": login, "day": day, "data_time": data_time.isoformat() if data_time else None,
                   "stale": stale, "next_reassessment": f"{nxt:%H:%M}" if nxt else None,
                   "calibration": _calibration(first["weights_version"] if first else None),
                   "last_error": orch.status.get("last_error"), "now": now.isoformat()},
        "panels": panels,
        "gaps": [{"start": g[0].isoformat(), "end": g[1].isoformat() if g[1] else None, "what": g[2]} for g in store.gaps(today)],
        "track_record": tr,
    }
