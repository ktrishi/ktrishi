'use strict';
// Trade bands: fair volatility, the deflated market-implied distribution, structure payoffs and the verdict.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML } = require('./fixtures');
const { loadEngine } = require('../engine');

const eng = loadEngine(HTML);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);

test('realised volatility of a known alternating series', () => {
  const a = 0.01, closes = [100];
  for (let i = 0; i < 10; i++) closes.push(closes[i] * Math.exp(i % 2 ? -a : a));
  near(eng.realizedVol(closes, 10), a * Math.sqrt(10 / 9) * Math.sqrt(252), 1e-9);
  assert.equal(eng.realizedVol(closes.slice(0, 5), 10), null);
});

test('trend regime: up, down, range and too little history', () => {
  const up = Array.from({ length: 260 }, (_, i) => 100 * Math.pow(1.002, i));
  assert.equal(eng.trendRegime(up).regime, 'up');
  assert.equal(eng.trendRegime(up.map(x => 1e4 / x)).regime, 'down');
  assert.equal(eng.trendRegime(Array.from({ length: 260 }, () => 100)).regime, 'range');
  assert.equal(eng.trendRegime(up.slice(0, 100)).regime, 'unknown');
});

test('fair volatility: blend, 80% floor, trend uplift, event cap, no history', () => {
  const cfg = eng.mergeConfig({});
  const flat = Array.from({ length: 80 }, (_, i) => 100 * Math.exp(i % 2 ? 0.002 : 0)); // realised ~3%, far below IV
  const calm = eng.fairVol({ iv: 0.20, closes: flat, regime: 'range', highEvent: false, cfg });
  near(calm.vol, 0.16, 1e-12, 'floored at 0.8 x IV');
  assert.equal(calm.source, 'rv');
  near(eng.fairVol({ iv: 0.20, closes: flat, regime: 'up', highEvent: false, cfg }).vol, 0.16 * 1.15, 1e-12, 'trend uplift');
  near(eng.fairVol({ iv: 0.20, closes: flat, regime: 'range', highEvent: true, cfg }).vol, 0.20, 1e-12, 'event: no edge');
  const none = eng.fairVol({ iv: 0.20, closes: null, regime: 'unknown', highEvent: false, cfg });
  assert.equal(none.vol, 0.20); assert.equal(none.source, 'iv');
});

test('flat smile gives the lognormal distribution: mean, sd and quantiles', () => {
  const F = 25000, T = 7 / 365, iv = 0.14;
  const g = eng.impliedDist({ F, T, volAt: () => iv });
  const s = iv * Math.sqrt(T);
  near(g.mean / F, 1, 5e-4, 'mean');
  near(g.sd / (F * Math.sqrt(Math.exp(s * s) - 1)), 1, 0.01, 'sd');
  near(eng.gridQuantile(g, 0.5) / (F * Math.exp(-s * s / 2)), 1, 5e-4, 'median');
  near(eng.gridQuantile(g, 0.1) / (F * Math.exp(-s * s / 2 - 1.2816 * s)), 1, 1e-3, '10th percentile');
  near(eng.gridCdf(g, F), eng.ncdf(s / 2), 2e-3, 'cdf at forward');
});

test('smile fit recovers a quadratic smile and falls back to flat when sparse', () => {
  const F = 25000, T = 14 / 365, rows = [];
  const truth = K => { const m = Math.log(K / F); return 0.13 - 0.3 * m + 4 * m * m; };
  for (let K = 23500; K <= 26500; K += 100) rows.push({ strike: K, ce_ltp: eng.b76(F, K, T, truth(K), 'CE'), pe_ltp: eng.b76(F, K, T, truth(K), 'PE') });
  const sm = eng.fitSmile(rows, F, T);
  near(sm.atm, 0.13, 2e-3, 'atm');
  near(sm.at(24000), truth(24000), 3e-3, 'put wing');
  near(sm.at(26000), truth(26000), 3e-3, 'call wing');
  const lo = 23500, h = 10, slope = (a, b) => (sm.at(b) - sm.at(a)) / (b - a);
  near(slope(lo - h, lo), slope(lo, lo + h), 2e-6, 'no slope jump at the lowest quoted strike');
  assert.ok(sm.at(10000) <= 3 * sm.atm + 1e-12, 'capped far out');
  const sparse = eng.fitSmile(rows.filter(r => Math.abs(r.strike - F) <= 100), F, T);
  assert.equal(sparse.flat, true);
  near(sparse.at(24000), sparse.atm, 1e-12);
});

