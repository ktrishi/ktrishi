from datetime import date

import pytest

from conftest import ist_dt
from fo_dash.models import WeightSet
from fo_dash.predict import PRIOR, dte_bucket, predict


def test_dte_buckets():
    assert dte_bucket(date(2026, 11, 19), date(2026, 11, 23)) == "2to5"
    assert dte_bucket(date(2026, 11, 20), date(2026, 11, 23)) == "le1"
    assert dte_bucket(date(2026, 11, 23), date(2026, 11, 23)) == "le1"
    assert dte_bucket(date(2026, 11, 12), date(2026, 11, 23)) == "gt5"


def test_prior_weights_sum_to_one():
    assert set(PRIOR) == {"gt5", "2to5", "le1"}
    for ws in PRIOR.values():
        assert sum(ws.weights.values()) == pytest.approx(1.0)
        assert (ws.source, ws.version, ws.k68, ws.k90) == ("prior", "uncalibrated", 1.0, 1.645)


def test_blend_renormalises_and_bands(make_signals):
    sig = make_signals(centres={"forward": 25000, "max_pain": 25200}, sigma_remaining=200,
                       supports=[25000], resistances=[25300], max_pain=25200)
    ws = WeightSet({"forward": .5, "max_pain": .5, "wall_centre": .2}, 1.0, 1.645, "v", "live")
    p = predict("NIFTY", "weekly", date(2026, 11, 23), ist_dt(2026, 11, 19, 12, 30), sig, ws)
    assert p.centre == pytest.approx(25100)
    assert p.band68 == pytest.approx((24900, 25300)) and p.band90 == pytest.approx((24771, 25429))
    assert p.probs_above[25300] == pytest.approx(0.1587, abs=1e-4)
    assert set(p.probs_above) == {25000, 25300, 25200}
    assert p.weights == pytest.approx({"forward": .5, "max_pain": .5})
    assert p.dte_bucket == "2to5" and "uncalibrated" not in p.note


def test_no_iv_means_no_bands_and_explicit_note(make_signals):
    p = predict("NIFTY", "weekly", date(2026, 11, 23), ist_dt(2026, 11, 19, 12, 30),
                make_signals(centres={"forward": 25000}, sigma_remaining=None), PRIOR["2to5"])
    assert p.band68 is None and p.probs_above == {}
    assert "range unavailable" in p.note and "uncalibrated" in p.note
