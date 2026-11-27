"""Download and parse NSE F&O UDiFF bhavcopy files (available from 08-Jul-2024)."""
from __future__ import annotations

import csv
import io
import time
import zipfile
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": "https://www.nseindia.com/",
}


@dataclass
class BhavRow:
    trade_date: date
    symbol: str
    instr: str  # "IDO" index option | "IDF" index future
    expiry: date
    strike: float | None
    opt_type: str | None
    close: float
    settle: float
    underlying: float
    oi: int
    volume: int


def _file_name(day: date) -> str:
    return URL.format(ymd=day.strftime("%Y%m%d")).rsplit("/", 1)[1]


def download(day: date, cache_dir: Path, session) -> Path | None:
    cache_dir = Path(cache_dir)
    path = cache_dir / _file_name(day)
    if path.exists():
        return path
    url = URL.format(ymd=day.strftime("%Y%m%d"))
    last = None
    for attempt in range(3):
        try:
            r = session.get(url, headers=HEADERS, timeout=30)
        except Exception as e:  # network error: retry
            last = e
        else:
            if r.status_code == 404:
                return None
            if r.status_code == 200:
                cache_dir.mkdir(parents=True, exist_ok=True)
                path.write_bytes(r.content)
                return path
            last = RuntimeError(f"NSE returned HTTP {r.status_code} for {url}")
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"could not download {url}: {last}")


def _date(s: str) -> date:
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"unrecognised date {s!r}")


def _num(s: str) -> float:
    s = (s or "").strip()
    return float(s) if s else 0.0


def _text(path: Path) -> str:
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
            return z.read(name).decode("utf-8-sig")
    return Path(path).read_text(encoding="utf-8-sig")


def parse(path: Path, symbols: set[str]) -> list[BhavRow]:
    out = []
    for raw in csv.DictReader(io.StringIO(_text(path))):
        r = {k.strip().lower(): (v or "").strip() for k, v in raw.items() if k}
        tp, sym = r.get("fininstrmtp", ""), r.get("tckrsymb", "")
        if tp not in ("IDO", "IDF") or sym not in symbols:
            continue
        out.append(BhavRow(
            trade_date=_date(r["traddt"]), symbol=sym, instr=tp, expiry=_date(r["xprydt"]),
            strike=_num(r.get("strkpric")) if tp == "IDO" else None,
            opt_type=r.get("optntp") or None if tp == "IDO" else None,
            close=_num(r.get("clspric")), settle=_num(r.get("sttlmpric")), underlying=_num(r.get("undrlygpric")),
            oi=int(_num(r.get("opnintrst"))), volume=int(_num(r.get("ttltradgvol"))),
        ))
    return out
