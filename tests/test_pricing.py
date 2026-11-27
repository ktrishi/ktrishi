from datetime import date

import pytest

from conftest import ist_dt
from fo_dash.pricing import black76_price, gamma, implied_vol, year_fraction


def test_atm_call_price():
    assert black76_price(100, 100, 1.0, 0.2, "CE") == pytest.approx(7.9656, abs=1e-4)


def test_put_call_parity():
    c = black76_price(25200, 25000, 0.02, 0.14, "CE")
    p = black76_price(25200, 25000, 0.02, 0.14, "PE")
    assert c - p == pytest.approx(200, abs=1e-6)


def test_iv_roundtrip():
    px = black76_price(25200, 25400, 0.015, 0.15, "CE")
    assert implied_vol(px, 25200, 25400, 0.015, "CE") == pytest.approx(0.15, abs=1e-4)


def test_iv_none_below_intrinsic():
    assert implied_vol(150, 25200, 25000, 0.01, "CE") is None   # intrinsic is 200
    assert implied_vol(0, 25200, 25400, 0.01, "CE") is None


def test_gamma_peaks_at_the_money():
    g = [gamma(25200, k, 0.02, 0.14) for k in (24800, 25200, 25600)]
    assert g[1] > g[0] and g[1] > g[2]


def test_year_fraction_to_expiry_close():
    assert year_fraction(ist_dt(2026, 11, 23, 9, 30), date(2026, 11, 23)) == pytest.approx(6 / 24 / 365, rel=1e-6)
