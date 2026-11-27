@echo off
REM Starts the dashboard and opens http://127.0.0.1:8050/ in your browser.
cd /d "%~dp0"
.venv\Scripts\python -m fo_dash run
