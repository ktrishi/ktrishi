"""Black-76 on the forward (r = 0): price, implied vol, gamma."""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta

from fo_dash.config import IST, MARKET_CLOSE

_MIN_T = 1 / (365 * 24 * 60)  # one minute


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _d1d2(F: float, K: float, T: float, iv: float) -> tuple[float, float]:
    s = iv * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * s * s) / s
    return d1, d1 - s


def black76_price(F: float, K: float, T: float, iv: float, opt_type: str) -> float:
    d1, d2 = _d1d2(F, K, T, iv)
    if opt_type == "CE":
        return F * norm_cdf(d1) - K * norm_cdf(d2)
    return K * norm_cdf(-d2) - F * norm_cdf(-d1)


def implied_vol(price: float, F: float, K: float, T: float, opt_type: str) -> float | None:
    intrinsic = max(0.0, F - K) if opt_type == "CE" else max(0.0, K - F)
    if price <= 0 or price < intrinsic - 1e-9 or T <= 0:
        return None
    lo, hi = 0.01, 3.0
    if price > black76_price(F, K, T, hi, opt_type) or price < black76_price(F, K, T, lo, opt_type):
        return None
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if black76_price(F, K, T, mid, opt_type) > price:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-6:
            break
    return 0.5 * (lo + hi)


def gamma(F: float, K: float, T: float, iv: float) -> float:
    d1, _ = _d1d2(F, K, T, iv)
    return norm_pdf(d1) / (F * iv * math.sqrt(T))


def year_fraction(now: datetime, expiry: date) -> float:
    close = datetime.combine(expiry, MARKET_CLOSE, tzinfo=IST)
    t = (close - now) / timedelta(days=365)
    return max(t, _MIN_T)
