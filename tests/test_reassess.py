from datetime import date

import pytest

from conftest import build_signals, ist_dt
from fo_dash.models import Prediction
from fo_dash.reassess import compare, fmt_level


@pytest.fixture
def pred():
    def make(centre, support=25000, pcr=1.0):
        sig = build_signals(supports=[support], resistances=[25500], pcr_atm=pcr)
        return Prediction("NIFTY", "weekly", date(2026, 11, 23), ist_dt(2026, 11, 19, 12, 30), "2to5", centre,
                          (centre - 200, centre + 200), (centre - 329, centre + 329), {}, {"forward": 1.0}, "v", sig, "")
    return make


def test_first_prediction(pred):
    assert compare(None, pred(25300), 0.003) == (True, "first prediction of the series")


def test_small_move_unchanged(pred):
    assert compare(pred(25300), pred(25350), 0.003) == (False, "no material change")


def test_centre_move_changed(pred):
    changed, reason = compare(pred(25300), pred(25400), 0.003)
    assert changed and reason == "centre 25,300 → 25,400"


def test_wall_shift_changed_even_if_centre_flat(pred):
    changed, reason = compare(pred(25300, support=25000, pcr=0.92), pred(25320, support=25300, pcr=1.15), 0.003)
    assert changed and reason == "centre 25,300 → 25,320; put wall 25,000 → 25,300; PCR 0.92 → 1.15"


def test_fmt_level_indian_grouping():
    assert fmt_level(62627.75) == "62,628" and fmt_level(102500) == "1,02,500" and fmt_level(950) == "950"
