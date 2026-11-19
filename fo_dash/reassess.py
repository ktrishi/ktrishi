"""Decide whether a reassessment changed the view, and say why in plain words."""
from __future__ import annotations

from fo_dash.models import Prediction


def fmt_level(x: float) -> str:
    n = int(round(x))
    sign, s = ("-" if n < 0 else ""), str(abs(n))
    if len(s) <= 3:
        return sign + s
    head, tail = s[:-3], s[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return sign + ",".join(groups + [tail])


def _first(xs: list[float]) -> float | None:
    return xs[0] if xs else None


def compare(prev: Prediction | None, cur: Prediction, threshold: float) -> tuple[bool, str]:
    if prev is None:
        return True, "first prediction of the series"
    ps, cs = _first(prev.signals.supports), _first(cur.signals.supports)
    pr, cr = _first(prev.signals.resistances), _first(cur.signals.resistances)
    moved = prev.centre and abs(cur.centre - prev.centre) / prev.centre > threshold
    walls = ps != cs or pr != cr
    if not (moved or walls):
        return False, "no material change"

    def lv(x):
        return fmt_level(x) if x is not None else "none"

    items = []
    if round(cur.centre) != round(prev.centre):
        items.append(f"centre {fmt_level(prev.centre)} → {fmt_level(cur.centre)}")
    if ps != cs:
        items.append(f"put wall {lv(ps)} → {lv(cs)}")
    if pr != cr:
        items.append(f"call wall {lv(pr)} → {lv(cr)}")
    pp, cp = prev.signals.pcr_atm, cur.signals.pcr_atm
    if pp is not None and cp is not None and abs(cp - pp) >= 0.05:
        items.append(f"PCR {pp:.2f} → {cp:.2f}")
    return True, "; ".join(items)
