"""Replay end-of-day chains through the live engine to fit the prior weights (spec §6.7)."""
from __future__ import annotations

import time as _time
from datetime import date, datetime, timedelta
from pathlib import Path

from fo_dash.backtest.bhavcopy import BhavRow, download, parse
from fo_dash.config import IST, MARKET_CLOSE, UNDERLYINGS, UnderlyingConfig
from fo_dash.learner import refit, score, track_record
from fo_dash.models import ChainSnapshot, OptionQuote, WeightSet
from fo_dash.predict import PRIOR, dte_bucket, predict
from fo_dash.signals import compute_signals


def _pick_expiry(rows: list[BhavRow], kind: str, today: date) -> date | None:
    opt = {r.expiry for r in rows if r.instr == "IDO" and r.expiry > today}
    if kind == "monthly":
        opt &= {r.expiry for r in rows if r.instr == "IDF"}
    return min(opt) if opt else None


def build_eod_snapshots(rows: list[BhavRow], cfg: UnderlyingConfig, kind: str) -> list[ChainSnapshot]:
    rows = [r for r in rows if r.symbol == cfg.name]
    if not rows:
        return []
    today = rows[0].trade_date
    expiry = _pick_expiry(rows, kind, today)
    if expiry is None:
        return []
    futs = sorted((r for r in rows if r.instr == "IDF" and r.expiry >= expiry), key=lambda r: r.expiry)
    if not futs:
        return []
    opts = [OptionQuote(r.strike, r.opt_type, r.close, None, None, r.volume, r.oi)
            for r in rows if r.instr == "IDO" and r.expiry == expiry and r.opt_type in ("CE", "PE")]
    spot = next(r.underlying for r in rows if r.underlying)
    return [ChainSnapshot(cfg.name, kind, expiry, futs[0].expiry, datetime.combine(today, MARKET_CLOSE, tzinfo=IST),
                          spot, futs[0].close, None, sorted(opts, key=lambda o: (o.strike, o.opt_type)))]


def run_backtest(store, start: date, end: date, cache_dir: Path, session, sleep_fn=_time.sleep) -> dict:
    names = {c.name for c in UNDERLYINGS}
    closes: dict[str, list[float]] = {n: [] for n in names}
    prev_oi: dict[tuple[str, date], dict] = {}
    pending: dict[tuple[str, str, date], list] = {}
    scored: dict[str, list] = {n: [] for n in names}
    days = skipped = 0
    d = start
    while d <= end:
        if d.weekday() >= 5:
            d += timedelta(days=1)
            continue
        cached = (Path(cache_dir) / f"BhavCopy_NSE_FO_0_0_0_{d:%Y%m%d}_F_0000.csv.zip").exists()
        path = download(d, cache_dir, session)
        if not cached:
            sleep_fn(1.0)
        if path is None:
            skipped += 1
            d += timedelta(days=1)
            continue
        days += 1
        rows = parse(path, names)
        for cfg in UNDERLYINGS:
            urows = [r for r in rows if r.symbol == cfg.name]
            if not urows:
                continue
            spot = next((r.underlying for r in urows if r.underlying), None)
            # settle expiries that end today
            for key in [k for k in pending if k[0] == cfg.name and k[2] == d]:
                if spot:
                    scored[cfg.name] += score(pending[key], spot)
                del pending[key]
            hist = closes[cfg.name]
            close_3d_ago = hist[-3] if len(hist) >= 3 else None
            seen = set()
            for kind in cfg.kinds:
                for snap in build_eod_snapshots(urows, cfg, kind):
                    sig = compute_signals(snap, prev_oi.get((cfg.name, snap.expiry), {}), None, close_3d_ago)
                    bucket = dte_bucket(d, snap.expiry)
                    p = predict(cfg.name, kind, snap.expiry, snap.taken_at, sig, PRIOR[bucket])
                    pending.setdefault((cfg.name, kind, snap.expiry), []).append(p)
                    seen.add(snap.expiry)
            for e in {r.expiry for r in urows if r.instr == "IDO"}:
                prev_oi[(cfg.name, e)] = {(r.strike, r.opt_type): r.oi for r in urows if r.instr == "IDO" and r.expiry == e}
            if spot:
                hist.append(spot)
        d += timedelta(days=1)

    created = datetime.combine(end, MARKET_CLOSE, tzinfo=IST)
    report = {"days": days, "skipped_days": skipped, "expiries": {}, "track_record": {}}
    for name, rows in scored.items():
        report["expiries"][name] = len({r.expiry for r in rows})
        report["track_record"][name] = track_record(rows)
        for bucket in {r.bucket for r in rows}:
            ws = refit([r for r in rows if r.bucket == bucket], PRIOR[bucket], lam=0, now=created)
            store.save_weights(name, bucket, WeightSet(ws.weights, ws.k68, ws.k90, f"backtest-{end:%Y%m%d}", "backtest"), created)
    return report
