"""SQLite store. All datetimes are IST-aware and stored as ISO text, so text order is time order."""
from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import asdict, dataclass
from datetime import date, datetime, time
from pathlib import Path

from fo_dash.models import ChainSnapshot, Prediction, ScoreRow, WeightSet

_SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, underlying TEXT, kind TEXT, expiry TEXT,
    taken_at TEXT, body TEXT);
CREATE INDEX IF NOT EXISTS ix_snap ON snapshots(underlying, expiry, taken_at);
CREATE TABLE IF NOT EXISTS predictions (id INTEGER PRIMARY KEY, underlying TEXT, kind TEXT, expiry TEXT,
    made_at TEXT, locked INTEGER, changed INTEGER, reason TEXT, body TEXT);
CREATE INDEX IF NOT EXISTS ix_pred ON predictions(underlying, kind, expiry, made_at);
CREATE TABLE IF NOT EXISTS outcomes (underlying TEXT, expiry TEXT, settlement REAL, PRIMARY KEY(underlying, expiry));
CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, underlying TEXT, kind TEXT, expiry TEXT, made_at TEXT,
    bucket TEXT, centre REAL, sigma REAL, settlement REAL, err_pct REAL, in68 INTEGER, in90 INTEGER,
    signal_errs_json TEXT, forward_err_pct REAL);
