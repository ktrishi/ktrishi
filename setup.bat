@echo off
REM One-time setup for the F&O Expiry Dashboard (Windows). Needs Python 3.12 or newer.
cd /d "%~dp0"
set "PY="
py -3.14 -c "" >nul 2>&1 && set "PY=py -3.14"
if not defined PY py -3.13 -c "" >nul 2>&1 && set "PY=py -3.13"
if not defined PY py -3.12 -c "" >nul 2>&1 && set "PY=py -3.12"
if not defined PY py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python 3.12 or newer was not found on this computer.
  echo Install Python 3.14 from https://www.python.org/downloads/windows/
  echo and tick "Add python.exe to PATH" on the first installer screen. Then try again.
  exit /b 1
)
echo Using %PY%
%PY% -m venv .venv || exit /b 1
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\pip install -r requirements.txt || exit /b 1
if not exist .env copy .env.example .env >nul
echo.
echo Setup done. For live data later: open .env in Notepad and paste your Kite API key and secret.
