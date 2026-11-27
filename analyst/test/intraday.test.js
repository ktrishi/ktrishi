'use strict';
// Intraday tracker engine: build-up, levels, trend score, flips, signals, tomorrow bias, position risk.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML } = require('./fixtures');
const { loadEngine } = require('../engine');

const eng = loadEngine(HTML);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
// 15-minute bars from 09:15 IST on 27-Nov-2026: [open, high, low, close, volume, oi]
const T0 = Date.UTC(2026, 10, 27, 3, 45);
const bars = rows => rows.map((r, i) => ({ ms: T0 + i * 15 * 60e3, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4], oi: r[5] }));

test('build-up from price and open interest change', () => {
  const p = { close: 26000, oi: 1e7 };
  assert.equal(eng.buildupOf(p, { close: 26050, oi: 1.01e7 }), 'long_buildup');
  assert.equal(eng.buildupOf(p, { close: 25950, oi: 1.01e7 }), 'short_buildup');
  assert.equal(eng.buildupOf(p, { close: 26050, oi: 0.99e7 }), 'short_covering');
  assert.equal(eng.buildupOf(p, { close: 25950, oi: 0.99e7 }), 'long_unwinding');
  assert.equal(eng.buildupOf(p, { close: 26005, oi: 1.01e7 }), 'neutral', 'price change under 0.05%');
});

test('levels: VWAP from candles, pivots and central range, opening range', () => {
  const c = bars([[100, 110, 90, 100, 10, 1], [100, 120, 100, 110, 30, 1], [110, 112, 108, 111, 10, 1]]);
  near(eng.vwapOf(c), (100 * 10 + 110 * 30 + 110.33333333 * 10) / 50, 1e-6);
  const p = eng.pivots([26000, 25700, 25900]);
  near(p.P, 25866.6667, 1e-3); near(p.R1, 26033.3333, 1e-3); near(p.S1, 25733.3333, 1e-3);
  near(p.BC, 25850, 1e-9); near(p.TC, 25883.3333, 1e-3);
  assert.deepEqual(eng.openingRange(c), { high: 120, low: 90 });
  assert.equal(eng.openingRange(c.slice(0, 1)), null, 'needs both opening bars');
});

const UP = bars([[25900, 25950, 25880, 25940, 1e5, 1.00e7], [25940, 25990, 25930, 25980, 1e5, 1.01e7], [25980, 26020, 25970, 26010, 1e5, 1.02e7],
  [26010, 26060, 26000, 26050, 1e5, 1.03e7], [26050, 26100, 26040, 26090, 1e5, 1.04e7], [26090, 26140, 26080, 26130, 1e5, 1.05e7]]);
const DOWN = UP.map(b => ({ ...b, open: 52000 - b.open, high: 52000 - b.low, low: 52000 - b.high, close: 52000 - b.close }));

test('trend score: a clean up-move scores Up, its mirror scores Down, with reasons', () => {
  const up = eng.trendScore({ candles: UP, vwap: eng.vwapOf(UP) });
  assert.equal(up.label, 'Up'); assert.ok(up.score >= 3, `score ${up.score}`);
  assert.ok(up.parts.some(p => /VWAP/.test(p.why)) && up.parts.some(p => /long build-up/.test(p.why)));
  const dn = eng.trendScore({ candles: DOWN, vwap: eng.vwapOf(DOWN) });
  assert.equal(dn.label, 'Down'); assert.ok(dn.score <= -3);
  const flat = bars([[26000, 26010, 25990, 26000, 1e5, 1e7], [26000, 26010, 25990, 26001, 1e5, 1e7], [26001, 26010, 25990, 26000, 1e5, 1e7], [26000, 26010, 25990, 26002, 1e5, 1e7]]);
  assert.equal(eng.trendScore({ candles: flat, vwap: eng.vwapOf(flat) }).label, 'Sideways');
  const opt = eng.trendScore({ candles: UP, vwap: eng.vwapOf(UP), walls: { support: 26000, resistance: 26300 }, wallsOpen: { support: 25900, resistance: 26200 }, pcr: 1.2, pcrOpen: 0.9 });
  assert.ok(opt.score > up.score, 'rising walls and put writing add to an up-trend');
});

