from dataclasses import replace
from datetime import date, time

from conftest import ist_dt
from fo_dash.models import ScoreRow, WeightSet


def test_snapshot_roundtrip(store, sample_chain):
    store.save_snapshot(sample_chain)
    assert store.latest_snapshot("NIFTY", "monthly", date(2026, 11, 23)) == sample_chain
    assert store.last_snapshot_time(date(2026, 11, 19)) == sample_chain.taken_at
    assert store.snapshots_on(date(2026, 11, 19)) == 1
    assert store.latest_snapshot("NIFTY", "weekly", date(2026, 11, 23)) is None


def test_oi_before_uses_previous_snapshot(store, sample_chain):
    a = replace(sample_chain, taken_at=ist_dt(2026, 11, 18, 15, 25))
    b = replace(sample_chain, taken_at=ist_dt(2026, 11, 19, 10, 0),
                options=[replace(o, oi=o.oi + 10) for o in sample_chain.options])
    store.save_snapshot(a)
    store.save_snapshot(b)
    oi = store.oi_before("NIFTY", sample_chain.expiry, ist_dt(2026, 11, 19, 9, 15))
    assert oi[(25300.0, "CE")] == 800
    assert store.oi_before("NIFTY", sample_chain.expiry, ist_dt(2026, 11, 1, 9, 15)) == {}


def test_prediction_log(store, sample_prediction):
    p2 = replace(sample_prediction, made_at=ist_dt(2026, 11, 19, 15, 5), centre=25300.0)
    store.save_prediction(sample_prediction, locked=True, changed=True, reason="first prediction of the series")
    store.save_prediction(p2, locked=False, changed=False, reason="")
    locked = store.predictions("NIFTY", "weekly", date(2026, 11, 23))
    assert [lp.prediction for lp in locked] == [sample_prediction]
    assert locked[0].reason == "first prediction of the series" and locked[0].changed
    assert len(store.predictions("NIFTY", "weekly", date(2026, 11, 23), locked_only=False)) == 2
    assert store.last_locked("NIFTY", "weekly", date(2026, 11, 23)).prediction == sample_prediction
    assert store.latest_prediction("NIFTY", "weekly", date(2026, 11, 23)).prediction == p2
    assert store.locked_times(date(2026, 11, 19)) == {time(12, 30)}


def test_outcome_and_scores(store):
    store.save_outcome("NIFTY", date(2026, 11, 23), 25410.0)
    assert store.outcome("NIFTY", date(2026, 11, 23)) == 25410.0
    assert store.outcome("NIFTY", date(2026, 12, 1)) is None
    rows = [ScoreRow("NIFTY", "weekly", date(2026, 11, d), ist_dt(2026, 11, d - 1, 9, 45), "le1", 25300.0, 150.0,
                     25410.0, -0.43, True, True, {"forward": -0.1}, -0.1) for d in (10, 17, 23)]
    store.save_scores(rows)
    assert store.scores("NIFTY") == rows
    assert store.scores("NIFTY", "le1", last_n_expiries=2) == rows[1:]
    assert store.scores("NIFTY", "gt5") == []


def test_weights_latest_wins(store):
    a = WeightSet({"forward": 1.0}, 1.0, 1.645, "uncalibrated", "prior")
    b = WeightSet({"forward": 0.6, "max_pain": 0.4}, 1.1, 1.7, "live-1", "live")
    store.save_weights("NIFTY", "le1", a, ist_dt(2026, 11, 1, 15, 45))
    store.save_weights("NIFTY", "le1", b, ist_dt(2026, 11, 23, 15, 45))
    assert store.current_weights("NIFTY", "le1") == b
    assert store.current_weights("NIFTY", "gt5") is None
    assert [w[1] for w in store.weights_history("NIFTY")] == ["le1", "le1"]


def test_gaps_and_day_status(store):
    store.log_gap(ist_dt(2026, 11, 19, 10, 0), ist_dt(2026, 11, 19, 11, 30), "snapshots")
    store.log_gap(ist_dt(2026, 11, 19, 12, 30), None, "missed reassessment 12:30")
    assert store.gaps(date(2026, 11, 19)) == [
        (ist_dt(2026, 11, 19, 10, 0), ist_dt(2026, 11, 19, 11, 30), "snapshots"),
        (ist_dt(2026, 11, 19, 12, 30), None, "missed reassessment 12:30")]
    store.set_day_status(date(2026, 11, 19), "trading")
    store.set_day_status(date(2026, 11, 19), "holiday")
    assert store.day_status(date(2026, 11, 19)) == "holiday" and store.day_status(date(2026, 11, 20)) is None
