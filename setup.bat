@echo off
REM One-time setup for the F&O Expiry Dashboard (Windows).
cd /d "%~dp0"
py -3.12 -m venv .venv || (echo Python 3.12 not found. Install it from python.org and tick "Add python.exe to PATH". & exit /b 1)
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\pip install -r requirements.txt || exit /b 1
if not exist .env copy .env.example .env
echo.
echo Setup done. Now open .env in Notepad and paste your Kite API key and secret.
