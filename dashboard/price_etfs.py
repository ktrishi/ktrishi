"""Reprice the family's demat ETFs from NSE's official bhavcopy, matched by ISIN.

Why: DEMAT_ETF / ETF_RISHI rows carry an ISIN but no NSE symbol, so nse_prices.py / apply_ltp.py
(which price EQ and MTF rows by symbol) never touch them. NSE's daily CM bhavcopy lists every
traded security with its ISIN and closing price, so no symbol mapping is needed.

Usage (on the PC, in financial/reports, after `python apply_ltp.py apply ...`):
    python price_etfs.py inspect          # print the ETF row layout found in dash_data.json; writes nothing
    python price_etfs.py                  # dry run: show old -> new price per ETF; writes nothing
    python price_etfs.py --apply          # back up dash_data.json, then write prices and dates
    python price_etfs.py --apply --file BhavCopy_NSE_CM_0_0_0_20261116_F_0000.csv.zip   # use a file already downloaded

Guards, per the TW write rules:
  * the bhavcopy trade date must equal nav_calendar.last_session(), else nothing is written (STALE);
  * a row is only changed when its ISIN is found in the bhavcopy (missing ISINs are listed, untouched);
  * field names are detected, never guessed: if no price field is found the script stops;
  * a stored value field, if present, is updated only when it equalled qty x old price;
  * dash_data.json is backed up first and written with ensure_ascii=False, indent=2.
Before ~19:00 IST on a trading day today's bhavcopy is not out yet: the script says SKIP and exits 0.
Exit codes: 0 all ETFs priced (or SKIP) · 2 some missing or STALE · 1 could not download / layout not understood.
"""
import csv, datetime as dt, io, json, os, shutil, sys, time, urllib.request, zipfile

DATA = 'dash_data.json'
KEYS = ['DEMAT_ETF', 'ETF_RISHI']
ISIN_K = ['isin', 'ISIN']
QTY_K = ['q', 'qty', 'quantity', 'units']
PRICE_K = ['p', 'price', 'ltp', 'cp', 'close', 'nav', 'last_price']
DATE_K = ['pDate', 'pdate', 'priceDate', 'date', 'asOf', 'asof']
VALUE_K = ['v', 'value', 'mv', 'val']
URL = 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d}_F_0000.csv.zip'


def last_session():
    try:
        sys.path.insert(0, os.getcwd())
        import nav_calendar
        d = nav_calendar.last_session()
        return d if isinstance(d, dt.date) else dt.date.fromisoformat(str(d)[:10])
    except Exception as e:
        print('ERROR: nav_calendar.last_session() unavailable (%s); run from financial/reports' % e)
        sys.exit(1)


def rows_of(data):
    """Yield (container_key, member, row) for every ETF row, whatever the nesting."""
    for k in KEYS:
        block = data.get(k)
        if isinstance(block, dict):
            for m, lst in block.items():
                for r in (lst if isinstance(lst, list) else []):
                    if isinstance(r, dict):
                        yield k, m, r
        elif isinstance(block, list):
            for r in block:
                if isinstance(r, dict):
                    yield k, r.get('member', '?'), r


def pick(row, cands):
    for c in cands:
        if c in row:
            return c
    return None


def fetch_bhavcopy(day, path=None):
    if path:
        raw = open(path, 'rb').read()
    else:
        url = URL.format(d=day.strftime('%Y%m%d'))
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Referer': 'https://www.nseindia.com/'})
        try:
            raw = urllib.request.urlopen(req, timeout=40).read()
        except Exception as e:
            ist = dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)
            if day == ist.date() and ist.hour < 19:
                print('SKIP: NSE publishes the %s bhavcopy after market close (~18:00 IST); ETFs are priced by the 23:30 run. Nothing written.' % day)
                sys.exit(0)
            print('ERROR: could not download %s (%s). Save it from nseindia.com > All Reports > CM Bhavcopy and pass --file.' % (url, e))
            sys.exit(1)
    if raw[:2] == b'PK':
        z = zipfile.ZipFile(io.BytesIO(raw))
        raw = z.read([n for n in z.namelist() if n.lower().endswith('.csv')][0])
    text = raw.decode('utf-8-sig', 'replace')
    rdr = csv.DictReader(io.StringIO(text))
    cols = {c.strip().lower(): c for c in (rdr.fieldnames or [])}
    need = {'isin': 'isin', 'close': 'clspric', 'date': 'traddt', 'sym': 'tckrsymb'}
    miss = [v for v in need.values() if v not in cols]
    if miss:
        print('ERROR: bhavcopy columns not recognised, missing %s. Found: %s' % (miss, list(cols)[:20]))
        sys.exit(1)
    out = {}
    for r in rdr:
        isin = (r[cols['isin']] or '').strip()
        try:
            px = float(r[cols['clspric']])
        except Exception:
            continue
        if isin and px > 0:
            out[isin] = {'close': px, 'date': (r[cols['traddt']] or '').strip()[:10], 'sym': (r[cols['tckrsymb']] or '').strip()}
    return out


