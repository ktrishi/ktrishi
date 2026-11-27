"""Score locked predictions against settlement and re-weight signals with shrinkage (spec §6.6)."""
from __future__ import annotations

from datetime import datetime

from fo_dash.models import Prediction, ScoreRow, WeightSet

__all__ = ["ScoreRow", "score", "refit", "track_record"]


def _pct(pred: float, actual: float) -> float:
    return (pred - actual) / actual * 100


def _within(band, x) -> bool | None:
    return None if band is None else band[0] <= x <= band[1]


def score(locked: list[Prediction], settlement: float) -> list[ScoreRow]:
    return [ScoreRow(
        underlying=p.underlying, kind=p.kind, expiry=p.expiry, made_at=p.made_at, bucket=p.dte_bucket,
        centre=p.centre, sigma=p.signals.sigma_remaining, settlement=settlement,
        err_pct=_pct(p.centre, settlement), in68=_within(p.band68, settlement), in90=_within(p.band90, settlement),
        signal_errs={k: _pct(c, settlement) for k, c in p.signals.centres.items()},
        forward_err_pct=_pct(p.signals.forward, settlement),
    ) for p in locked]


def _percentile(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    if len(xs) == 1:
        return xs[0]
    pos = q * (len(xs) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def refit(rows: list[ScoreRow], prior: WeightSet, lam: float = 10.0, now: datetime | None = None) -> WeightSet:
    now = now or datetime.now()
    n = len({r.expiry for r in rows})
    a = n / (n + lam) if n + lam > 0 else 0.0

    sq: dict[str, list[float]] = {}
    for r in rows:
        for k, e in r.signal_errs.items():
            sq.setdefault(k, []).append(e * e)
    inv = {k: 1.0 / (sum(v) / len(v) + 0.01) for k, v in sq.items()}

    universe = set(prior.weights) | set(inv)
    weights = {k: prior.weights.get(k, 0.0) for k in universe}
    mass = sum(prior.weights.get(k, 0.0) for k in inv)
    if inv and mass > 0:
        tot = sum(inv.values())
        for k in inv:
            data_share = inv[k] / tot
            prior_share = prior.weights.get(k, 0.0) / mass
            weights[k] = mass * (a * data_share + (1 - a) * prior_share)
    s = sum(weights.values())
    weights = {k: v / s for k, v in weights.items() if v > 0} if s > 0 else dict(prior.weights)

    k68, k90 = prior.k68, prior.k90
    z = [abs(r.settlement - r.centre) / r.sigma for r in rows if r.sigma]
    if len(z) >= 5:
        k68 = a * _percentile(z, 0.68) + (1 - a) * prior.k68
        k90 = a * _percentile(z, 0.90) + (1 - a) * prior.k90
    return WeightSet(weights, k68, k90, f"live-{now:%Y%m%d%H%M}", "live")


def track_record(rows: list[ScoreRow]) -> dict:
    if not rows:
        return {"expiries": 0, "mean_abs_err_pct": None, "forward_mean_abs_err_pct": None, "within_0_5pct": None,
                "within_1pct": None, "cov68": None, "cov90": None, "beats_baseline": None, "last10": []}
    n = len(rows)
    mae = sum(abs(r.err_pct) for r in rows) / n
    fmae = sum(abs(r.forward_err_pct) for r in rows) / n
    b68 = [r.in68 for r in rows if r.in68 is not None]
    b90 = [r.in90 for r in rows if r.in90 is not None]
    last: dict = {}
    for r in sorted(rows, key=lambda r: (r.expiry, r.made_at)):
        last[(r.kind, r.expiry)] = r
    per_exp = sorted(last.values(), key=lambda r: r.expiry)[-10:]
    return {
        "expiries": len({r.expiry for r in rows}),
        "mean_abs_err_pct": mae, "forward_mean_abs_err_pct": fmae,
        "within_0_5pct": sum(abs(r.err_pct) <= 0.5 for r in rows) / n,
        "within_1pct": sum(abs(r.err_pct) <= 1.0 for r in rows) / n,
        "cov68": sum(b68) / len(b68) if b68 else None,
        "cov90": sum(b90) / len(b90) if b90 else None,
        "beats_baseline": mae < fmae,
        "last10": [{"kind": r.kind, "expiry": r.expiry.isoformat(), "centre": r.centre, "settlement": r.settlement,
                    "err_pct": r.err_pct, "in68": r.in68} for r in per_exp],
    }
