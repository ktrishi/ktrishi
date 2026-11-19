import math
from dataclasses import replace
from datetime import date

import pytest

from fo_dash.pricing import year_fraction
from fo_dash.signals import compute_signals


def test_oi_structure(sample_chain):
    s = compute_signals(sample_chain, {}, None, None)
    assert s.forward == 25200
    assert s.max_pain == 25200
    assert s.supports == [25100, 25000]
    assert s.resistances == [25300, 25400, 25200]
    assert s.wall_centre == pytest.approx(25206.67, abs=0.01)
    assert s.pcr_total == pytest.approx(2000 / 1900, abs=1e-4)


def test_atm_iv_and_sigma(sample_chain):
    s = compute_signals(sample_chain, {}, None, None)
    assert s.atm_iv == pytest.approx(0.14, abs=0.005)
    T = year_fraction(sample_chain.taken_at, sample_chain.expiry)
    assert s.sigma_remaining == pytest.approx(25200 * s.atm_iv * math.sqrt(T), rel=1e-6)
    assert s.quality == "ok"
    assert set(s.centres) == {"forward", "max_pain", "wall_centre", "gamma_pin", "pcr"}


def test_weekly_forward_scales_basis(sample_chain):
    snap = replace(sample_chain, kind="weekly", future_expiry=date(2026, 12, 29))
    s = compute_signals(snap, {}, None, None)
    assert 25180 < s.forward < 25200


def test_oi_change_and_pivot(sample_chain):
    s = compute_signals(sample_chain, {(25300.0, "CE"): 500}, (25400, 25100, 25228), 25000)
    assert s.oi_change[(25300.0, "CE")] == 300
    assert s.pivot == pytest.approx(25242.67, abs=0.01)
    assert s.momentum_3d == pytest.approx(0.0072, abs=1e-4)
    assert s.centres["pivot"] == pytest.approx(25242.67, abs=0.01)
    assert abs(s.centres["momentum"] - s.forward) <= s.sigma_remaining


def test_atm_iv_falls_back_and_flags_low_quality(sample_chain):
    bad = [replace(o, bid=0, ask=None, ltp=0) if o.strike != 25400 else o for o in sample_chain.options]
    s = compute_signals(replace(sample_chain, options=bad), {}, None, None)
    assert s.atm_iv is not None and s.quality == "low"
