import pytest

from conftest import ist_dt, make_source
from fo_dash.kite_client import LoginRequired, TokenStore


def test_token_invalid_after_0600_rollover(tmp_path):
    ts = TokenStore(tmp_path / "token.json")
    ts.save("abc", ist_dt(2026, 11, 19, 9, 0))
    assert ts.load(ist_dt(2026, 11, 19, 23, 0)) == "abc"
    assert ts.load(ist_dt(2026, 11, 20, 5, 59)) == "abc"
    assert ts.load(ist_dt(2026, 11, 20, 6, 0)) is None
    assert TokenStore(tmp_path / "missing.json").load(ist_dt(2026, 11, 20, 9, 0)) is None


def test_quote_batches_500_and_rate_limits(fake_kite, tmp_path):
    sleeps = []
    src = make_source(fake_kite, tmp_path, sleep_fn=sleeps.append, logged_in=True)
    src.quote([f"NFO:X{i}" for i in range(1200)])
    assert [len(c) for c in fake_kite.quote_calls] == [500, 500, 200] and len(sleeps) == 2


def test_token_exception_becomes_login_required(fake_kite, tmp_path):
    fake_kite.raise_token_error = True
    with pytest.raises(LoginRequired):
        make_source(fake_kite, tmp_path, logged_in=True).quote(["NSE:NIFTY 50"])


def test_logged_out_raises_login_required(fake_kite, tmp_path):
    src = make_source(fake_kite, tmp_path, logged_in=False)
    assert src.is_logged_in() is False
    with pytest.raises(LoginRequired):
        src.quote(["NSE:NIFTY 50"])


def test_complete_login_saves_token(fake_kite, tmp_path):
    src = make_source(fake_kite, tmp_path, logged_in=False)
    src.complete_login("rt")
    assert src.is_logged_in() and fake_kite.access_token == "tok-rt"


def test_rejected_token_is_cleared(fake_kite, tmp_path):
    src = make_source(fake_kite, tmp_path, logged_in=True)
    fake_kite.raise_token_error = True
    with pytest.raises(LoginRequired):
        src.quote(["NSE:NIFTY 50"])
    assert src.is_logged_in() is False


def test_rate_limit_holds_across_threads(fake_kite, tmp_path):
    import threading
    sleeps = []
    src = make_source(fake_kite, tmp_path, sleep_fn=sleeps.append, logged_in=True)
    entered = threading.Event()
    real = fake_kite.quote

    def slow_quote(*a):
        entered.set()
        threading.Event().wait(0.3)
        return real(*a)
    fake_kite.quote = slow_quote
    t1 = threading.Thread(target=lambda: src.quote(["NSE:NIFTY 50"]))
    t1.start()
    entered.wait(2)
    src.quote(["NSE:NIFTY 50"])
    t1.join()
    assert len(sleeps) == 1