test('trend tracker confirms a flip only after two checks', () => {
  let st = eng.trendTracker(null, 'Sideways', 1);
  assert.equal(st.confirmed, 'Sideways'); assert.equal(st.flip, null);
  st = eng.trendTracker(st, 'Down', 2); assert.equal(st.confirmed, 'Sideways'); assert.equal(st.flip, null);
  st = eng.trendTracker(st, 'Sideways', 3); assert.equal(st.confirmed, 'Sideways'); assert.equal(st.flip, null, 'one-check blip ignored');
  st = eng.trendTracker(st, 'Down', 4); st = eng.trendTracker(st, 'Down', 5);
  assert.equal(st.confirmed, 'Down'); assert.deepEqual(st.flip, { from: 'Sideways', to: 'Down', ms: 5 });
  st = eng.trendTracker(st, 'Down', 6); assert.equal(st.flip, null);
});

test('long signal on an opening-range break with long build-up above VWAP; none outside hours or within the hour', () => {
  const c = bars([[26000, 26040, 25980, 26020, 1e5, 1.00e7], [26020, 26050, 26000, 26030, 1e5, 1.00e7], [26030, 26045, 26010, 26040, 1e5, 1.001e7],
    [26040, 26100, 26035, 26090, 2e5, 1.02e7]]);
  const ctx = { candles: c, vwap: 26030, or: eng.openingRange(c), prevHLC: [26120, 25800, 25950], walls: { support: 25900, resistance: 26200 }, trend: 'Up' };
  const s = eng.signalCheck({ ...ctx, lastSignalMs: null, nowMs: c[3].ms + 15 * 60e3 });
  assert.ok(s, 'signal'); assert.equal(s.side, 'long'); assert.equal(s.level, 26050); assert.equal(s.entry, 26090);
  assert.equal(s.stop, 26035, 'the closer of VWAP (26,030) and the bar low (26,035)');
  assert.equal(s.target, 26120, 'next level above: previous day high');
  assert.match(s.why, /opening-range high 26,050/);
  assert.equal(eng.signalCheck({ ...ctx, trend: 'Sideways', nowMs: c[3].ms + 15 * 60e3 }), null);
  assert.equal(eng.signalCheck({ ...ctx, lastSignalMs: c[3].ms - 30 * 60e3, nowMs: c[3].ms + 15 * 60e3 }), null, 'one per hour');
  assert.equal(eng.signalCheck({ ...ctx, nowMs: Date.UTC(2026, 10, 27, 9, 20) }), null, 'not after 14:45');
});

test('signal scoring at 30 and 60 minutes, and stop first', () => {
  const s = { side: 'long', ms: T0, entry: 100, stop: 95, target: 110 };
  const c = bars([[100, 102, 99, 101, 1, 1], [101, 104, 100, 103, 1, 1], [103, 106, 102, 105, 1, 1], [105, 107, 104, 106, 1, 1], [106, 108, 105, 107, 1, 1]]);
  const r = eng.scoreSignal(s, c);
  assert.equal(r.at30, 3, 'close of the bar ending 30 min after the signal (103 - 100)');
  assert.equal(r.at60, 6); assert.equal(r.stopped, false);
  const c2 = c.map((b, i) => i === 1 ? { ...b, low: 94 } : b);
  assert.equal(eng.scoreSignal(s, c2).stopped, true);
  assert.equal(eng.scoreSignal({ ...s, side: 'short' }, c).at30, -3);
});

