import pytest

from fo_dash.__main__ import main


def test_cli_help_lists_commands(capsys):
    with pytest.raises(SystemExit):
        main(["--help"])
    out = capsys.readouterr().out
    assert all(c in out for c in ("run", "backtest", "status"))


def test_backtest_requires_dates():
    with pytest.raises(SystemExit):
        main(["backtest"])


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
