"""Dataclasses shared by every module, with JSON-friendly (de)serialisation."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime


def _k(key: tuple[float, str]) -> str:
    return f"{key[0]:g}|{key[1]}"


def _unk(s: str) -> tuple[float, str]:
    strike, t = s.split("|")
    return float(strike), t


def _band(v):
    return tuple(v) if v is not None else None


@dataclass
class OptionQuote:
    strike: float
    opt_type: str  # "CE" | "PE"
    ltp: float
    bid: float | None
    ask: float | None
    volume: int
    oi: int


@dataclass
class ChainSnapshot:
    underlying: str
    kind: str
    expiry: date
    future_expiry: date
    taken_at: datetime
    spot: float
    future: float
    vix: float | None
    options: list[OptionQuote]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["expiry"] = self.expiry.isoformat()
        d["future_expiry"] = self.future_expiry.isoformat()
        d["taken_at"] = self.taken_at.isoformat()
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ChainSnapshot":
        return cls(
            underlying=d["underlying"], kind=d["kind"],
            expiry=date.fromisoformat(d["expiry"]),
            future_expiry=date.fromisoformat(d["future_expiry"]),
            taken_at=datetime.fromisoformat(d["taken_at"]),
            spot=d["spot"], future=d["future"], vix=d["vix"],
            options=[OptionQuote(**o) for o in d["options"]],
        )


@dataclass
class Signals:
    forward: float
    max_pain: float | None
    supports: list[float]
    resistances: list[float]
    wall_centre: float | None
    pcr_total: float | None
    pcr_atm: float | None
    atm_iv: float | None
    sigma_remaining: float | None
    gamma_pin: float | None
    pivot: float | None
    momentum_3d: float | None
    oi_change: dict[tuple[float, str], int]
    centres: dict[str, float]
    iv_by_strike: dict[tuple[float, str], float]
    quality: str

    def to_dict(self) -> dict:
        d = asdict(self)
        d["oi_change"] = {_k(k): v for k, v in self.oi_change.items()}
        d["iv_by_strike"] = {_k(k): v for k, v in self.iv_by_strike.items()}
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Signals":
        d = dict(d)
        d["oi_change"] = {_unk(k): v for k, v in d["oi_change"].items()}
        d["iv_by_strike"] = {_unk(k): v for k, v in d["iv_by_strike"].items()}
        return cls(**d)


@dataclass
class WeightSet:
    weights: dict[str, float]
    k68: float
    k90: float
    version: str
    source: str  # "prior" | "backtest" | "live"


@dataclass
class Prediction:
    underlying: str
    kind: str
    expiry: date
    made_at: datetime
    dte_bucket: str
    centre: float
    band68: tuple[float, float] | None
    band90: tuple[float, float] | None
    probs_above: dict[float, float]
    weights: dict[str, float]
    weights_version: str
    signals: Signals
    note: str

    def to_dict(self) -> dict:
        return {
            "underlying": self.underlying, "kind": self.kind,
            "expiry": self.expiry.isoformat(), "made_at": self.made_at.isoformat(),
            "dte_bucket": self.dte_bucket, "centre": self.centre,
            "band68": list(self.band68) if self.band68 else None,
            "band90": list(self.band90) if self.band90 else None,
            "probs_above": {f"{k:g}": v for k, v in self.probs_above.items()},
            "weights": dict(self.weights), "weights_version": self.weights_version,
            "signals": self.signals.to_dict(), "note": self.note,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Prediction":
        return cls(
            underlying=d["underlying"], kind=d["kind"],
            expiry=date.fromisoformat(d["expiry"]),
            made_at=datetime.fromisoformat(d["made_at"]),
            dte_bucket=d["dte_bucket"], centre=d["centre"],
            band68=_band(d["band68"]), band90=_band(d["band90"]),
            probs_above={float(k): v for k, v in d["probs_above"].items()},
            weights=dict(d["weights"]), weights_version=d["weights_version"],
            signals=Signals.from_dict(d["signals"]), note=d["note"],
        )


@dataclass
class ScoreRow:
    underlying: str
    kind: str
    expiry: date
    made_at: datetime
    bucket: str
    centre: float
    sigma: float | None
    settlement: float
    err_pct: float
    in68: bool | None
    in90: bool | None
    signal_errs: dict[str, float] = field(default_factory=dict)
    forward_err_pct: float = 0.0
