"""Command line: python -m fo_dash run | backtest | status"""
from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser
from datetime import date, datetime

from fo_dash.config import HOST, IST, PORT, UNDERLYINGS, load_settings


def _now() -> datetime:
    return datetime.now(IST)


def _serve(app) -> None:
    import uvicorn
    url = f"http://{HOST}:{PORT}/"
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"Dashboard: {url}   (Ctrl+C to stop)")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


def cmd_run(args) -> int:
    from fo_dash.web.app import create_app
    if args.demo:
        from fo_dash.demo import build_demo
        store, orch, source, now_fn = build_demo()
        _serve(create_app(store, orch, source, now_fn))
        return 0
    from kiteconnect import KiteConnect
    from fo_dash.kite_client import KiteSource, TokenStore
    from fo_dash.orchestrator import Orchestrator
    from fo_dash.storage import Store
    s = load_settings()
    if not s.api_key or not s.api_secret:
        print("KITE_API_KEY / KITE_API_SECRET missing — edit the .env file first.", file=sys.stderr)
        return 2
    source = KiteSource(KiteConnect(api_key=s.api_key), TokenStore(s.data_dir / "token.json"), s.api_secret, _now)
    store = Store(s.data_dir / "fo_dash.sqlite")
    orch = Orchestrator(store, source, _now)
    sched = orch.start()
    try:
        _serve(create_app(store, orch, source, _now))
    finally:
        sched.shutdown(wait=False)
    return 0


def cmd_backtest(args) -> int:
    import requests
    from fo_dash.backtest import run as bt
    from fo_dash.storage import Store
    s = load_settings()
    store = Store(s.data_dir / "fo_dash.sqlite")
    start = date.fromisoformat(args.from_)
    end = date.fromisoformat(args.to) if args.to else _now().date()
    print(f"Back-test {start} → {end}: downloading NSE daily files (cached in {s.data_dir / 'bhavcopy'}).")
    print("First run takes about 10-15 minutes. Re-runs are quick.")
    months: set[str] = set()

    def progress(d: date) -> None:
        if f"{d:%Y-%m}" not in months:
            months.add(f"{d:%Y-%m}")
            print(f"  {d:%b %Y} …", flush=True)

    rep = bt.run_backtest(store, start, end, s.data_dir / "bhavcopy", requests.Session(), progress_fn=progress)
    print(f"Trading days used: {rep['days']}   holidays/missing: {rep['skipped_days']}")
    for name, tr in rep["track_record"].items():
        if not tr["expiries"]:
            print(f"{name}: no expiries scored")
            continue
        print(f"{name}: {tr['expiries']} expiries · mean error {tr['mean_abs_err_pct']:.2f}% vs futures {tr['forward_mean_abs_err_pct']:.2f}%"
              f" · 68% band hit {tr['cov68'] or 0:.0%} · 90% band hit {tr['cov90'] or 0:.0%}"
              f" · {'beats' if tr['beats_baseline'] else 'does NOT beat'} the futures price")
    print("Weights saved as the back-test prior.")
    return 0


def cmd_status(args) -> int:
    from kiteconnect import KiteConnect
    from fo_dash.kite_client import KiteSource, TokenStore
    from fo_dash.predict import PRIOR
    from fo_dash.storage import Store
    s = load_settings()
    src = KiteSource(KiteConnect(api_key=s.api_key or "x"), TokenStore(s.data_dir / "token.json"), s.api_secret, _now)
    store = Store(s.data_dir / "fo_dash.sqlite")
    print(f"Kite login: {'ok' if src.is_logged_in() else 'needed'}")
    print(f"Last snapshot today: {store.last_snapshot_time(_now().date()) or 'none'}")
    for cfg in UNDERLYINGS:
        srcs = {b: (store.current_weights(cfg.name, b) or PRIOR[b]).source for b in PRIOR}
        print(f"{cfg.name} weights: " + ", ".join(f"{b}={v}" for b, v in srcs.items()))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="fo_dash", description="F&O expiry prediction dashboard (read-only on Kite).")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="start the scheduler and the dashboard on http://127.0.0.1:8050/")
    r.add_argument("--demo", action="store_true", help="offline demo data, no Kite login")
    r.set_defaults(fn=cmd_run)
    b = sub.add_parser("backtest", help="fit prior weights on NSE bhavcopy history")
    b.add_argument("--from", dest="from_", default="2024-07-08", help="YYYY-MM-DD (default 2024-07-08, when NSE's current file format starts)")
    b.add_argument("--to", default=None, help="YYYY-MM-DD (default today)")
    b.set_defaults(fn=cmd_backtest)
    st = sub.add_parser("status", help="show login state and which weights are in use")
    st.set_defaults(fn=cmd_status)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
