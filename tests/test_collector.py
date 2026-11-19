from datetime import date

from conftest import ist_dt, make_source
from fo_dash.collector import collect, option_symbols, strike_window
from fo_dash.config import UNDERLYINGS


def test_strike_window():
    w = strike_window(25371, 50)
    assert w[0] == 23350 and w[-1] == 27400 and all(k % 50 == 0 for k in w)


def test_option_symbols(instruments):
    syms = option_symbols(instruments, "NIFTY", date(2026, 11, 23), [25300.0])
    assert sorted(syms.values()) == [(25300.0, "CE"), (25300.0, "PE")]
    assert all(s.startswith("NFO:NIFTY") for s in syms)


def test_collect_builds_snapshot(fake_kite, tmp_path, instruments):
    snap = collect(make_source(fake_kite, tmp_path, logged_in=True), UNDERLYINGS[0], "weekly", date(2026, 11, 23),
                   date(2026, 11, 23), instruments, ist_dt(2026, 11, 19, 13, 0))
    assert snap.spot == 25371.1 and snap.future == 25397 and snap.vix == 16.25
    assert {o.opt_type for o in snap.options} == {"CE", "PE"} and len(snap.options) == 2 * len(strike_window(25371.1, 50))
    assert all(o.oi == 100000 for o in snap.options)
    atm = [o for o in snap.options if o.strike == 25350.0]
    assert atm and all(o.bid and o.ask and o.bid < o.ask for o in atm)
    assert all(o.bid is None for o in snap.options if o.ltp == 0.05)   # zero bid in depth -> None
