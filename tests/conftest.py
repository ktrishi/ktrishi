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
