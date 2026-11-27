import pytest

from fo_dash.__main__ import main


def test_cli_help_lists_commands(capsys):
    with pytest.raises(SystemExit):
        main(["--help"])
    out = capsys.readouterr().out
    assert all(c in out for c in ("run", "backtest", "status"))


def test_backtest_defaults_to_full_history_until_today(monkeypatch, tmp_path):
    import fo_dash.backtest.run as run
    from datetime import date
    seen = {}

    def fake(store, start, end, cache_dir, session, progress_fn=None):
        seen.update(start=start, end=end)
        return {"days": 0, "skipped_days": 0, "expiries": {}, "track_record": {}}
    monkeypatch.setattr(run, "run_backtest", fake)
    monkeypatch.setenv("FO_DATA_DIR", str(tmp_path))
    assert main(["backtest"]) == 0
    assert seen["start"] == date(2024, 7, 8) and seen["end"] >= date(2026, 11, 19)


def test_backtest_bat_runs_setup_then_backtest():
    from pathlib import Path
    bat = (Path(__file__).parent.parent / "backtest.bat").read_bytes().decode()
    assert "\r\n" in bat and "call setup.bat" in bat and "-m fo_dash backtest" in bat and "pause" in bat


def test_demo_seeds_three_panels():
    from fo_dash.demo import build_demo
    store, orch, source, now_fn = build_demo()
    from fo_dash.web.state import build_state
    st = build_state(store, orch, now_fn())
    assert [p["key"] for p in st["panels"]] == ["NIFTY-weekly", "NIFTY-monthly", "BANKNIFTY-monthly"]
    assert all(p["prediction"]["band68"] for p in st["panels"]) and len(st["panels"][0]["drift"]) == 2
    assert st["status"]["login"] == "ok"


def test_demo_bat_runs_setup_then_demo():
    from pathlib import Path
    bat = (Path(__file__).parent.parent / "demo.bat").read_bytes().decode()
    assert "\r\n" in bat and "call setup.bat" in bat and "-m fo_dash run --demo" in bat


def test_setup_bat_accepts_newer_python():
    from pathlib import Path
    bat = (Path(__file__).parent.parent / "setup.bat").read_bytes().decode()
    assert "py -3.14" in bat and "py -3.13" in bat and "version_info >= (3, 12)" in bat and "\r\n" in bat
