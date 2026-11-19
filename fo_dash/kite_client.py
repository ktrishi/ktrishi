"""Thin, read-only wrapper over kiteconnect: daily token, batched + rate-limited quotes."""
from __future__ import annotations

import json
import time as _time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from kiteconnect.exceptions import TokenException

from fo_dash.config import IST, TOKEN_ROLLOVER

QUOTE_BATCH = 500
MIN_INTERVAL_S = 1.0


class LoginRequired(Exception):
    """No valid Kite session for today; the user must log in again."""


def _last_rollover(now: datetime) -> datetime:
    r = datetime.combine(now.date(), TOKEN_ROLLOVER, tzinfo=IST)
    return r if now >= r else r - timedelta(days=1)


class TokenStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def save(self, token: str, now: datetime) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"access_token": token, "saved_at": now.isoformat()}))

    def load(self, now: datetime) -> str | None:
        try:
            d = json.loads(self.path.read_text())
            saved = datetime.fromisoformat(d["saved_at"])
        except (OSError, ValueError, KeyError):
            return None
        return d["access_token"] if saved >= _last_rollover(now) else None


class KiteSource:
    def __init__(self, kite, token_store: TokenStore, api_secret: str, now_fn: Callable[[], datetime],
                 sleep_fn: Callable[[float], None] = _time.sleep):
        self.kite = kite
        self.tokens = token_store
        self.api_secret = api_secret
        self.now_fn = now_fn
        self.sleep_fn = sleep_fn
        self._last_call: float | None = None

    def login_url(self) -> str:
        return self.kite.login_url()

    def complete_login(self, request_token: str) -> None:
        data = self.kite.generate_session(request_token, api_secret=self.api_secret)
        token = data["access_token"]
        self.tokens.save(token, self.now_fn())
        self.kite.set_access_token(token)

    def is_logged_in(self) -> bool:
        token = self.tokens.load(self.now_fn())
        if token:
            self.kite.set_access_token(token)
            return True
        return False

    def _call(self, fn, *args, **kw):
        if not self.is_logged_in():
            raise LoginRequired("Kite login needed")
        if self._last_call is not None:
            wait = MIN_INTERVAL_S - (_time.monotonic() - self._last_call)
            if wait > 0:
                self.sleep_fn(wait)
        try:
            return fn(*args, **kw)
        except TokenException as e:
            raise LoginRequired(str(e)) from e
        finally:
            self._last_call = _time.monotonic()

    def instruments(self, exchange: str = "NFO") -> list[dict]:
        return self._call(self.kite.instruments, exchange)

    def quote(self, symbols: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(symbols), QUOTE_BATCH):
            out.update(self._call(self.kite.quote, symbols[i:i + QUOTE_BATCH]))
        return out

    def daily_candles(self, instrument_token: int, days: int) -> list[dict]:
        now = self.now_fn()
        rows = self._call(self.kite.historical_data, instrument_token, now - timedelta(days=days * 2 + 7), now, "day")
        return rows[-days:]
