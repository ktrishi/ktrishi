'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMiss, scoreLock, postmortem, proposals, applyApproved, settleDue } = require('../learn');
const { DEFAULT_CONFIG } = require('../engine');

const L = (o = {}) => ({ id: 'NIFTY-weekly-2026-12-01-2026-11-25-0940', idx: 'NIFTY', kind: 'weekly', expiry: '2026-12-01', date: '2026-11-25', slot: '09:40',
  madeAt: Date.UTC(2026, 10, 25, 4, 10), centre: 25000, modelCentre: 25000, band68: [24800, 25200], band90: [24671, 25329], sigma: 200,
  spot: 25000, future: 25010, forward: 25010, step: 50, maxPain: 25100, gammaPin: 25050, supports: [24800], resistances: [25300],
  centres: { forward: 25010, max_pain: 25100, pivot: 24700 }, eventsHigh: false, bucket: '2to5', ...o });

test('classifyMiss covers each type', () => {
  assert.equal(classifyMiss(L(), 25100).type, 'in_range');
  assert.equal(classifyMiss(L(), 25100).pinHeld, true);
  assert.equal(classifyMiss(L({ eventsHigh: true }), 25450).type, 'event_shock');
  assert.equal(classifyMiss(L(), 25450).type, 'trend_breakout');
  assert.equal(classifyMiss(L({ resistances: [25600] }), 25350).type, 'vol_surprise');
  assert.equal(classifyMiss(L({ centre: 25300, band68: [25250, 25350], spot: 25000, resistances: [25600] }), 25040).type, 'vol_overpriced');
  assert.equal(classifyMiss(L({ sigma: null, band68: null }), 25100).type, 'no_range');
});

test('scoreLock records three-way errors', () => {
  const s = scoreLock(L({ centre: 25050 }), 25100);
  assert.ok(Math.abs(s.errPct - (25050 - 25100) / 25100 * 100) < 1e-9);
  assert.ok(Math.abs(s.modelErrPct - (25000 - 25100) / 25100 * 100) < 1e-9);
  assert.ok(Math.abs(s.futErrPct - (25010 - 25100) / 25100 * 100) < 1e-9);
  assert.equal(s.in68, true);
  assert.ok(Math.abs(s.signalErrs.max_pain) < 1e-9);
});

test('postmortem names the closest signal and the miss', () => {
  const pm = postmortem('NIFTY', '2026-12-01', [L(), L({ madeAt: L().madeAt + 1, slot: '14:45', centre: 25020 })], 25450);
  assert.equal(pm.miss, 'trend_breakout');
  assert.equal(pm.closestSignal, 'max_pain');
  assert.match(pm.narrative, /Settled 25,450/);
  assert.equal(pm.lastSlot, '14:45');
});

test('settle skips missing candle', () => {
  const locks = [L({ expiry: '2026-11-23' }), L({ expiry: '2026-12-01' })];
  const now = { date: '2026-12-01', hm: '16:00' };
  const due = settleDue(locks, {}, { NIFTY: [{ date: '2026-11-23', close: 25366.4 }] }, now);
  assert.deepEqual(due, [{ idx: 'NIFTY', expiry: '2026-11-23', settlement: 25366.4 }]);
  assert.deepEqual(settleDue(locks, { 'NIFTY-2026-11-23': {} }, { NIFTY: [] }, now), []);
});

function scoresWithCoverage(hits, n = 8) {
  return Array.from({ length: n }, (_, i) => ({ idx: 'NIFTY', expiry: `2026-0${1 + Math.floor(i / 4)}-1${i % 4}`, madeAt: i, in68: i < hits,
    zModel: i < hits ? 0.5 : 2.0, errPct: 0.3, modelErrPct: 0.3, futErrPct: 0.4, eventsHigh: false, signalErrs: { forward: 0.4, max_pain: 0.2 } }));
}

test('widen proposal when 68% range held only 3 of 8', () => {
  const ps = proposals('NIFTY', scoresWithCoverage(3), DEFAULT_CONFIG, []);
  const p = ps.find(x => x.rule === 'widen_range');
  assert.ok(p, 'expected a widen proposal');
  assert.equal(p.change.field, 'kScale');
  assert.ok(p.change.value > 1);
  assert.equal(p.status, 'pending');
});

test('no duplicate pending proposal', () => {
  const first = proposals('NIFTY', scoresWithCoverage(3), DEFAULT_CONFIG, []);
  const again = proposals('NIFTY', scoresWithCoverage(3), DEFAULT_CONFIG, first);
  assert.equal(again.filter(x => x.rule === 'widen_range').length, 0);
});

test('fewer than 6 expiries proposes nothing', () => {
  assert.deepEqual(proposals('NIFTY', scoresWithCoverage(1, 5), DEFAULT_CONFIG, []), []);
});

test('applyApproved changes config', () => {
  const p = { id: 'x', status: 'approved', change: { field: 'kScale', idx: 'NIFTY', value: 1.4 } };
  const q = { id: 'y', status: 'approved', change: { field: 'dropped', idx: 'NIFTY', add: 'pivot' } };
  const { cfg, appliedIds } = applyApproved(DEFAULT_CONFIG, [p, q]);
  assert.equal(cfg.kScale.NIFTY, 1.4);
  assert.deepEqual(cfg.dropped.NIFTY, ['pivot']);
  assert.deepEqual(appliedIds, ['x', 'y']);
  assert.equal(DEFAULT_CONFIG.kScale.NIFTY, 1);
});

test('futures baseline uses the expiry-adjusted forward', () => {
  const s = scoreLock(L({ future: 26110, forward: 26013 }), 26010);
  assert.ok(Math.abs(s.futErrPct - (26013 - 26010) / 26010 * 100) < 1e-9);
});

test('widen proposal is relative to the current effective width and ignores pre-change scores', () => {
  const rows = scoresWithCoverage(3).map(r => ({ ...r, kEff: 1.25 }));
  const p = proposals('NIFTY', rows, { ...DEFAULT_CONFIG, kScale: { NIFTY: 1.25, BANKNIFTY: 1 } }, []).find(x => x.rule === 'widen_range');
  assert.ok(p);
  assert.ok(Math.abs(p.change.value - 2.0) < 1e-9, 'p68 z=2.0 on effective 1.25 at scale 1.25 -> scale 2.0, got ' + p.change.value);
  const cfg = { ...DEFAULT_CONFIG, changedMs: { 'kScale:NIFTY': 100 } };
  assert.equal(proposals('NIFTY', rows, cfg, []).filter(x => x.rule === 'widen_range').length, 0);
});

test('recently rejected proposals are not raised again', () => {
  const rejected = [{ idx: 'NIFTY', rule: 'widen_range', status: 'rejected', decidedMs: Date.UTC(2026, 10, 20) }];
  assert.equal(proposals('NIFTY', scoresWithCoverage(3), DEFAULT_CONFIG, rejected, Date.UTC(2026, 10, 25)).filter(x => x.rule === 'widen_range').length, 0);
});

test('BANKNIFTY pin uses its own step', () => {
  const m = classifyMiss(L({ idx: 'BANKNIFTY', step: undefined, maxPain: 62000, gammaPin: null }), 62090);
  assert.equal(m.pinHeld, true);
});