test('strangle and condor payoffs, EV and risk on a hand-checked grid', () => {
  const g = { x: [90, 100, 110], w: [0.25, 0.5, 0.25] };
  const put = (strike, side, price) => ({ type: 'PE', strike, side, price }), call = (strike, side, price) => ({ type: 'CE', strike, side, price });
  const str = eng.evalLegs([put(95, -1, 2), call(105, -1, 2)], g, { costPts: 0, F: 100, sd: 5 });
  near(str.credit, 4, 1e-12); near(str.ev, 1.5, 1e-12); near(str.pop, 0.5, 1e-12);
  assert.deepEqual(str.breakevens, [91, 109]);
  assert.equal(str.maxLoss, null, 'short strangle loss is not capped');
  near(str.loss2, -1, 1e-12); near(str.loss3, -6, 1e-12);
  const ic = eng.evalLegs([put(85, 1, 0.5), put(95, -1, 2), call(105, -1, 2), call(115, 1, 0.5)], g, { costPts: 0, F: 100, sd: 5 });
  near(ic.credit, 3, 1e-12); near(ic.ev, 0.5, 1e-12); near(ic.maxLoss, 7, 1e-12);
  assert.deepEqual(ic.breakevens, [92, 108]);
  near(ic.loss3, -7, 1e-12);
  const withCost = eng.evalLegs([put(95, -1, 2), call(105, -1, 2)], g, { costPts: 0.5, F: 100, sd: 5 });
  near(withCost.ev, 0.5, 1e-12, 'two legs x 0.5 points');
});

function chain(F, T, iv) {
  const rows = [];
  for (let K = Math.round(F * 0.93 / 50) * 50; K <= F * 1.07; K += 50)
    rows.push({ strike: K, ce_ltp: Math.round(eng.b76(F, K, T, iv, 'CE') / 0.05) * 0.05, pe_ltp: Math.round(eng.b76(F, K, T, iv, 'PE') / 0.05) * 0.05, ce_oi: 1e5, pe_oi: 1e5 });
  return rows;
}

test('band finder: rich options give positive EV, fairly priced options lose the costs', () => {
  const F = 26000, T = 6 / 365, iv = 0.13, rows = chain(F, T, iv), cfg = eng.mergeConfig({});
  const rich = eng.bandFinder({ rows, F, T, fairAtm: 0.8 * iv, idx: 'NIFTY', cfg });
  const sc = rich.strangle.best, ic = rich.condor.best;
  assert.ok(sc && ic, 'found candidates');
  assert.ok(sc.ev > 0 && ic.ev > 0, `EV ${sc.ev} ${ic.ev}`);
  assert.ok(sc.legs.find(l => l.type === 'PE').strike < F && sc.legs.find(l => l.type === 'CE').strike > F);
  const icp = ic.legs.filter(l => l.type === 'PE').map(l => l.strike).sort((a, b) => a - b);
  assert.ok(icp[0] < icp[1], 'long put wing below the short put');
  for (const l of [...sc.legs, ...ic.legs]) assert.ok(rows.some(r => r.strike === l.strike), 'strikes are listed');
  const fair = eng.bandFinder({ rows, F, T, fairAtm: iv, idx: 'NIFTY', cfg });
  assert.ok(fair.strangle.best.ev < 0 && fair.condor.best.ev < 0, 'no edge once costs are paid');
});

