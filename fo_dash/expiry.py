"""Current expiries, read only from the instrument master (never from weekdays)."""
from __future__ import annotations

from datetime import date, datetime

from fo_dash.config import MARKET_CLOSE, UnderlyingConfig


def _as_date(v) -> date:
    return v.date() if isinstance(v, datetime) else v if isinstance(v, date) else date.fromisoformat(str(v))


def _live(expiry: date, now: datetime) -> bool:
    today = now.date()
    return expiry > today or (expiry == today and now.time() < MARKET_CLOSE)


def _expiries(instruments: list[dict], name: str, types: set[str]) -> list[date]:
    return sorted({_as_date(i["expiry"]) for i in instruments
                   if i.get("name") == name and i.get("instrument_type") in types and i.get("expiry")})


def select_expiries(instruments: list[dict], cfg: UnderlyingConfig, now: datetime) -> dict[str, date]:
    out: dict[str, date] = {}
    for kind in cfg.kinds:
        types = {"CE", "PE"} if kind == "weekly" else {"FUT"}
        live = [e for e in _expiries(instruments, cfg.name, types) if _live(e, now)]
        if live:
            out[kind] = live[0]
    return out


def future_expiry_for(instruments: list[dict], cfg: UnderlyingConfig, option_expiry: date) -> date:
    futs = [e for e in _expiries(instruments, cfg.name, {"FUT"}) if e >= option_expiry]
    if not futs:
        raise LookupError(f"no future for {cfg.name} on/after {option_expiry}")
    return futs[0]
