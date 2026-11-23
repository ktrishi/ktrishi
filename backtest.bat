@echo off
REM Double-click once to calibrate the predictions on NSE history (about 10-15 minutes the first time).
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
echo Calibrating on NSE history. Keep this window open until it says it is finished.
echo.
.venv\Scripts\python -m fo_dash backtest
if errorlevel 1 (
  echo.
  echo The back-test stopped with an error. Send a screenshot of this window.
) else (
  echo.
  echo Finished. The dashboard will now show "weights: back-test prior".
)
pause
