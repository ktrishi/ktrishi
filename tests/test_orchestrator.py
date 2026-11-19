from datetime import date, time

from conftest import ist_dt


def test_snapshot_job_skips_when_logged_out(orch, clock, store):
    orch.source.logged_in = False
    clock.set(2026, 11, 19, 10, 0)
    orch.snapshot_job()
    assert orch.status["login"] == "login_needed" and store.last_snapshot_time(date(2026, 11, 19)) is None


def test_snapshot_job_saves_three_panels_two_snapshots(orch, clock, store):
    clock.set(2026, 11, 19, 10, 0)
    orch.morning_setup()
    orch.snapshot_job()
    assert store.latest_prediction("NIFTY", "weekly", date(2026, 11, 23)) is not None
    assert store.latest_prediction("NIFTY", "monthly", date(2026, 11, 23)) is not None
    assert store.latest_prediction("BANKNIFTY", "monthly", date(2026, 11, 23)) is not None
    assert store.snapshots_on(date(2026, 11, 19)) == 2   # NIFTY weekly==monthly shares one snapshot
    p = store.latest_prediction("NIFTY", "weekly", date(2026, 11, 23)).prediction
    assert p.band68 and p.signals.pivot is not None and p.signals.momentum_3d is not None


def test_snapshot_job_noop_outside_market_hours(orch, clock, store):
    clock.set(2026, 11, 19, 16, 0)
    orch.snapshot_job()
    assert store.snapshots_on(date(2026, 11, 19)) == 0


def test_gap_logged_after_sleep(orch, clock, store):
    clock.set(2026, 11, 19, 10, 0)
    orch.morning_setup()
    orch.snapshot_job()
    clock.set(2026, 11, 19, 11, 30)
    orch.snapshot_job()
    assert (ist_dt(2026, 11, 19, 10, 0), ist_dt(2026, 11, 19, 11, 30), "snapshots") in store.gaps(date(2026, 11, 19))


def test_missed_reassessment_logged_not_backfilled(orch, clock, store):
    clock.set(2026, 11, 19, 13, 0)
    orch.morning_setup()
    orch.check_missed_reassessments()
    orch.check_missed_reassessments()
    whats = [g[2] for g in store.gaps(date(2026, 11, 19))]
    assert whats.count("missed reassessment 09:45") == 1 and "missed reassessment 12:30" in whats
    assert "missed reassessment 15:05" not in whats
    assert store.predictions("NIFTY", "weekly", date(2026, 11, 23), locked_only=True) == []


def test_reassess_locks_and_notifies_on_change(orch, clock, store, notes):
    clock.set(2026, 11, 19, 9, 45)
    orch.morning_setup()
    orch.reassess_job(time(9, 45))
    assert len(notes) == 2 and "first prediction of the series" in notes[0][1]
    assert store.locked_times(date(2026, 11, 19)) == {time(9, 45)}
    clock.set(2026, 11, 19, 12, 30)
    orch.reassess_job(time(12, 30))
    assert len(notes) == 2   # nothing moved in the fake market
    assert store.last_locked("NIFTY", "weekly", date(2026, 11, 23)).reason == "no material change"


def test_reassess_when_logged_out_logs_miss(orch, clock, store):
    clock.set(2026, 11, 19, 9, 45)
    orch.source.logged_in = False
    orch.reassess_job(time(9, 45))
    assert [g[2] for g in store.gaps(date(2026, 11, 19))] == ["missed reassessment 09:45"]


def test_holiday_detected_and_jobs_noop(orch, clock, store):
    orch.source.index_timestamp = ist_dt(2026, 11, 18, 15, 30)
    clock.set(2026, 11, 19, 9, 20)
    orch.morning_setup()
    clock.set(2026, 11, 19, 13, 0)
    orch.snapshot_job()
    orch.check_missed_reassessments()
    assert store.day_status(date(2026, 11, 19)) == "holiday" and store.gaps(date(2026, 11, 19)) == []
    assert orch.status["day"] == "holiday"


def test_settle_job_scores_and_refits(orch, clock, store):
    clock.set(2026, 11, 23, 9, 45)
    orch.morning_setup()
    orch.reassess_job(time(9, 45))
    orch.source.index_close = 25410.0
    clock.set(2026, 11, 23, 15, 45)
    orch.settle_job()
    assert store.outcome("NIFTY", date(2026, 11, 23)) == 25410.0
    assert store.current_weights("NIFTY", "le1").source == "live"
    assert len(store.scores("NIFTY")) == 2   # weekly + monthly locked predictions


def test_start_registers_jobs(orch, clock):
    sched = orch.start(run=False)
    ids = {j.id for j in sched.get_jobs()}
    assert {"snapshot", "reassess-0945", "reassess-1230", "reassess-1505", "settle", "missed"} <= ids
