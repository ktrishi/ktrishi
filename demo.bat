@echo off
REM Double-click to open the dashboard with sample data. No Kite login needed.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo First run: installing, this takes 1-2 minutes...
  call setup.bat
  if errorlevel 1 (
    echo.
    echo Setup failed. See the message above.
    pause
    exit /b 1
  )
)
echo.
echo Opening the demo dashboard in your browser.
echo Close this window to stop it.
.venv\Scripts\python -m fo_dash run --demo
if errorlevel 1 pause