test('verdict rules, in order, with one deciding reason', () => {
  const cfg = eng.mergeConfig({});
  const rec = (expiries, pnl, ev) => ({ expiries, pnl, ev, n: expiries * 3 });
  const good = { ev: 10, score: 0.08 }, v = o => eng.tradeVerdict({ structure: 'condor', best: good, regime: 'range', highEvent: false, paper: rec(10, 3000, 4000), tdays: 4, cfg, ...o });
  assert.equal(v({}).verdict, 'TRADE');
  assert.equal(v({ paper: rec(3, 900, 1000) }).verdict, 'PAPER-TRADE ONLY');
  assert.match(v({ paper: rec(3, 900, 1000) }).reason, /3 of 8 expiries/);
  assert.equal(v({ paper: rec(10, -500, 4000) }).verdict, 'PAPER-TRADE ONLY', 'losing paper record never unlocks TRADE');
  assert.match(v({ paper: rec(10, -500, 4000) }).reason, /lost/);
  assert.equal(v({ paper: rec(10, 1000, 4000) }).verdict, 'PAPER-TRADE ONLY', 'paper P&L far below what the model expected');
  assert.equal(v({ highEvent: true }).verdict, 'NO TRADE', 'a high-impact event blocks even a positive EV');
  assert.equal(v({ tdays: 0.6 }).verdict, 'NO TRADE');
  assert.match(v({ tdays: 0.6 }).reason, /expiry day/);
  assert.equal(v({ regime: 'up' }).verdict, 'NO TRADE');
  assert.match(v({ regime: 'up' }).reason, /trend/);
  assert.equal(v({ highEvent: true, best: { ev: -1, score: -0.01 } }).verdict, 'NO TRADE');
  assert.match(v({ highEvent: true, best: { ev: -1, score: -0.01 } }).reason, /event/);
  assert.match(v({ best: { ev: -2, score: -0.02 } }).reason, /negative/);
  assert.match(v({ best: { ev: 1, score: 0.01 } }).reason, /thin/);
  assert.equal(v({ best: null }).verdict, 'NO TRADE');
  assert.match(v({ best: null, regime: 'up' }).reason, /trend/, 'the deciding reason comes before a missing candidate');
  assert.match(v({ best: null, highEvent: true }).reason, /event/);
  const cheap = v({ best: null, edge: { iv: 0.175, fair: 0.274 } });
  assert.equal(cheap.verdict, 'NO TRADE'); assert.match(cheap.reason, /cheap/); assert.match(cheap.reason, /27\.4%.*17\.5%/);
  assert.equal(v({ edge: { iv: 0.15, fair: 0.12 } }).verdict, 'TRADE', 'rich options pass the cheapness check');
  assert.match(v({ edge: { iv: 0.15, fair: 0.15, source: 'iv', note: 'no price history, so fair volatility = implied (no edge assumed)' } }).reason, /no price history/);
  assert.equal(eng.tradeVerdict({ structure: 'strangle', best: { ev: 5, score: 0.035 }, regime: 'range', highEvent: false, paper: rec(9, 2000, 2500), tdays: 3, cfg }).verdict, 'TRADE');
});

test('trade bands end to end, with range view and a today verdict', () => {
  const F = 26000, T = 6 / 365, iv = 0.13, rows = chain(F, T, iv), cfg = eng.mergeConfig({});
  const closes = Array.from({ length: 260 }, (_, i) => 26000 * Math.exp(i % 2 ? 0.004 : 0)); // equal averages: range
  const tb = eng.tradeBands({ rows, F, T, closes, highEvent: false, idx: 'NIFTY', cfg, paper: null });
  assert.equal(tb.regime.regime, 'range');
  assert.ok(tb.fair.vol >= 0.8 * tb.smile.atm - 1e-12);
  const q = tb.range.q;
  assert.ok(q[10] < q[30] && q[30] < q[50] && q[50] < q[70] && q[70] < q[90]);
  near(q[50] / F, 1, 0.003);
  assert.deepEqual(tb.range.bands['30-70'], [q[30], q[70]]);
  assert.ok(['TRADE', 'PAPER-TRADE ONLY', 'NO TRADE'].includes(tb.today.verdict));
  assert.notEqual(tb.today.verdict, 'TRADE', 'no paper record yet, so never TRADE');
  const ev = eng.tradeBands({ rows, F, T, closes, highEvent: true, idx: 'NIFTY', cfg, paper: { condor: { expiries: 20, pnl: 1e5, ev: 1e5 }, strangle: { expiries: 20, pnl: 1e5, ev: 1e5 } } });
  assert.equal(ev.today.verdict, 'NO TRADE');
});

test('trading time: Monday 09:45 to Tuesday expiry is 1.92 trading days', () => {
  near(eng.tradingDaysFrac(Date.UTC(2026, 10, 30, 4, 15), '2026-12-01'), 1 + 345 / 375, 1e-9);
  near(eng.tradingDaysFrac(Date.UTC(2026, 10, 27, 4, 15), '2026-12-01'), 2 + 345 / 375, 1e-9, 'Friday: weekend has no sessions');
  near(eng.tradingDaysFrac(Date.UTC(2026, 11, 1, 10, 30), '2026-12-01'), 1 / 375, 1e-9, 'after the close on expiry day');
});

test('no false edge when options are priced at the true variance (trading-day vs calendar time)', () => {
  // Monday 09:45 IST, Tuesday expiry. The index truly moves s per trading day; options price exactly that, no premium.
  const nowMs = Date.UTC(2026, 10, 30, 4, 15), expiry = '2026-12-01', T = eng.yearFrac(nowMs, expiry), N = eng.tradingDaysFrac(nowMs, expiry);
  const sDay = 0.0075, iv = sDay * Math.sqrt(N / T), F = 26000, rows = chain(F, T, iv);
  const closes = [26000]; for (let i = 0; i < 259; i++) closes.push(closes[i] * Math.exp(i % 2 ? -sDay : sDay));
  const tb = eng.tradeBands({ rows, F, T, tdays: N, closes, highEvent: false, idx: 'NIFTY', cfg: eng.mergeConfig({}), paper: null });
  assert.ok(tb.fair.vol >= tb.smile.atm * 0.98, `fair ${tb.fair.vol} should match implied ${tb.smile.atm}`);
  assert.equal(tb.verdicts.condor.verdict, 'NO TRADE'); assert.equal(tb.verdicts.strangle.verdict, 'NO TRADE');
});

