'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { HTML } = require('./fixtures');
const { loadEngine } = require('../engine');

const eng = loadEngine(HTML);
const PREP = path.join(__dirname, '..', 'prep.js'), RUN = path.join(__dirname, '..', 'run.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'));
const NOW = Date.UTC(2026, 10, 26, 4, 12); // Thu 26-Nov-2026 09:42 IST
const EXP = 'NIFTY=2026-11-24,2026-12-01,2026-12-08,2026-12-15,2026-12-22,2026-12-29,2027-01-05,2027-01-26;BANKNIFTY=2026-12-29,2027-01-26';
const run = (args, opts) => execFileSync('node', args, { encoding: 'utf8', stdio: 'pipe', ...opts });

function quoteFile(plan, file, call, dropPrefix) {
  const data = {};
  for (const [name, idx] of Object.entries(plan.indices)) {
    if (call === 2) { data[idx.future] = { last_price: idx.spot * 1.0037 }; data[idx.spotSymbol] = { last_price: idx.spot }; }
    for (const g of idx.contracts.filter(g => g.call === call && g.prefix !== dropPrefix)) {
      const T = eng.yearFrac(NOW, g.expiry);
      for (let k = g.lo; k <= g.hi; k += idx.step) for (const ty of ['CE', 'PE'])
        data[`${g.prefix}${k}${ty}`] = { last_price: Math.max(0.05, Math.round(eng.b76(idx.spot, k, T, 0.15, ty) / 0.05) * 0.05), oi: 1000 + k % 700 };
    }
  }
  if (call === 2) data['NSE:INDIA VIX'] = { last_price: 17.26 };
  fs.writeFileSync(file, JSON.stringify({ data }));
}

test('plan picks contracts, prefixes, futures and quote calls', () => {
  const d = tmp(), out = path.join(d, 'plan.json');
  const txt = run([PREP, 'plan', '--expiries', EXP, '--spot', 'NIFTY=25772.55,BANKNIFTY=63726.55', '--now', String(NOW), '--out', out]);
  const p = JSON.parse(fs.readFileSync(out, 'utf8')), n = p.indices.NIFTY;
  assert.deepEqual(n.contracts.map(g => [g.kinds.join('+'), g.expiry, g.prefix]), [
    ['weekly', '2026-12-01', 'NFO:NIFTY26D01'], ['weekly2', '2026-12-08', 'NFO:NIFTY26D08'], ['weekly3', '2026-12-15', 'NFO:NIFTY26D15'], ['monthly', '2026-12-29', 'NFO:NIFTY26DEC']]);
  assert.equal(n.future, 'NFO:NIFTY26DECFUT');
  assert.equal(p.indices.BANKNIFTY.contracts[0].prefix, 'NFO:BANKNIFTY26DEC');
  assert.equal(n.contracts[0].lo, 24500); assert.equal(n.contracts[0].hi, 27050);
  assert.equal(n.contracts[3].lo, 24000); // 25772.55 x 0.93 = 23968 -> next strike up
  assert.match(txt, /QUOTE CALL 1: mode "quote", \d+ instruments/);
  assert.match(txt, /plus NFO:NIFTY26DECFUT, NFO:BANKNIFTY26DECFUT, NSE:NIFTY 50, NSE:NIFTY BANK, NSE:INDIA VIX/);
});

test('plan merges a third weekly that is also the monthly, and uses non-monthly January symbols', () => {
  const d = tmp(), out = path.join(d, 'plan.json');
  run([PREP, 'plan', '--expiries', EXP, '--spot', 'NIFTY=26000,BANKNIFTY=60000', '--now', String(Date.UTC(2026, 11, 14, 4, 12)), '--out', out]);
  const g = JSON.parse(fs.readFileSync(out, 'utf8')).indices.NIFTY.contracts;
  assert.deepEqual(g.map(x => x.kinds.join('+')), ['weekly', 'weekly2', 'weekly3+monthly']);
  assert.equal(g[2].window, 0.07);
  const { prefixFor } = require('../prep');
  assert.equal(prefixFor('NIFTY', '2027-01-05', ['2027-01-05', '2027-01-26']), 'NFO:NIFTY27105');
});

test('plan asks for expiries when the cache is stale', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'latest.json'), JSON.stringify({ cache: { date: '2026-11-25', expiries: { NIFTY: ['2026-12-01'] } } }));
  let out = '';
  try { run([PREP, 'plan', '--latest', path.join(d, 'latest.json'), '--spot', 'NIFTY=1,BANKNIFTY=1', '--now', String(NOW), '--out', path.join(d, 'p.json')]); } catch (e) { out = e.stdout; assert.equal(e.status, 5); }
  assert.match(out, /NEED_EXPIRIES NIFTY BANKNIFTY/);
});

