from datetime import date, datetime

import pytest

from fo_dash.config import IST


def ist_dt(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=IST)


@pytest.fixture
def sample_signals():
    from fo_dash.models import Signals
    return Signals(
        forward=25200.0, max_pain=25200.0, supports=[25100.0, 25000.0],
        resistances=[25300.0, 25400.0], wall_centre=25206.67, pcr_total=1.05,
        pcr_atm=1.05, atm_iv=0.14, sigma_remaining=180.0, gamma_pin=25200.0,
        pivot=25242.67, momentum_3d=0.0072, oi_change={(25300.0, "CE"): 300},
        centres={"forward": 25200.0, "max_pain": 25200.0},
        iv_by_strike={(25200.0, "CE"): 0.14}, quality="ok",
    )


@pytest.fixture
def sample_prediction(sample_signals):
    from fo_dash.models import Prediction
    return Prediction(
        underlying="NIFTY", kind="weekly", expiry=date(2026, 11, 23),
        made_at=ist_dt(2026, 11, 19, 12, 30), dte_bucket="2to5", centre=25200.0,
        band68=(25020.0, 25380.0), band90=(24903.9, 25496.1),
        probs_above={25300.0: 0.29}, weights={"forward": 0.5, "max_pain": 0.5},
        weights_version="uncalibrated", signals=sample_signals, note="uncalibrated",
    )


def _opts(name, expiry, lo, hi, step, tok):
    out = []
    ymon = expiry.strftime("%y%b").upper()
    for k in range(lo, hi + step, step):
        for t in ("CE", "PE"):
            tok[0] += 1
            out.append({"instrument_token": tok[0], "tradingsymbol": f"{name}{ymon}{k}{t}",
                        "name": name, "expiry": expiry, "strike": float(k), "lot_size": 65,
                        "instrument_type": t, "segment": "NFO-OPT", "exchange": "NFO"})
    return out


def _fut(name, expiry, tok):
    tok[0] += 1
    return {"instrument_token": tok[0], "tradingsymbol": f"{name}{expiry.strftime('%y%b').upper()}FUT",
            "name": name, "expiry": expiry, "strike": 0.0, "lot_size": 65,
            "instrument_type": "FUT", "segment": "NFO-FUT", "exchange": "NFO"}


def build_instruments():
    tok = [1000]
    out = []
    for e in (date(2026, 11, 23), date(2026, 12, 1), date(2026, 12, 8), date(2026, 12, 29)):
        out += _opts("NIFTY", e, 23000, 27800, 50, tok)
    out += [_fut("NIFTY", date(2026, 11, 23), tok), _fut("NIFTY", date(2026, 12, 29), tok)]
    for e in (date(2026, 11, 23), date(2026, 12, 29)):
        out += _opts("BANKNIFTY", e, 57600, 67600, 100, tok)
        out.append(_fut("BANKNIFTY", e, tok))
    return out


@pytest.fixture
def instruments():
    return build_instruments()


def build_sample_chain(taken_at=None, kind="monthly"):
    from fo_dash.models import ChainSnapshot, OptionQuote
    from fo_dash.pricing import black76_price, year_fraction
    taken_at = taken_at or ist_dt(2026, 11, 19, 13, 0)
    expiry = date(2026, 11, 23)
    T = year_fraction(taken_at, expiry)
    ce_oi = [100, 200, 300, 800, 500]
    pe_oi = [600, 700, 400, 200, 100]
    opts = []
    for i, k in enumerate(range(25000, 25500, 100)):
        for t, oi in (("CE", ce_oi[i]), ("PE", pe_oi[i])):
            px = round(black76_price(25200, k, T, 0.14, t) / 0.05) * 0.05
            opts.append(OptionQuote(float(k), t, px, round(px - 0.5, 2), round(px + 0.5, 2), 1000, oi))
    return ChainSnapshot("NIFTY", kind, expiry, expiry, taken_at, 25180.0, 25200.0, 16.25, opts)


@pytest.fixture
def sample_chain():
    return build_sample_chain()


@pytest.fixture
def store():
    from fo_dash.storage import Store
    return Store(":memory:")


def build_signals(**kw):
    from fo_dash.models import Signals
    base = dict(forward=25200.0, max_pain=None, supports=[], resistances=[], wall_centre=None, pcr_total=None,
                pcr_atm=None, atm_iv=0.14, sigma_remaining=200.0, gamma_pin=None, pivot=None, momentum_3d=None,
                oi_change={}, centres={"forward": 25200.0}, iv_by_strike={}, quality="ok")
    base.update(kw)
    return Signals(**base)


@pytest.fixture
def make_signals():
    return build_signals