test('skewed 27-day monthly: with fair = implied every structure loses exactly its costs', () => {
  const F = 26000, T = 27 / 365, rows = [];
  for (let K = Math.round(F * 0.93 / 50) * 50; K <= F * 1.07; K += 50) { const m = Math.log(K / F), v = 0.14 - 0.45 * m + 2.5 * m * m;
    rows.push({ strike: K, ce_ltp: Math.round(eng.b76(F, K, T, v, 'CE') / 0.05) * 0.05, pe_ltp: Math.round(eng.b76(F, K, T, v, 'PE') / 0.05) * 0.05 }); }
  for (const idx of ['NIFTY', 'BANKNIFTY']) {
    const sm = eng.fitSmile(rows, F, T), b = eng.bandFinder({ rows, F, T, fairAtm: sm.atm, idx, cfg: eng.mergeConfig({}), smile: sm });
    for (const c of [...b.condor.all, ...b.strangle.all]) near(c.ev, -b.costPts * c.legs.length, 0.05, `${idx} ${c.legs.length}-leg p=${c.p}`);
  }
});

test('tail losses use the wider of implied and fair volatility', () => {
  const F = 26000, T = 6 / 365, iv = 0.13, rows = chain(F, T, iv);
  const b = eng.bandFinder({ rows, F, T, fairAtm: 0.8 * iv, idx: 'NIFTY', cfg: eng.mergeConfig({}) });
  assert.ok(b.stressSd > b.sd * 1.1, 'stress sd is the implied one');
  const s = b.strangle.best, pay = x => s.legs.reduce((a, l) => a + l.side * ((l.type === 'CE' ? Math.max(0, x - l.strike) : Math.max(0, l.strike - x)) - l.price), 0) - b.costPts * 2;
  near(s.loss3, Math.min(pay(F - 3 * b.stressSd), pay(F + 3 * b.stressSd)), 1e-9);
});

test('shorts stay at or outside the 20/80 quantiles; too little history means no edge', () => {
  const F = 26000, T = 6 / 365, iv = 0.13, rows = chain(F, T, iv), cfg = eng.mergeConfig({});
  const b = eng.bandFinder({ rows, F, T, fairAtm: 0.8 * iv, idx: 'NIFTY', cfg });
  assert.ok([...b.condor.all, ...b.strangle.all].every(c => c.p <= 0.2 + 1e-9));
  const short = Array.from({ length: 120 }, (_, i) => 100 * Math.exp(i % 2 ? 0.002 : 0));
  const fv = eng.fairVol({ iv: 0.2, closes: short, regime: 'unknown', highEvent: false, cfg });
  assert.equal(fv.vol, 0.2); assert.equal(fv.source, 'iv');
});

test('event risk counts unconfirmed medium events and only those before expiry', () => {
  const ev = [{ title: 'RBI policy', when: '2026-12-04', impact: 'high' }, { title: 'GDP (date unconfirmed)', when: '2026-11-30', impact: 'medium' }];
  assert.equal(eng.eventRisk(ev, '2026-12-01'), true, 'unconfirmed medium counts');
  assert.equal(eng.eventRisk([ev[0]], '2026-12-01'), false);
  assert.equal(eng.eventRisk([ev[0]], '2026-12-08'), true);
});

test('paper record counts distinct expiries, not daily trades', () => {
  const s = [];
  for (const d of ['2026-11-19', '2026-11-20', '2026-11-21']) s.push({ idx: 'NIFTY', expiry: '2026-11-24', date: d, condor: { taken: true, rupees: 100, evRupees: 80 }, strangle: { taken: false, rupees: -50, evRupees: 10 } });
  s.push({ idx: 'NIFTY', expiry: '2026-12-01', date: '2026-11-26', condor: { taken: true, rupees: -300, evRupees: 90 }, strangle: { taken: true, rupees: 40, evRupees: 30 } });
  const r = eng.paperRecord(s, 'NIFTY');
  assert.deepEqual(r.condor, { expiries: 2, n: 4, pnl: 0, ev: 330, worst: -300 });
  assert.deepEqual(r.strangle, { expiries: 1, n: 1, pnl: 40, ev: 30, worst: 40 });
});
