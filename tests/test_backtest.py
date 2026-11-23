import csv
import io
import zipfile
from datetime import date
from pathlib import Path

from conftest import ist_dt
from fo_dash.backtest.bhavcopy import download, parse
from fo_dash.backtest.run import build_eod_snapshots, run_backtest
from fo_dash.config import UNDERLYINGS

FIXTURES = Path(__file__).parent / "fixtures"


class FakeResp:
    def __init__(self, status, content=b""):
        self.status_code, self.content = status, content


class FakeSession:
    def __init__(self, status=404):
        self.status, self.calls = status, []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        return FakeResp(self.status)


OfflineSession = FakeSession


def write_fixture_as_daily_zips(src: Path, cache: Path) -> None:
    with open(src, newline="") as f:
        rows = list(csv.DictReader(f))
    by_day = {}
    for r in rows:
        by_day.setdefault(r["TradDt"], []).append(r)
    for day, rs in by_day.items():
        buf = io.StringIO()
        w = csv.DictWriter(buf, list(rs[0]))
        w.writeheader()
        w.writerows(rs)
        ymd = day.replace("-", "")
        name = f"BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv"
        with zipfile.ZipFile(cache / f"{name}.zip", "w") as z:
            z.writestr(name, buf.getvalue())


def test_parse_filters_symbols_and_types():
    rows = parse(FIXTURES / "bhavcopy_sample.csv", {"NIFTY"})
    assert {r.symbol for r in rows} == {"NIFTY"} and {r.instr for r in rows} == {"IDO", "IDF"}
    ce = next(r for r in rows if r.strike == 25300 and r.opt_type == "CE" and r.trade_date == date(2026, 11, 19))
    assert ce.oi > 0 and ce.underlying > 0 and ce.expiry == date(2026, 11, 23)


def test_eod_snapshot_shape():
    rows = [r for r in parse(FIXTURES / "bhavcopy_sample.csv", {"NIFTY"}) if r.trade_date == date(2026, 11, 19)]
    (snap,) = build_eod_snapshots(rows, UNDERLYINGS[0], "monthly")
    assert snap.expiry == date(2026, 11, 23) and snap.taken_at == ist_dt(2026, 11, 19, 15, 30) and len(snap.options) == 10
    assert snap.spot == 25180.0 and snap.future == 25200.0


def test_banknifty_without_future_yields_no_monthly():
    rows = [r for r in parse(FIXTURES / "bhavcopy_sample.csv", {"BANKNIFTY"}) if r.trade_date == date(2026, 11, 19)]
    assert build_eod_snapshots(rows, UNDERLYINGS[1], "monthly") == []


def test_run_backtest_with_cached_files(tmp_path, store):
    cache = tmp_path / "cache"
    cache.mkdir()
    write_fixture_as_daily_zips(FIXTURES / "bhavcopy_sample.csv", cache)
    report = run_backtest(store, date(2026, 11, 19), date(2026, 11, 23), cache, session=OfflineSession(), sleep_fn=lambda s: None)
    assert report["expiries"]["NIFTY"] == 1 and report["skipped_days"] == 1   # 20-Nov missing -> holiday
    assert store.current_weights("NIFTY", "2to5").source == "backtest"
    assert store.current_weights("NIFTY", "2to5").version == "backtest-20261123"


def test_download_404_is_holiday(tmp_path):
    assert download(date(2026, 11, 24), tmp_path, FakeSession(status=404)) is None


def test_download_uses_cache(tmp_path):
    write_fixture_as_daily_zips(FIXTURES / "bhavcopy_sample.csv", tmp_path)
    s = FakeSession(status=500)
    assert download(date(2026, 11, 19), tmp_path, s).exists() and s.calls == []


def test_run_backtest_reports_progress(tmp_path, store):
    cache = tmp_path / "cache"
    cache.mkdir()
    write_fixture_as_daily_zips(FIXTURES / "bhavcopy_sample.csv", cache)
    days = []
    run_backtest(store, date(2026, 11, 19), date(2026, 11, 23), cache, session=OfflineSession(),
                 sleep_fn=lambda s: None, progress_fn=days.append)
    assert days == [date(2026, 11, 19), date(2026, 11, 20), date(2026, 11, 23)]