class FakeKite:
    """Stands in for kiteconnect.KiteConnect; quotes in the SDK's shape."""

    SPOTS = {"NSE:NIFTY 50": (25371.1, 256265), "NSE:NIFTY BANK": (62627.75, 260105), "NSE:INDIA VIX": (16.25, 264969)}
    FUTS = {"NIFTY": 25397.0, "BANKNIFTY": 62700.0}

    def __init__(self, instruments=None, now=None, now_fn=None):
        self.instr = {i["tradingsymbol"]: i for i in (instruments or build_instruments())}
        self._now = now or ist_dt(2026, 11, 19, 13, 0)
        self.now_fn = now_fn
        self.quote_calls = []
        self.raise_token_error = False
        self.access_token = None
        self.index_timestamp = None
        self.index_close = 25410.0
        self.oi = 100000

    @property
    def now(self):
        return self.now_fn() if self.now_fn else self._now

    def login_url(self):
        return "https://kite.zerodha.com/connect/login?v=3&api_key=k"

    def generate_session(self, request_token, api_secret):
        return {"access_token": f"tok-{request_token}"}

    def set_access_token(self, t):
        self.access_token = t

    def instruments(self, exchange=None):
        return list(self.instr.values())

    def _q(self, last, token=0, oi=0, ts=None, bid=0.0, ask=0.0):
        ts = ts or self.now
        return {"instrument_token": token, "timestamp": ts, "last_price": last, "volume": 1000, "oi": oi,
                "ohlc": {"open": last, "high": last, "low": last, "close": last},
                "depth": {"buy": [{"price": bid, "quantity": 65, "orders": 1}],
                          "sell": [{"price": ask, "quantity": 65, "orders": 1}]}}

    def quote(self, *instruments):
        from kiteconnect.exceptions import TokenException
        from fo_dash.pricing import black76_price, year_fraction
        ins = instruments[0] if instruments and isinstance(instruments[0], list) else list(instruments)
        self.quote_calls.append(list(ins))
        if self.raise_token_error:
            raise TokenException("Incorrect `api_key` or `access_token`.")
        out = {}
        for s in ins:
            if s in self.SPOTS:
                px, tok = self.SPOTS[s]
                out[s] = self._q(px, tok, ts=self.index_timestamp or self.now)
                continue
            i = self.instr.get(s.split(":", 1)[1])
            if i is None:
                out[s] = self._q(1.0)
            elif i["instrument_type"] == "FUT":
                out[s] = self._q(self.FUTS[i["name"]], i["instrument_token"], oi=self.oi)
            else:
                F = self.FUTS[i["name"]]
                px = max(0.05, round(black76_price(F, i["strike"], year_fraction(self.now, i["expiry"]), 0.14,
                                                   i["instrument_type"]) / 0.05) * 0.05)
                out[s] = self._q(px, i["instrument_token"], oi=self.oi, bid=round(px - 0.05, 2), ask=round(px + 0.05, 2))
        return out

    def historical_data(self, instrument_token, from_date, to_date, interval, continuous=False, oi=False):
        from datetime import timedelta
        d = to_date.date() if hasattr(to_date, "date") else to_date
        closes = [25000.0, 25100.0, 25228.0, self.index_close]
        out = []
        for j, c in enumerate(closes):
            day = d - timedelta(days=len(closes) - 1 - j)
            out.append({"date": ist_dt(day.year, day.month, day.day), "open": c, "high": c + 150, "low": c - 150,
                        "close": c, "volume": 0})
        return out


@pytest.fixture
def fake_kite():
    return FakeKite()


def make_source(fake, tmp_path, sleep_fn=lambda s: None, logged_in=True, now=None):
    from fo_dash.kite_client import KiteSource, TokenStore
    now = now or ist_dt(2026, 11, 19, 13, 0)
    ts = TokenStore(tmp_path / "token.json")
    if logged_in:
        ts.save("abc", now)
    return KiteSource(fake, ts, "secret", now_fn=lambda: now, sleep_fn=sleep_fn)


class FakeClock:
    def __init__(self):
        self.t = ist_dt(2026, 11, 19, 10, 0)

    def set(self, y, m, d, hh, mm):
        self.t = ist_dt(y, m, d, hh, mm)

    def now(self):
        return self.t


def build_fake_source(clock):
    import os
    from pathlib import Path
    from fo_dash.kite_client import KiteSource, TokenStore

    class FakeSource(KiteSource):
        def __init__(self):
            super().__init__(FakeKite(now_fn=clock.now), TokenStore(Path(os.devnull)), "secret", clock.now,
                             sleep_fn=lambda s: None)
            self.logged_in = True
            self.completed_with = None

        def is_logged_in(self):
            return self.logged_in

        def complete_login(self, request_token):
            self.completed_with = request_token
            self.logged_in = True

        @property
        def index_timestamp(self):
            return self.kite.index_timestamp

        @index_timestamp.setter
        def index_timestamp(self, v):
            self.kite.index_timestamp = v

        @property
        def index_close(self):
            return self.kite.index_close

        @index_close.setter
        def index_close(self, v):
            self.kite.index_close = v

    return FakeSource()


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def notes():
    return []


@pytest.fixture
def orch(store, clock, notes):
    from fo_dash.orchestrator import Orchestrator
    return Orchestrator(store, build_fake_source(clock), clock.now,
                        notify_fn=lambda t, b: notes.append((t, b)), keep_awake_fn=lambda on: None)


@pytest.fixture
def client(store, orch, clock):
    from fastapi.testclient import TestClient
    from fo_dash.web.app import create_app
    return TestClient(create_app(store, orch, orch.source, clock.now))