def main(argv):
    data = json.load(io.open(DATA, encoding='utf-8'))
    rows = list(rows_of(data))
    if not rows:
        print('ERROR: no rows under %s in %s' % (KEYS, DATA)); return 1
    if 'inspect' in argv:
        seen = set()
        for k, m, r in rows:
            sig = (k, tuple(sorted(r.keys())))
            if sig not in seen:
                seen.add(sig); print(k, m, sorted(r.keys()))
        print('%d ETF rows' % len(rows)); return 0
    day = last_session()
    fpath = argv[argv.index('--file') + 1] if '--file' in argv else None
    bc = fetch_bhavcopy(day, fpath)
    dates = {v['date'] for v in bc.values() if v['date']}
    if dates and day.isoformat() not in dates:
        print('STALE: bhavcopy trade date %s, last session %s. Nothing written.' % (sorted(dates)[-1], day)); return 2
    changes, missing, problems = [], [], []
    for k, m, r in rows:
        ik, qk, pk = pick(r, ISIN_K), pick(r, QTY_K), pick(r, PRICE_K)
        if not ik or not pk:
            problems.append('%s/%s row without %s: keys %s' % (k, m, 'ISIN' if not ik else 'price', sorted(r.keys()))); continue
        q = bc.get(str(r[ik]).strip())
        if not q:
            missing.append('%s %s %s' % (m, r[ik], r.get('n') or r.get('name') or '')); continue
        changes.append((k, m, r, ik, qk, pk, q))
    if problems:
        print('ERROR: ETF row layout not understood; nothing written:'); [print('  ' + p) for p in problems[:10]]; return 1
    d_total = 0.0
    for k, m, r, ik, qk, pk, q in changes:
        qty = float(r.get(qk) or 0) if qk else 0
        old = float(r.get(pk) or 0)
        d_total += qty * (q['close'] - old)
        print('%-7s %-14s %-12s %10.2f -> %10.2f  Δ₹%11.0f  %s' % (m, r[ik], q['sym'], old, q['close'], qty * (q['close'] - old), (r.get('n') or r.get('name') or '')[:40]))
    print('priced %d · missing %d · net change ₹%.0f' % (len(changes), len(missing), d_total))
    for x in missing:
        print('MISSING (not traded on %s or ISIN changed): %s' % (day, x))
    if '--apply' not in argv:
        print('dry run: nothing written (add --apply)'); return 2 if missing else 0
    bak = '%s.bak.%d_etf' % (DATA, int(time.time() * 1000))
    shutil.copy2(DATA, bak)
    for k, m, r, ik, qk, pk, q in changes:
        old = float(r.get(pk) or 0)
        vk = pick(r, VALUE_K)
        if vk and qk and abs(float(r[vk]) - float(r[qk]) * old) <= 1.0:
            r[vk] = round(float(r[qk]) * q['close'], 2)
        elif vk:
            print('WARN: %s %s stored value %s is not qty x price; left unchanged' % (m, r[ik], r[vk]))
        r[pk] = q['close']
        r[pick(r, DATE_K) or 'pDate'] = day.isoformat()
        r.setdefault('nse', q['sym'])
        r['pSrc'] = 'nse-bhavcopy'
    with io.open(DATA, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print('written %s · backup %s' % (DATA, bak))
    return 2 if missing else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
