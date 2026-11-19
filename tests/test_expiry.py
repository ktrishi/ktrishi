from datetime import date

from conftest import ist_dt
from fo_dash.config import UNDERLYINGS
from fo_dash.expiry import future_expiry_for, select_expiries

NIFTY, BANK = UNDERLYINGS


def test_coinciding_weekly_and_monthly(instruments):
    assert select_expiries(instruments, NIFTY, ist_dt(2026, 11, 19, 13, 0)) == {"weekly": date(2026, 11, 23), "monthly": date(2026, 11, 23)}


def test_still_current_during_expiry_day(instruments):
    assert select_expiries(instruments, NIFTY, ist_dt(2026, 11, 23, 15, 0))["weekly"] == date(2026, 11, 23)


def test_rolls_after_close_on_expiry_day(instruments):
    assert select_expiries(instruments, NIFTY, ist_dt(2026, 11, 23, 15, 31)) == {"weekly": date(2026, 12, 1), "monthly": date(2026, 12, 29)}


def test_banknifty_monthly_only(instruments):
    assert select_expiries(instruments, BANK, ist_dt(2026, 11, 19, 13, 0)) == {"monthly": date(2026, 11, 23)}


def test_future_for_weekly(instruments):
    assert future_expiry_for(instruments, NIFTY, date(2026, 12, 8)) == date(2026, 12, 29)