test('reversal watch: up-trend pressing the call wall with short build-up', () => {
  const c = bars([[26150, 26190, 26140, 26180, 1e5, 1.00e7], [26180, 26198, 26150, 26160, 1e5, 1.01e7]]);
  const r = eng.reversalWatch({ candles: c, trend: 'Up', walls: { support: 25900, resistance: 26200 } });
  assert.ok(r); assert.match(r, /call wall 26,200/);
  assert.equal(eng.reversalWatch({ candles: c, trend: 'Down', walls: { support: 25900, resistance: 26200 } }), null);
});

test('tomorrow bias after the close', () => {
  const b = eng.tomorrowBias({ candles: UP, vwap: eng.vwapOf(UP), pcrChange: 0.15 });
  assert.equal(b.label, 'Bullish'); assert.ok(b.reasons.length >= 3);
  assert.equal(eng.tomorrowBias({ candles: DOWN, vwap: eng.vwapOf(DOWN), pcrChange: -0.15 }).label, 'Bearish');
});

test('option symbols parse and short strikes near spot are flagged', () => {
  assert.deepEqual(eng.parseOptionSymbol('NIFTY26D0126200CE'), { idx: 'NIFTY', strike: 26200, type: 'CE' });
  assert.deepEqual(eng.parseOptionSymbol('BANKNIFTY26DEC66000CE'), { idx: 'BANKNIFTY', strike: 66000, type: 'CE' });
  assert.deepEqual(eng.parseOptionSymbol('NIFTY26DECFUT'), { idx: 'NIFTY', strike: null, type: 'FUT' });
  assert.equal(eng.parseOptionSymbol('RELIANCE26DEC1300CE'), null);
  const rows = [
    { tradingsymbol: 'BANKNIFTY26DEC66000CE', quantity: -90, average_price: 194.3, last_price: 433.75, pnl: -21547.5, view: 'net' },
    { tradingsymbol: 'BANKNIFTY26DEC60000PE', quantity: -90, average_price: 277.35, last_price: 288, pnl: -958.5, view: 'net' },
    { tradingsymbol: 'NIFTY26D0126200CE', quantity: -65, average_price: 34.8, last_price: 27.5, pnl: 474.5, view: 'day' },
    { tradingsymbol: 'NIFTY26D0126450CE', quantity: 0, average_price: 12, last_price: 10, pnl: -146, view: 'net' }];
  const r = eng.positionRisk(rows, { NIFTY: 25850, BANKNIFTY: 65800 });
  assert.equal(r.rows.length, 2, 'net view only, closed rows dropped');
  const ce = r.rows.find(x => x.strike === 66000);
  near(ce.distPct, (66000 / 65800 - 1) * 100, 1e-9); assert.equal(ce.breach, true, 'short call within 0.5% of spot');
  assert.equal(r.rows.find(x => x.strike === 60000).breach, false);
  near(r.pnl, -22506, 1e-9);
});

test('trend score: the live price decides VWAP and range position; the build-up reason names the winning side', () => {
  const c = bars([[26000, 26050, 25990, 26040, 1e5, 1.00e7], [26040, 26060, 26020, 26050, 1e5, 1.01e7], [26050, 26055, 26000, 26010, 1e5, 1.02e7],
    [26010, 26015, 25960, 25970, 1e5, 1.03e7], [25970, 25980, 25920, 25930, 1e5, 1.04e7]]);
  const t = eng.trendScore({ candles: c, vwap: 26000, price: 25950 });
  const v = t.parts.find(p => /VWAP/.test(p.why));
  assert.equal(v.v, -1); assert.match(v.why, /25,950 below VWAP/);
  const b = t.parts.find(p => /last hour/.test(p.why));
  assert.equal(b.v, -1); assert.match(b.why, /short build-up/, 'not the single long build-up bar');
});

