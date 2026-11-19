"""Option-chain signals (spec §6.3). Pure functions of one snapshot plus a little history."""
from __future__ import annotations

import math
from collections import defaultdict

from fo_dash.models import ChainSnapshot, OptionQuote, Signals
from fo_dash.pricing import gamma, implied_vol, year_fraction

MIN_VALID_IV = 5


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _price(o: OptionQuote) -> float:
    if o.bid and o.ask and o.bid > 0 and o.ask > 0:
        mid = 0.5 * (o.bid + o.ask)
        if o.ask - o.bid <= 0.2 * mid:
            return mid
    return o.ltp or 0.0


def _forward(snap: ChainSnapshot) -> float:
    if snap.expiry == snap.future_expiry:
        return snap.future
    T = year_fraction(snap.taken_at, snap.expiry)
    T_f = year_fraction(snap.taken_at, snap.future_expiry)
    return snap.spot + (snap.future - snap.spot) * T / T_f


def _max_pain(ce: dict[float, int], pe: dict[float, int], strikes: list[float], forward: float) -> float | None:
    if not strikes:
        return None

    def payout(K: float) -> float:
        return (sum(oi * max(0.0, K - k) for k, oi in ce.items())
                + sum(oi * max(0.0, k - K) for k, oi in pe.items()))

    return min(strikes, key=lambda K: (payout(K), abs(K - forward)))


def compute_signals(snap: ChainSnapshot, oi_prev_close: dict[tuple[float, str], int],
                    prev_day_hlc: tuple[float, float, float] | None, close_3d_ago: float | None) -> Signals:
    T = year_fraction(snap.taken_at, snap.expiry)
    fwd = _forward(snap)
    ce = {o.strike: o.oi for o in snap.options if o.opt_type == "CE"}
    pe = {o.strike: o.oi for o in snap.options if o.opt_type == "PE"}
    strikes = sorted(set(ce) | set(pe))

    max_pain = _max_pain(ce, pe, strikes, fwd)
    supports = [k for k, _ in sorted(((k, v) for k, v in pe.items() if k < snap.spot), key=lambda kv: -kv[1])][:3]
    resistances = [k for k, _ in sorted(((k, v) for k, v in ce.items() if k > snap.spot), key=lambda kv: -kv[1])][:3]
    wall_centre = None
    if supports and resistances:
        ps, cs = pe[supports[0]], ce[resistances[0]]
        if ps + cs > 0:
            wall_centre = (supports[0] * ps + resistances[0] * cs) / (ps + cs)

    tot_ce, tot_pe = sum(ce.values()), sum(pe.values())
    pcr_total = tot_pe / tot_ce if tot_ce else None
    near = sorted(strikes, key=lambda k: abs(k - fwd))[:11]
    near_ce, near_pe = sum(ce.get(k, 0) for k in near), sum(pe.get(k, 0) for k in near)
    pcr_atm = near_pe / near_ce if near_ce else None

    iv_by_strike: dict[tuple[float, str], float] = {}
    for o in snap.options:
        iv = implied_vol(_price(o), fwd, o.strike, T, o.opt_type)
        if iv is not None:
            iv_by_strike[(o.strike, o.opt_type)] = iv
    iv_at: dict[float, list[float]] = defaultdict(list)
    for (k, _), iv in iv_by_strike.items():
        iv_at[k].append(iv)
    atm_iv = None
    if iv_at:
        k_atm = min(iv_at, key=lambda k: abs(k - fwd))
        atm_iv = sum(iv_at[k_atm]) / len(iv_at[k_atm])
    sigma = fwd * atm_iv * math.sqrt(T) if atm_iv else None

    gamma_pin = None
    if sigma:
        best = -1.0
        for k in strikes:
            if abs(k - fwd) > 2 * sigma:
                continue
            ivk = sum(iv_at[k]) / len(iv_at[k]) if iv_at.get(k) else atm_iv
            g = (ce.get(k, 0) + pe.get(k, 0)) * gamma(fwd, k, T, ivk)
            if g > best:
                best, gamma_pin = g, k

    pivot = sum(prev_day_hlc) / 3 if prev_day_hlc else None
    momentum = snap.spot / close_3d_ago - 1 if close_3d_ago else None

    oi_now = {(o.strike, o.opt_type): o.oi for o in snap.options}
    oi_change = {k: v - oi_prev_close[k] for k, v in oi_now.items() if k in oi_prev_close}

    centres: dict[str, float] = {"forward": fwd}
    if max_pain is not None:
        centres["max_pain"] = max_pain
    if wall_centre is not None:
        centres["wall_centre"] = wall_centre
    if gamma_pin is not None:
        centres["gamma_pin"] = gamma_pin
    if sigma and pcr_atm is not None:
        centres["pcr"] = fwd + _clamp(pcr_atm - 1, -0.5, 0.5) * 0.5 * sigma
    if sigma and momentum is not None:
        centres["momentum"] = _clamp(fwd * (1 + 0.5 * momentum), fwd - sigma, fwd + sigma)
    if pivot is not None:
        centres["pivot"] = pivot

    quality = "low" if atm_iv is None or len(iv_by_strike) < MIN_VALID_IV else "ok"
    return Signals(
        forward=fwd, max_pain=max_pain, supports=supports, resistances=resistances, wall_centre=wall_centre,
        pcr_total=pcr_total, pcr_atm=pcr_atm, atm_iv=atm_iv, sigma_remaining=sigma, gamma_pin=gamma_pin,
        pivot=pivot, momentum_3d=momentum, oi_change=oi_change, centres=centres,
        iv_by_strike=iv_by_strike, quality=quality,
    )