test('build writes the lock input from saved quote files, and the lock runs on it', () => {
  const d = tmp(), pf = path.join(d, 'plan.json');
  run([PREP, 'plan', '--expiries', EXP, '--spot', 'NIFTY=25772.55,BANKNIFTY=63726.55', '--now', String(NOW), '--out', pf]);
  const plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
  quoteFile(plan, path.join(d, 'q1.json'), 1); quoteFile(plan, path.join(d, 'q2.json'), 2);
  fs.writeFileSync(path.join(d, 'candles.json'), JSON.stringify({ NIFTY: [{ date: '2026-11-23', high: 25900, low: 25500, close: 25800.6 }, { date: '2026-11-24', high: 1, low: 1, close: 25700 }, { date: '2026-11-25', high: 25951.65, low: 25619, close: 25819.25 }, { date: '2026-11-26', high: 9, low: 9, close: 9 }],
    BANKNIFTY: [{ date: '2026-11-25', high: 64133.8, low: 63247.9, close: 63703.25 }] }));
  const inp = path.join(d, 'input.json');
  run([PREP, 'build', '--plan', pf, '--quotes', `${d}/q1.json,${d}/q2.json`, '--candles', path.join(d, 'candles.json'), '--slot', '09:40', '--now', String(NOW), '--out', inp]);
  const input = JSON.parse(fs.readFileSync(inp, 'utf8'));
  assert.deepEqual(input.chains.map(c => `${c.idx}-${c.kind}`), ['NIFTY-weekly', 'NIFTY-weekly2', 'NIFTY-weekly3', 'NIFTY-monthly', 'BANKNIFTY-monthly']);
  const w = input.chains[0];
  assert.equal(w.futExpiry, '2026-12-29'); assert.equal(w.vix, 17.26); assert.ok(Math.abs(w.future - 25772.55 * 1.0037) < 1e-6);
  assert.deepEqual(w.prevHLC, [25951.65, 25619, 25819.25]); assert.equal(w.close3, 25800.6);
  assert.equal(input.cache.expiries.NIFTY.length, 8);
  fs.writeFileSync(path.join(d, 'research.json'), JSON.stringify({ events: [{ title: 'RBI policy', when: '2026-12-04', impact: 'high' }], overlays: { 'NIFTY-weekly': { bandMult: 1.05, nudgeSigma: 0, reasons: ['GDP'] } }, notes: 'n', sources: ['s'], eventsVerifiedMs: 123 }));
  fs.writeFileSync(path.join(d, 'state.json'), '{}');
  run([RUN, 'lock', '--input', inp, '--research', path.join(d, 'research.json'), '--state', path.join(d, 'state.json'), '--out', path.join(d, 'lock')]);
  const entries = JSON.parse(fs.readFileSync(path.join(d, 'lock', 'batch-1.json'), 'utf8')), doc = e => JSON.parse(fs.readFileSync(e.file_path, 'utf8'));
  assert.equal(entries.filter(e => e.collection === 'locks').length, 5);
  assert.equal(entries.filter(e => e.collection === 'trades').length, 5, 'one paper trade per index and expiry');
  const latest = doc(entries.find(e => e.collection === 'analyst'));
  assert.equal(latest.cache.eventsVerifiedMs, 123); assert.equal(latest.events[0].title, 'RBI policy'); assert.equal(latest.overlays['NIFTY-weekly'].bandMult, 1.05);
});

test('build refuses when an expiry did not come back (wrong prefix)', () => {
  const d = tmp(), pf = path.join(d, 'plan.json');
  run([PREP, 'plan', '--expiries', EXP, '--spot', 'NIFTY=25772.55,BANKNIFTY=63726.55', '--now', String(NOW), '--out', pf]);
  const plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
  quoteFile(plan, path.join(d, 'q1.json'), 1, 'NFO:NIFTY26D08'); quoteFile(plan, path.join(d, 'q2.json'), 2);
  let err = '';
  try { run([PREP, 'build', '--plan', pf, '--quotes', `${d}/q1.json,${d}/q2.json`, '--slot', '09:40', '--now', String(NOW), '--out', path.join(d, 'i.json')]); } catch (e) { err = e.stderr; assert.equal(e.status, 4); }
  assert.match(err, /MISSING NFO:NIFTY26D08/);
  assert.equal(fs.existsSync(path.join(d, 'i.json')), false);
});
