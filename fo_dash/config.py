"""Constants and settings. Underlyings are data: add one here, nowhere else."""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

IST = ZoneInfo("Asia/Kolkata")


@dataclass(frozen=True)
class UnderlyingConfig:
    name: str
    spot_symbol: str
    strike_step: int
    kinds: tuple[str, ...]
    change_threshold: float


UNDERLYINGS: tuple[UnderlyingConfig, ...] = (
    UnderlyingConfig("NIFTY", "NSE:NIFTY 50", 50, ("weekly", "monthly"), 0.003),
    UnderlyingConfig("BANKNIFTY", "NSE:NIFTY BANK", 100, ("monthly",), 0.004),
)

VIX_SYMBOL = "NSE:INDIA VIX"
STRIKE_WINDOW_PCT = 0.08
SNAPSHOT_MINUTES = 5
REASSESS_TIMES = (time(9, 45), time(12, 30), time(15, 5))
SETTLE_TIME = time(15, 45)
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)
HOLIDAY_CHECK = time(9, 20)
TOKEN_ROLLOVER = time(6, 0)
STALE_MINUTES = 10
HOST = "127.0.0.1"
PORT = 8050

SIGNAL_NAMES = ("forward", "max_pain", "wall_centre", "gamma_pin", "pcr", "momentum", "pivot")
BUCKETS = ("gt5", "2to5", "le1")


@dataclass
class Settings:
    api_key: str
    api_secret: str
    data_dir: Path


def load_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(env_file if env_file else Path(".env"), override=False)
    data_dir = Path(os.environ.get("FO_DATA_DIR", "./data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        api_key=os.environ.get("KITE_API_KEY", ""),
        api_secret=os.environ.get("KITE_API_SECRET", ""),
        data_dir=data_dir,
    )
