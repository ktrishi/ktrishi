from datetime import date, timedelta

import pytest

from conftest import build_signals, ist_dt
from fo_dash.learner import refit, score, track_record
from fo_dash.models import Prediction, ScoreRow, WeightSet


@pytest.fixture
def locked_preds():
    def make(centre, band68):
        sig = build_signals(centres={"forward": 25350.0, "max_pain": 25300.0}, sigma_remaining=200.0, forward=25350.0)
        return [Prediction("NIFTY", "weekly", date(2026, 11, 23), ist_dt(2026, 11, 19, 9, 45), "2to5", centre, band68,
                           (centre - 329, centre + 329), {}, {"forward": 1.0}, "v", sig, "")]
    return make


@pytest.fixture
def score_rows():
    def make(n_expiries, errs, model_err=0.3):
        rows = []
        for j in range(n_expiries):
            e = date(2026, 1, 6) + timedelta(days=7 * j)
            rows.append(ScoreRow("NIFTY", "weekly", e, ist_dt(e.year, e.month, e.day, 9, 45), "le1", 25000.0, 100.0,
                                 25000.0 * (1 + model_err / 100), model_err, True, True, dict(errs),
                                 errs.get("forward", model_err)))
        return rows
    return make


def test_score_marks_band_hits(locked_preds):
    rows = score(locked_preds(centre=25300, band68=(25100, 25500)), settlement=25450)
    assert rows[0].in68 is True and rows[0].err_pct == pytest.approx((25300 - 25450) / 25450 * 100)
    assert rows[0].signal_errs["max_pain"] == pytest.approx((25300 - 25450) / 25450 * 100)
    assert rows[0].forward_err_pct == pytest.approx((25350 - 25450) / 25450 * 100)
    assert rows[0].bucket == "2to5" and rows[0].sigma == 200.0


def test_score_without_bands(locked_preds):
    rows = score(locked_preds(centre=25300, band68=None), settlement=25450)
    assert rows[0].in68 is None


def test_refit_shrinks_toward_prior(score_rows):
    prior = WeightSet({"forward": .5, "max_pain": .5}, 1.0, 1.645, "uncalibrated", "prior")
    rows = score_rows(n_expiries=10, errs={"forward": 0.4, "max_pain": 0.2})
    ws = refit(rows, prior, lam=10, now=ist_dt(2026, 11, 23, 15, 45))
    assert ws.weights["max_pain"] == pytest.approx(0.5 * 0.7727 + 0.25, abs=1e-3)
    assert sum(ws.weights.values()) == pytest.approx(1.0) and ws.source == "live"
    assert ws.version == "live-202611231545"


def test_single_expiry_cannot_swing_weights(score_rows):
    prior = WeightSet({"forward": .5, "max_pain": .5}, 1.0, 1.645, "uncalibrated", "prior")
    ws = refit(score_rows(n_expiries=1, errs={"forward": 5.0, "max_pain": 0.0}), prior, lam=10, now=ist_dt(2026, 11, 23, 15, 45))
    assert abs(ws.weights["max_pain"] - 0.5) <= 0.5 / 11 + 1e-9


def test_signal_without_data_keeps_prior_share(score_rows):
    prior = WeightSet({"forward": .4, "max_pain": .4, "pivot": .2}, 1.0, 1.645, "uncalibrated", "prior")
    ws = refit(score_rows(n_expiries=10, errs={"forward": 0.4, "max_pain": 0.2}), prior, lam=10, now=ist_dt(2026, 11, 23, 15, 45))
    assert ws.weights["pivot"] == pytest.approx(0.2) and sum(ws.weights.values()) == pytest.approx(1.0)


def test_bands_keep_prior_below_five_rows(score_rows):
    prior = WeightSet({"forward": 1.0}, 1.0, 1.645, "uncalibrated", "prior")
    ws = refit(score_rows(n_expiries=3, errs={"forward": 1.0}), prior, now=ist_dt(2026, 11, 23, 15, 45))
    assert (ws.k68, ws.k90) == (1.0, 1.645)


def test_bands_calibrate_from_coverage(score_rows):
    prior = WeightSet({"forward": 1.0}, 1.0, 1.645, "uncalibrated", "prior")
    ws = refit(score_rows(n_expiries=20, errs={"forward": 1.0}, model_err=1.0), prior, lam=0, now=ist_dt(2026, 11, 23, 15, 45))
    assert ws.k68 == pytest.approx(2.5, abs=1e-6)  # every miss is 250 points on sigma 100


def test_track_record_baseline_flag(score_rows):
    tr = track_record(score_rows(n_expiries=4, errs={"forward": 0.6}, model_err=0.9))
    assert tr["beats_baseline"] is False and tr["expiries"] == 4
    assert tr["within_1pct"] == 1.0 and tr["within_0_5pct"] == 0.0 and len(tr["last10"]) == 4