CREATE TABLE IF NOT EXISTS weights (id INTEGER PRIMARY KEY, underlying TEXT, bucket TEXT, created_at TEXT, body TEXT);
CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY, start TEXT, end_ TEXT, what TEXT);
CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, status TEXT);
"""


@dataclass
class LoggedPrediction:
    prediction: Prediction
    locked: bool
    changed: bool
    reason: str


def _b(v):
    return None if v is None else bool(v)


class Store:
    def __init__(self, path: Path | str):
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(_SCHEMA)

    def _w(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.lastrowid

    def _r(self, sql: str, args: tuple = ()) -> list[tuple]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    # snapshots
    def save_snapshot(self, s: ChainSnapshot) -> int:
        return self._w("INSERT INTO snapshots(underlying, kind, expiry, taken_at, body) VALUES (?,?,?,?,?)",
                       (s.underlying, s.kind, s.expiry.isoformat(), s.taken_at.isoformat(), json.dumps(s.to_dict())))

    def latest_snapshot(self, underlying: str, kind: str, expiry: date) -> ChainSnapshot | None:
        r = self._r("SELECT body FROM snapshots WHERE underlying=? AND kind=? AND expiry=? ORDER BY taken_at DESC, id DESC LIMIT 1",
                    (underlying, kind, expiry.isoformat()))
        return ChainSnapshot.from_dict(json.loads(r[0][0])) if r else None

    def last_snapshot_time(self, day: date) -> datetime | None:
        r = self._r("SELECT MAX(taken_at) FROM snapshots WHERE substr(taken_at,1,10)=?", (day.isoformat(),))
        return datetime.fromisoformat(r[0][0]) if r and r[0][0] else None

    def snapshots_on(self, day: date) -> int:
        return self._r("SELECT COUNT(*) FROM snapshots WHERE substr(taken_at,1,10)=?", (day.isoformat(),))[0][0]

    def oi_before(self, underlying: str, expiry: date, before: datetime) -> dict[tuple[float, str], int]:
        r = self._r("SELECT body FROM snapshots WHERE underlying=? AND expiry=? AND taken_at<? ORDER BY taken_at DESC, id DESC LIMIT 1",
                    (underlying, expiry.isoformat(), before.isoformat()))
        if not r:
            return {}
        return {(o.strike, o.opt_type): o.oi for o in ChainSnapshot.from_dict(json.loads(r[0][0])).options}

    # predictions
    def save_prediction(self, p: Prediction, locked: bool, changed: bool, reason: str) -> int:
        return self._w("INSERT INTO predictions(underlying, kind, expiry, made_at, locked, changed, reason, body) VALUES (?,?,?,?,?,?,?,?)",
                       (p.underlying, p.kind, p.expiry.isoformat(), p.made_at.isoformat(), int(locked), int(changed),
                        reason, json.dumps(p.to_dict())))

    def _preds(self, where: str, args: tuple, order: str = "ASC", limit: str = "") -> list[LoggedPrediction]:
        rows = self._r(f"SELECT body, locked, changed, reason FROM predictions WHERE {where} ORDER BY made_at {order}, id {order} {limit}", args)
        return [LoggedPrediction(Prediction.from_dict(json.loads(b)), bool(l), bool(c), r) for b, l, c, r in rows]

    def predictions(self, underlying: str, kind: str, expiry: date, locked_only: bool = True) -> list[LoggedPrediction]:
        where = "underlying=? AND kind=? AND expiry=?" + (" AND locked=1" if locked_only else "")
        return self._preds(where, (underlying, kind, expiry.isoformat()))

    def last_locked(self, underlying: str, kind: str, expiry: date) -> LoggedPrediction | None:
        r = self._preds("underlying=? AND kind=? AND expiry=? AND locked=1", (underlying, kind, expiry.isoformat()), "DESC", "LIMIT 1")
        return r[0] if r else None

    def latest_prediction(self, underlying: str, kind: str, expiry: date) -> LoggedPrediction | None:
        r = self._preds("underlying=? AND kind=? AND expiry=?", (underlying, kind, expiry.isoformat()), "DESC", "LIMIT 1")
        return r[0] if r else None

    def locked_times(self, day: date) -> set[time]:
        rows = self._r("SELECT made_at FROM predictions WHERE locked=1 AND substr(made_at,1,10)=?", (day.isoformat(),))
        return {datetime.fromisoformat(m).time().replace(second=0, microsecond=0) for (m,) in rows}

    # outcomes & scores
    def save_outcome(self, underlying: str, expiry: date, settlement: float) -> None:
        self._w("INSERT OR REPLACE INTO outcomes VALUES (?,?,?)", (underlying, expiry.isoformat(), settlement))

    def outcome(self, underlying: str, expiry: date) -> float | None:
        r = self._r("SELECT settlement FROM outcomes WHERE underlying=? AND expiry=?", (underlying, expiry.isoformat()))
        return r[0][0] if r else None

    def unsettled_expiries(self, underlying: str) -> list[date]:
        rows = self._r("SELECT DISTINCT expiry FROM predictions WHERE underlying=? AND locked=1 AND expiry NOT IN "
                       "(SELECT expiry FROM outcomes WHERE underlying=?) ORDER BY expiry", (underlying, underlying))
        return [date.fromisoformat(e) for (e,) in rows]

    def save_scores(self, rows: list[ScoreRow]) -> None:
        for s in rows:
            self._w("INSERT INTO scores(underlying, kind, expiry, made_at, bucket, centre, sigma, settlement, err_pct, in68, in90,"
                    " signal_errs_json, forward_err_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (s.underlying, s.kind, s.expiry.isoformat(), s.made_at.isoformat(), s.bucket, s.centre, s.sigma,
                     s.settlement, s.err_pct, None if s.in68 is None else int(s.in68),
                     None if s.in90 is None else int(s.in90), json.dumps(s.signal_errs), s.forward_err_pct))

    def scores(self, underlying: str, bucket: str | None = None, last_n_expiries: int | None = None) -> list[ScoreRow]:
        where, args = "underlying=?", [underlying]
        if bucket:
            where += " AND bucket=?"
            args.append(bucket)
        if last_n_expiries:
            exp = [e for (e,) in self._r(f"SELECT DISTINCT expiry FROM scores WHERE {where} ORDER BY expiry DESC LIMIT ?",
                                         (*args, last_n_expiries))]
            if not exp:
                return []
            where += f" AND expiry IN ({','.join('?' * len(exp))})"
            args += exp
        rows = self._r(f"SELECT underlying, kind, expiry, made_at, bucket, centre, sigma, settlement, err_pct, in68, in90,"
                       f" signal_errs_json, forward_err_pct FROM scores WHERE {where} ORDER BY expiry, made_at, id", tuple(args))
        return [ScoreRow(u, k, date.fromisoformat(e), datetime.fromisoformat(m), b, c, sg, st, ep, _b(i68), _b(i90),
                         json.loads(se), fe) for u, k, e, m, b, c, sg, st, ep, i68, i90, se, fe in rows]

    # weights
    def save_weights(self, underlying: str, bucket: str, ws: WeightSet, created_at: datetime) -> None:
        self._w("INSERT INTO weights(underlying, bucket, created_at, body) VALUES (?,?,?,?)",
                (underlying, bucket, created_at.isoformat(), json.dumps(asdict(ws))))

    def current_weights(self, underlying: str, bucket: str) -> WeightSet | None:
        r = self._r("SELECT body FROM weights WHERE underlying=? AND bucket=? ORDER BY created_at DESC, id DESC LIMIT 1",
                    (underlying, bucket))
        return WeightSet(**json.loads(r[0][0])) if r else None

    def weights_history(self, underlying: str) -> list[tuple[datetime, str, WeightSet]]:
        rows = self._r("SELECT created_at, bucket, body FROM weights WHERE underlying=? ORDER BY created_at, id", (underlying,))
        return [(datetime.fromisoformat(c), b, WeightSet(**json.loads(body))) for c, b, body in rows]

    # gaps & days
    def log_gap(self, start: datetime, end: datetime | None, what: str) -> None:
        self._w("INSERT INTO gaps(start, end_, what) VALUES (?,?,?)", (start.isoformat(), end.isoformat() if end else None, what))

    def gaps(self, day: date) -> list[tuple[datetime, datetime | None, str]]:
        rows = self._r("SELECT start, end_, what FROM gaps WHERE substr(start,1,10)=? ORDER BY start, id", (day.isoformat(),))
        return [(datetime.fromisoformat(s), datetime.fromisoformat(e) if e else None, w) for s, e, w in rows]

    def set_day_status(self, day: date, status: str) -> None:
        self._w("INSERT OR REPLACE INTO days VALUES (?,?)", (day.isoformat(), status))

    def day_status(self, day: date) -> str | None:
        r = self._r("SELECT status FROM days WHERE day=?", (day.isoformat(),))
        return r[0][0] if r else None
