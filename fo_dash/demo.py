"""Offline demo: a deterministic fake Kite so the dashboard can be seen without a login."""
from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta

from fo_dash.config import IST
from fo_dash.kite_client import KiteSource
from fo_dash.pricing import black76_price, year_fraction

DEMO_NOW = datetime(2026, 11, 19, 13, 0, tzinfo=IST)
_EXPIRIES = {"NIFTY": [date(2026, 11, 23), date(2026, 12, 1), date(2026, 12, 29)], "BANKNIFTY": [date(2026, 11, 23), date(2026, 12, 29)]}
_FUT_EXP = {"NIFTY": [date(2026, 11, 23), date(2026, 12, 29)], "BANKNIFTY": [date(2026, 11, 23), date(2026, 12, 29)]}
_SPOT = {"NIFTY": ("NSE:NIFTY 50", 256265, 25371.1, 50, (22800, 28000)),
         "BANKNIFTY": ("NSE:NIFTY BANK", 260105, 62627.75, 100, (57000, 68300))}


class DemoClock:
    def __init__(self, t: datetime = DEMO_NOW):
        self.t = t

    def now(self) -> datetime:
        return self.t


class DemoKite:
    def __init__(self, clock: DemoClock):
        self.clock = clock
        self.instr, tok = [], 5000
        for name, (_, _, _, step, (lo, hi)) in _SPOT.items():
            for e in _EXPIRIES[name]:
                for k in range(lo, hi + step, step):
                    for t in ("CE", "PE"):
                        tok += 1
                        self.instr.append({"instrument_token": tok, "tradingsymbol": f"{name}{e:%y%b}{k}{t}".upper(), "name": name,
                                           "expiry": e, "strike": float(k), "lot_size": 65, "instrument_type": t,
                                           "segment": "NFO-OPT", "exchange": "NFO"})
            for e in _FUT_EXP[name]:
                tok += 1
                self.instr.append({"instrument_token": tok, "tradingsymbol": f"{name}{e:%y%b}FUT".upper(), "name": name,
                                   "expiry": e, "strike": 0.0, "lot_size": 65, "instrument_type": "FUT",
                                   "segment": "NFO-FUT", "exchange": "NFO"})
        self.by_sym = {i["tradingsymbol"]: i for i in self.instr}

    def _drift(self) -> float:  # spot drifts up through the day so the demo shows reassessments moving
        mins = (self.clock.now() - self.clock.now().replace(hour=9, minute=15)).total_seconds() / 60
        return 1 + 0.00001 * mins

    def login_url(self):
        return "https://kite.zerodha.com/connect/login?v=3&api_key=demo"

    def set_access_token(self, t):
        pass

    def instruments(self, exchange=None):
        return list(self.instr)

    def _q(self, px, tok, oi=0, bid=0.0, ask=0.0):
        return {"instrument_token": tok, "timestamp": self.clock.now(), "last_price": px, "volume": 1000, "oi": oi,
                "ohlc": {"open": px, "high": px, "low": px, "close": px},
                "depth": {"buy": [{"price": bid, "quantity": 65, "orders": 1}], "sell": [{"price": ask, "quantity": 65, "orders": 1}]}}

    def quote(self, *instruments):
        ins = instruments[0] if instruments and isinstance(instruments[0], list) else list(instruments)
        out = {}
        for s in ins:
            if s == "NSE:INDIA VIX":
                out[s] = self._q(16.25, 264969)
                continue
            hit = next(((n, v) for n, v in _SPOT.items() if v[0] == s), None)
            if hit:
                out[s] = self._q(round(hit[1][2] * self._drift(), 2), hit[1][1])
                continue
            i = self.by_sym.get(s.split(":", 1)[1])
            if i is None:
                continue
            name = i["name"]
            spot = _SPOT[name][2] * self._drift()
            fut = spot * 1.001
            if i["instrument_type"] == "FUT":
                out[s] = self._q(round(fut, 1), i["instrument_token"], oi=9_000_000)
                continue
            k = i["strike"]
            T = year_fraction(self.clock.now(), i["expiry"])
            skew = 0.13 + 0.25 * abs(math.log(k / fut))
            px = max(0.05, round(black76_price(fut, k, T, skew, i["instrument_type"]) / 0.05) * 0.05)
            step = _SPOT[name][3]
            # call walls above round numbers, put walls below, fading with distance
            dist = abs(k - spot) / (step * 6)
            base = 4_000_000 * math.exp(-dist)
            bonus = 2.5 if k % (step * 10) == 0 else 1.0
            side_ok = (k >= spot) if i["instrument_type"] == "CE" else (k <= spot)
            oi = int(base * bonus * (1.0 if side_ok else 0.35))
            out[s] = self._q(px, i["instrument_token"], oi=oi, bid=round(max(0.0, px - 0.05), 2), ask=round(px + 0.05, 2))
        return out

    def historical_data(self, instrument_token, from_date, to_date, interval, continuous=False, oi=False):
        base = 25371.1 if instrument_token == 256265 else 62627.75
        d = to_date.date()
        out = []
        for j, f in enumerate((0.985, 0.99, 0.995, 1.0)):
            day = d - timedelta(days=3 - j)
            c = base * f
            out.append({"date": datetime.combine(day, time(9, 15), tzinfo=IST), "open": c, "high": c * 1.004,
                        "low": c * 0.996, "close": c, "volume": 0})
        return out


class DemoSource(KiteSource):
    def __init__(self, clock: DemoClock):
        from fo_dash.kite_client import TokenStore
        import os
        from pathlib import Path
        super().__init__(DemoKite(clock), TokenStore(Path(os.devnull)), "demo", clock.now, sleep_fn=lambda s: None)

    def is_logged_in(self) -> bool:
        return True

    def complete_login(self, request_token: str) -> None:
        pass


def build_demo():
    """Return (store, orchestrator, source, now_fn) seeded with two locked reassessments and a live snapshot."""
    from fo_dash.orchestrator import Orchestrator
    from fo_dash.storage import Store
    clock = DemoClock(DEMO_NOW.replace(hour=9, minute=45))
    store = Store(":memory:")
    source = DemoSource(clock)
    orch = Orchestrator(store, source, clock.now, notify_fn=lambda t, b: None, keep_awake_fn=lambda on: None)
    orch.morning_setup()
    orch.reassess_job(time(9, 45))
    clock.t = DEMO_NOW.replace(hour=12, minute=30)
    orch.reassess_job(time(12, 30))
    clock.t = DEMO_NOW
    orch.snapshot_job()
    return store, orch, source, clock.now
