"""Turn Kite quotes into a ChainSnapshot for one underlying/expiry."""
from __future__ import annotations

import math
from datetime import date, datetime

from fo_dash.config import STRIKE_WINDOW_PCT, VIX_SYMBOL, UnderlyingConfig
from fo_dash.expiry import _as_date
from fo_dash.models import ChainSnapshot, OptionQuote


def strike_window(spot: float, step: int, pct: float = STRIKE_WINDOW_PCT) -> list[float]:
    lo = math.ceil(spot * (1 - pct) / step) * step
    hi = math.floor(spot * (1 + pct) / step) * step
    return [float(k) for k in range(int(lo), int(hi) + step, step)]


def option_symbols(instruments: list[dict], name: str, expiry: date, strikes: list[float]) -> dict[str, tuple[float, str]]:
    want = set(strikes)
    return {f"NFO:{i['tradingsymbol']}": (float(i["strike"]), i["instrument_type"])
            for i in instruments
            if i.get("name") == name and i.get("instrument_type") in ("CE", "PE")
            and _as_date(i["expiry"]) == expiry and float(i["strike"]) in want}


def future_symbol(instruments: list[dict], name: str, future_expiry: date) -> str:
    for i in instruments:
        if i.get("name") == name and i.get("instrument_type") == "FUT" and _as_date(i["expiry"]) == future_expiry:
            return f"NFO:{i['tradingsymbol']}"
    raise LookupError(f"no future for {name} expiring {future_expiry}")


def _best(depth: dict, side: str) -> float | None:
    rows = (depth or {}).get(side) or []
    px = rows[0].get("price") if rows else 0
    return px if px else None


def collect(source, cfg: UnderlyingConfig, kind: str, expiry: date, future_expiry: date,
            instruments: list[dict], now: datetime) -> ChainSnapshot:
    fut = future_symbol(instruments, cfg.name, future_expiry)
    head = source.quote([cfg.spot_symbol, VIX_SYMBOL, fut])
    spot = head[cfg.spot_symbol]["last_price"]
    vix = head.get(VIX_SYMBOL, {}).get("last_price")
    syms = option_symbols(instruments, cfg.name, expiry, strike_window(spot, cfg.strike_step))
    quotes = source.quote(list(syms))
    opts = []
    for sym, (strike, t) in sorted(syms.items(), key=lambda kv: kv[1]):
        q = quotes.get(sym)
        if not q:
            continue
        opts.append(OptionQuote(strike, t, float(q.get("last_price") or 0.0), _best(q.get("depth"), "buy"),
                                _best(q.get("depth"), "sell"), int(q.get("volume") or 0), int(q.get("oi") or 0)))
    return ChainSnapshot(cfg.name, kind, expiry, future_expiry, now, float(spot), float(head[fut]["last_price"]),
                         vix, opts)
