# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is
A personal, read-only F&O expiry prediction dashboard for Nifty (weekly + monthly) and Bank Nifty (monthly). It is a Python app that runs on the owner's Windows laptop against the Zerodha Kite Connect API. Design: `docs/superpowers/specs/2026-11-19-fo-expiry-dashboard-design.md`. Plan: `docs/superpowers/plans/2026-11-19-fo-expiry-dashboard.md`.

## Commands
- Install: `python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
- Tests: `.venv/bin/pytest -q`; a single test: `.venv/bin/pytest tests/test_signals.py::test_oi_structure -q`
- Run: `python -m fo_dash run` (needs `.env` with `KITE_API_KEY`/`KITE_API_SECRET`). Offline: `python -m fo_dash run --demo`
- Back-test: `python -m fo_dash backtest --from 2024-07-08 --to YYYY-MM-DD` (needs NSE access, so run it from an Indian IP)

## Architecture (`fo_dash/`)
Data flows: `kite_client` (token, rate-limited quotes) → `collector` (ChainSnapshot) → `signals` → `predict` (centre + bands) → `reassess` (changed? reason). `orchestrator` drives these on an APScheduler and logs gaps. `learner` scores locked predictions after expiry and refits weights with shrinkage. `backtest/` replays NSE UDiFF bhavcopies through the same engine to fit the prior. `web/` holds the FastAPI app (`/api/state`, `/kite/login`, `/kite/callback`) and a static Chart.js page. `storage` is SQLite. Shared types are in `models.py`; constants in `config.py`.

## Conventions
- Never call Kite order/GTT/alert APIs. The app is read-only.
- Underlyings live only in `config.UNDERLYINGS`. Do not hard-code "NIFTY"/"BANKNIFTY" elsewhere (`demo.py` and tests are the exceptions).
- Expiry dates come from the instrument master, never from weekdays.
- All datetimes are IST-aware (`config.IST`); `tzdata` is required on Windows.
- Never return a centre without bands. When IV is unavailable, set bands to None with an explicit note.
- Kite and the clock are injected everywhere. Tests use the fakes in `tests/conftest.py` and need no network.
