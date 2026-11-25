'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, sampleChain } = require('./fixtures');
const { loadEngine, validateChain, applyConfig, buildLock, DEFAULT_CONFIG } = require('../engine');

const eng = loadEngine(HTML);

test('engine loads from the page and reproduces max pain', () => {
  const ch = sampleChain(eng);
  const snap = { expiry: ch.expiry, futExpiry: ch.futExpiry, takenMs: ch.takenMs, spot: ch.spot, future: ch.future,
    options: ch.rows.flatMap(r => [{ strike: r.strike, type: 'CE', ltp: r.ce_ltp, oi: r.ce_oi }, { strike: r.strike, type: 'PE', ltp: r.pe_ltp, oi: r.pe_oi }]) };
  const s = eng.computeSignals(snap, null, null, null);
  assert.equal(s.maxPain, 25200);
  assert.deepEqual(s.supports, [25100, 25000]);
});

test('validate rejects bad chain', () => {
  const ch = sampleChain(eng);
  assert.throws(() => validateChain({ ...ch, rows: [...ch.rows, ch.rows[0]] }), /duplicate strike 25000/);
  assert.throws(() => validateChain({ ...ch, rows: ch.rows.map((r, i) => i ? r : { ...r, ce_oi: -1 }) }), /negative OI/);
  assert.throws(() => validateChain({ ...ch, spot: 30000 }), /spot 30000 is outside/);
  assert.doesNotThrow(() => validateChain(ch));
});

test('applyConfig drops signals, floors forward and scales bands', () => {
  const ws = { weights: { forward: .4, max_pain: .3, pivot: .3 }, k68: 1, k90: 1.645, version: 'v', source: 'live' };
  const cfg = { ...DEFAULT_CONFIG, dropped: { NIFTY: ['pivot'] }, forwardFloor: { NIFTY: 0.6 }, kScale: { NIFTY: 1.2 } };
  const out = applyConfig(ws, cfg, 'NIFTY');
  assert.equal(out.weights.pivot, undefined);
  assert.ok(Math.abs(out.weights.forward - 0.6) < 1e-9 && Math.abs(out.weights.max_pain - 0.4) < 1e-9);
  assert.ok(Math.abs(out.k68 - 1.2) < 1e-9 && Math.abs(out.k90 - 1.645 * 1.2) < 1e-9);
});

test('overlay is clamped and reasons kept', () => {
  const ch = sampleChain(eng);
  const lock = buildLock({ chain: ch, nowMs: ch.takenMs, weights: null, cfg: DEFAULT_CONFIG,
    overlay: { bandMult: 2, nudgeSigma: 1, reasons: ['RBI policy tomorrow'] }, events: [{ title: 'RBI MPC', impact: 'high' }], prevLock: null, slot: '09:40' });
  assert.equal(lock.overlay.bandMult, 1.3);
  assert.equal(lock.overlay.nudgeSigma, 0.25);
  assert.deepEqual(lock.overlay.reasons, ['RBI policy tomorrow']);
  assert.ok(Math.abs(lock.centre - (lock.modelCentre + 0.25 * lock.sigma)) < 1e-6);
  const w68 = lock.band68[1] - lock.band68[0], m68 = lock.modelBand68[1] - lock.modelBand68[0];
  assert.ok(Math.abs(w68 / m68 - 1.3) < 1e-9);
  assert.equal(lock.eventsHigh, true);
  assert.equal(lock.reason, 'first prediction of the series');
  assert.equal(lock.future, 25200);
});
