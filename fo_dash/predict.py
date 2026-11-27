"""Blend signal centres into a prediction with calibrated bands (spec §6.4)."""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fo_dash.models import Prediction, Signals, WeightSet
from fo_dash.pricing import norm_cdf


def _prior(w: dict[str, float]) -> WeightSet:
    return WeightSet(w, 1.0, 1.645, "uncalibrated", "prior")


PRIOR: dict[str, WeightSet] = {
    "gt5": _prior({"forward": .60, "max_pain": .10, "wall_centre": .10, "gamma_pin": .05, "pcr": .05, "momentum": .05, "pivot": .05}),
    "2to5": _prior({"forward": .45, "max_pain": .15, "wall_centre": .15, "gamma_pin": .10, "pcr": .05, "momentum": .05, "pivot": .05}),
    "le1": _prior({"forward": .35, "max_pain": .20, "wall_centre": .20, "gamma_pin": .15, "pcr": .05, "momentum": .025, "pivot": .025}),
}


def dte_bucket(today: date, expiry: date) -> str:
    n, d = 0, today + timedelta(days=1)
    while d <= expiry:
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return "le1" if n <= 1 else "2to5" if n <= 5 else "gt5"


def predict(underlying: str, kind: str, expiry: date, made_at: datetime, signals: Signals, ws: WeightSet) -> Prediction:
    used = {k: w for k, w in ws.weights.items() if k in signals.centres and w > 0}
    if not used:
        used = {"forward": 1.0}
    total = sum(used.values())
    weights = {k: w / total for k, w in used.items()}
    centre = sum(w * signals.centres[k] for k, w in weights.items())

    notes = []
    sigma = signals.sigma_remaining
    band68 = band90 = None
    probs: dict[float, float] = {}
    if sigma:
        band68 = (centre - ws.k68 * sigma, centre + ws.k68 * sigma)
        band90 = (centre - ws.k90 * sigma, centre + ws.k90 * sigma)
        keys = set(signals.supports) | set(signals.resistances)
        if signals.max_pain is not None:
            keys.add(signals.max_pain)
        probs = {k: 1 - norm_cdf((k - centre) / (ws.k68 * sigma)) for k in sorted(keys)}
    else:
        notes.append("no implied volatility — range unavailable")
    if ws.source == "prior":
        notes.append("uncalibrated")
    if signals.quality == "low":
        notes.append("low data quality")
    return Prediction(underlying, kind, expiry, made_at, dte_bucket(made_at.date(), expiry), centre, band68, band90,
                      probs, weights, ws.version, signals, "; ".join(notes))
