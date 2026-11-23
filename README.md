# F&O Expiry Dashboard

A personal, **read-only** tool that runs on your Windows laptop. It reads the live option chain from Zerodha Kite Connect and estimates where three contracts will settle on expiry day:

- **Nifty weekly**
- **Nifty monthly**
- **Bank Nifty monthly**

**What it shows for each contract:**
- An expected settlement level, always with a **68% and 90% range**
- Support and resistance from open interest
- Max pain and PCR
- The implied volatility (IV) range
- The probability of settling above key strikes
- How the prediction moved through the series

**When it updates:** the numbers refresh every 5 minutes during market hours. A formal prediction is **locked** three times a day, at 09:45, 12:30 and 15:05. Each locked prediction records the reason if the view changed, and a Windows notification fires when it does.

**How it learns:** after each expiry, the app scores its locked predictions against the actual settlement and re-weights its signals. Weights move cautiously, so one expiry can't swing them. The track record is shown against a plain "futures price" baseline. If the model isn't beating that baseline, the dashboard says so.

**What it does not do:**
- It places no orders and gives no trade suggestions.
- It never shows a single number without its range.
- It doesn't run without your daily Kite login. Kite's rules require one, and the login lasts until 06:00 the next morning.

## Just want to look? Double-click `demo.bat`

After installing Python (step 1 below), double-click **`demo.bat`**. The first time, it installs everything (1–2 minutes), then opens the dashboard with sample data in your browser. No Kite keys or login needed. Close the black window to stop it.

## First-time setup (once)

1. **Install Python 3.14** (3.12 or newer works) from python.org/downloads/windows. On the first installer screen, tick **"Add python.exe to PATH"**.
2. **Download this repository** to a folder, e.g. `C:\fo-dashboard`.
3. **Run setup:** double-click **`setup.bat`**. It creates a private Python environment and installs the dependencies.
4. **Add your Kite keys:**
   1. Open **`.env`** in Notepad.
   2. Paste the **API key** and **API secret** from your Kite Connect app at developers.kite.trade.
   3. Save. This file never leaves your laptop.
5. **Check the app's redirect URL.** In the Kite developer console it must be exactly `http://127.0.0.1:8050/kite/callback`. Leave the postback URL blank.

## Every trading day

1. Double-click **`start.bat`**. The dashboard opens at <http://127.0.0.1:8050/>.
2. Click **"Log in to Kite"** and complete the Zerodha login. You land back on the dashboard and the status bar turns from red to normal.
3. Leave it running. While the market is open it keeps the laptop from sleeping.
   - If the laptop sleeps or the app is closed anyway, the missed period is listed under **Gaps today**.
   - Missed reassessments are recorded as missed, never filled in afterwards.

**Optional: start it automatically.** In Windows Task Scheduler, create a basic task:
- **Trigger:** weekly, Mon–Fri, 09:00
- **Action:** start `start.bat`
- **Start in:** the repository folder

## Calibrate once with the back-test (recommended)

Until you run the back-test, predictions are labelled **"uncalibrated"** because the signal weights are starting guesses. The back-test downloads NSE's daily F&O files since 08-Jul-2024 and fits the weights on every past expiry.

**Double-click `backtest.bat`** and leave the window open.
- **Time:** about 10–15 minutes the first time. The files are cached in `data\bhavcopy`, so re-runs are quick.
- **Output:** a summary per index, showing the mean error vs the futures price and how often the 68% and 90% ranges held.
- **Afterwards:** the dashboard label changes to **"back-test prior"**. The dashboard can stay open while it runs.
- **Pivot levels are learned only from live expiries.** NSE's files don't contain the index's daily high and low, so the back-test can't test them.

## Reading the dashboard

- **Expected settlement + 68% / 90% ranges:** the 68% range should contain the settlement about two times in three. Treat the centre as the middle of a range, not a target.
- **Supports / resistances:** the three strikes with the most put open interest below spot, and the most call open interest above spot.
- **Open interest chart:** calls in blue, puts in orange, with a dashed line at spot. **Change** switches to the change in open interest since the previous close.
- **Prediction through the series:** each locked reassessment, plotted against the futures-implied level.
- **Track record:** errors, how often the ranges held, and a plain verdict on whether it beats the futures price.

## Commands

| Command | What it does |
|---|---|
| `start.bat` (= `.venv\Scripts\python -m fo_dash run`) | Scheduler + dashboard |
| `demo.bat` (double-click) | Offline demo with sample data, no Kite needed; runs setup first if needed |
| `backtest.bat` (double-click) | Fit weights on NSE history, 08-Jul-2024 to today |
| `.venv\Scripts\python -m fo_dash status` | Login state and which weights are in use |

## Where your data lives

Everything is stored in the `data\` folder:
- `fo_dash.sqlite`: snapshots, predictions, the track record and weights
- `token.json`: today's Kite session
- `bhavcopy\`: the back-test cache

**Backup:** copy the folder. **Fresh start:** delete it.

## Verify your install (first run)

1. `setup.bat` finishes without errors.
2. `start.bat` opens the dashboard. Before you log in, the status bar is red and says "Kite login needed".
3. **"Log in to Kite"** returns you to the dashboard, and the status bar shows "Kite ✔ live".
4. Within 5 minutes during market hours, all three panels show spot, futures and VIX matching Kite.
5. `backtest.bat` completes, and the label changes to "back-test prior".

## Development

Requires Python ≥ 3.12.

```
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q
```

The design is in `docs/superpowers/specs/` and the build plan in `docs/superpowers/plans/`.
