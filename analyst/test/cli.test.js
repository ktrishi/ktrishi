'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { HTML, sampleChain } = require('./fixtures');
const { loadEngine } = require('../engine');

const RUN = path.join(__dirname, '..', 'run.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'analyst-'));

test('lock command writes locks, analyst/latest and a run log', () => {
  const d = tmp(), ch = sampleChain(loadEngine(HTML));
  fs.writeFileSync(path.join(d, 'input.json'), JSON.stringify({ nowMs: ch.takenMs, slot: '09:40', chains: [ch],
    overlays: { 'NIFTY-monthly': { bandMult: 1.1, nudgeSigma: 0, reasons: ['US CPI tonight'] } }, events: [{ title: 'US CPI', impact: 'high', when: '2026-11-19' }], notes: 'Test run' }));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ versions: { 'analyst/latest': 7 } }));
  execFileSync('node', [RUN, 'lock', '--input', path.join(d, 'input.json'), '--state', path.join(d, 'state.json'), '--out', d]);
  const batch = JSON.parse(fs.readFileSync(path.join(d, 'batch-1.json'), 'utf8')).map(e => ({ ...e, data: JSON.parse(fs.readFileSync(e.file_path, 'utf8')) }));
  const lock = batch.find(w => w.collection === 'locks');
  assert.equal(lock.op, 'set');
  assert.match(lock.doc_id, /^NIFTY-monthly-2026-11-23-2026-11-19-0940$/);
  assert.equal(lock.data.overlay.bandMult, 1.1);
  const latest = batch.find(w => w.collection === 'analyst');
  assert.equal(latest.doc_id, 'latest');
  assert.equal(latest.if_version, 7);
  assert.ok(batch.find(w => w.collection === 'runs'));
});

test('settle command writes outcome, scores, post-mortem and weights', () => {
  const d = tmp(), eng = loadEngine(HTML), ch = sampleChain(eng);
  const { buildLock, DEFAULT_CONFIG } = require('../engine');
  const lock = buildLock({ chain: ch, nowMs: ch.takenMs, cfg: DEFAULT_CONFIG, overlay: {}, events: [], prevLock: null, slot: '09:40' });
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ locks: [lock], outcomes: {}, scores: [], proposals: [], config: DEFAULT_CONFIG, versions: {} }));
  fs.writeFileSync(path.join(d, 'candles.json'), JSON.stringify({ NIFTY: [{ date: '2026-11-23', close: 25366.4 }] }));
  execFileSync('node', [RUN, 'settle', '--state', path.join(d, 'state.json'), '--candles', path.join(d, 'candles.json'), '--now', String(Date.UTC(2026, 10, 24, 4, 10)), '--out', d]);
  const batch = JSON.parse(fs.readFileSync(path.join(d, 'batch-1.json'), 'utf8')).map(e => ({ ...e, data: JSON.parse(fs.readFileSync(e.file_path, 'utf8')) }));
  const cols = new Set(batch.map(w => w.collection));
  for (const c of ['outcomes', 'scores', 'postmortems', 'weights', 'runs']) assert.ok(cols.has(c), 'missing ' + c);
  assert.equal(batch.find(w => w.collection === 'outcomes').data.settlement, 25366.4);
});

test('lock command rejects a bad chain and writes nothing', () => {
  const d = tmp(), ch = sampleChain(loadEngine(HTML));
  fs.writeFileSync(path.join(d, 'input.json'), JSON.stringify({ nowMs: ch.takenMs, slot: '09:40', chains: [{ ...ch, spot: 30000 }], overlays: {}, events: [] }));
  fs.writeFileSync(path.join(d, 'state.json'), '{}');
  assert.throws(() => execFileSync('node', [RUN, 'lock', '--input', path.join(d, 'input.json'), '--state', path.join(d, 'state.json'), '--out', d], { stdio: 'pipe' }), /outside the strike window/);
  assert.equal(fs.existsSync(path.join(d, 'batch-1.json')), false);
});

test('state command assembles a dump directory', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'config')); fs.mkdirSync(path.join(d, 'outcomes'));
  fs.writeFileSync(path.join(d, 'config', 'model.json'), JSON.stringify({ kScale: { NIFTY: 1.2 } }));
  fs.writeFileSync(path.join(d, 'outcomes', 'NIFTY-2026-11-23.json'), JSON.stringify({ settlement: 25366.4 }));
  fs.writeFileSync(path.join(d, 'versions.json'), JSON.stringify({ 'config/model': 3 }));
  execFileSync('node', [RUN, 'state', '--dir', d, '--versions', path.join(d, 'versions.json'), '--out', path.join(d, 'state.json')]);
  const st = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
  assert.equal(st.config.kScale.NIFTY, 1.2);
  assert.equal(st.outcomes['NIFTY-2026-11-23'].settlement, 25366.4);
  assert.equal(st.versions['config/model'], 3);
  assert.deepEqual(st.locks, []);
});
