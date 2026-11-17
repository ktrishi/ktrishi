# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

`dashboard/` holds the consolidation layer for the Tiwari Family Wealth artifact
(https://claude.ai/artifact/JugU6z3ho2ceWqt9CfrTpC). The data pipeline itself (dash_data.json,
build_v4.js, tw4_app.js, tw4_engine.js) lives on Rishi's PC in `Knowledge Base\financial\reports`,
not here.

## Commands

- `node -c dashboard/tw5_consolidated.js`: syntax check.
- `python dashboard/patch_tw4_app.py <path/to/tw4_app.js>`: patch a copy of tw4_app.js (idempotent, backs up first).
- `python dashboard/patch_tw4_app.py --check <path>`: report patch state only.

## Architecture

- `tw5_consolidated.js` is prepended to `tw4_app.js` and defines `window.TW5`: the Update & Audit,
  Behavioural, History and Export tabs, the status bar, the live NSE overlay (cm-market connector)
  and the browser-side underlying audit.
- The patched `tw4_app.js` exposes helpers on `window.TWAPP.h` and routes the new tabs to `TW5`.
- Live prices never mutate `window.MODEL`; the headline must keep reconciling to the audited build.
- Republish the artifact without `capabilities`. The stored set is assets, db, user, downloads, plus mcp
  for `Claude Code Remote` (fire_trigger) and `cm-market` (cm_get_stock_quote, cm_get_index_quote).