test('option OI shift since the open: per-strike change, top writing strikes and the tilt', () => {
  const open = { strikes: [25800, 25900, 26000, 26100, 26200], ce: [100, 200, 500, 400, 300], pe: [600, 500, 300, 100, 50] };
  const now = { strikes: [25800, 25900, 26000, 26100, 26200], ce: [100, 260, 1500, 1300, 500], pe: [700, 600, 320, 90, 50] };
  const s = eng.oiShift(open, now, 25950);
  assert.deepEqual(s.ceChg, [0, 60, 1000, 900, 200]); assert.deepEqual(s.peChg, [100, 100, 20, -10, 0]);
  assert.equal(s.ceAdd, 2160); assert.equal(s.peAdd, 210);
  assert.deepEqual(s.callWalls, [26000, 26100], 'biggest call additions above spot');
  assert.deepEqual(s.putWalls, [25800, 25900], 'biggest put additions below spot');
  assert.equal(s.tilt, 'bearish'); assert.match(s.text, /call writing dominant/i);
  const mirror = eng.oiShift({ ...open, ce: open.pe, pe: open.ce }, { ...now, ce: now.pe, pe: now.ce }, 25950);
  assert.equal(mirror.tilt, 'bullish');
  assert.equal(eng.oiShift(open, open, 25950).tilt, 'balanced');
  assert.equal(eng.oiShift(null, now, 25950), null);
  const shifted = eng.oiShift({ strikes: [25900, 26000], ce: [1, 1], pe: [1, 1] }, { strikes: [26000, 26100], ce: [5, 9], pe: [5, 9] }, 26000);
  assert.deepEqual(shifted.strikes, [26000], 'only strikes present at both times');
});

test('most active options near spot: ranked by open-interest change since the baseline, each read from price and OI change', () => {
  const strikes = [25700, 25800, 25900, 26000, 26100, 26200, 26300];
  const ch = { strikes, ceVol: [5, 10, 40, 90, 70, 30, 2], peVol: [20, 60, 80, 50, 10, 5, 1], ce: [100, 200, 900, 1500, 1300, 500, 50], pe: [800, 900, 700, 300, 100, 50, 10],
    ceLtp: [320, 230, 150, 90, 50, 25, 10], peLtp: [10, 20, 45, 85, 140, 210, 300] };
  const base = { strikes, ce: [100, 200, 800, 1000, 1000, 500, 50], pe: [800, 700, 600, 350, 100, 50, 10], ceLtp: [300, 210, 140, 100, 60, 30, 12], peLtp: [12, 22, 40, 70, 130, 200, 290] };
  const a = eng.activeOptions(ch, base, 25950, { band: 0.015, n: 3 });
  assert.equal(a.mode, 'change');
  assert.deepEqual(a.strikes, strikes);
  assert.deepEqual(a.ceChg, [0, 0, 100, 500, 300, 0, 0]); assert.deepEqual(a.peChg, [0, 200, 100, -50, 0, 0, 0]);
  assert.deepEqual(a.calls.map(x => x.strike), [26000, 26100, 25900], 'largest open-interest changes, not volume');
  assert.deepEqual(a.puts.map(x => x.strike), [25800, 25900, 26000]);
  const c26 = a.calls[0]; assert.equal(c26.read, 'writing'); assert.equal(c26.view, 'bearish'); near(c26.dLtpPct, -10, 1e-9); assert.equal(c26.dOi, 500);
  assert.equal(a.calls[2].read, 'buying'); assert.equal(a.calls[2].view, 'bullish');
  const p259 = a.puts[1]; assert.equal(p259.read, 'buying'); assert.equal(p259.view, 'bearish');
  const p26 = a.puts[2]; assert.equal(p26.read, 'short covering'); assert.equal(p26.view, 'bearish');
  assert.match(a.text, /26,000 CE/); assert.match(a.text, /25,800 PE/);
  const noBase = eng.activeOptions(ch, null, 25950, { band: 0.015, n: 3 });
  assert.equal(noBase.mode, 'outstanding'); assert.equal(noBase.ceChg, null);
  assert.deepEqual(noBase.calls.map(x => x.strike), [26000, 26100, 25900], 'ranked by outstanding open interest');
  assert.equal(noBase.calls[0].read, null, 'no baseline: no read');
});
