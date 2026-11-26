#!/usr/bin/env node
'use strict';
// Analyst CLI. Produces ArtifactData batch files (<=50 writes each) for the F&O Expiry Desk database.
//   node analyst/run.js lock   --input input.json --state state.json --out DIR
//   node analyst/run.js settle --state state.json --candles candles.json [--now MS] --out DIR
//   node analyst/run.js state  --dir DUMPDIR [--versions versions.json] --out state.json
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine, buildLock, buildTrade, DEFAULT_CONFIG } = require('./engine');
const { scoreLock, postmortem, settleDue, proposals, applyApproved, settleTrade, paperRecord } = require('./learn');

const HTML = path.join(__dirname, '..', 'artifact', 'fo_expiry_desk.html');
const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// Each document goes to its own JSON file; batch files hold only small {op, collection, doc_id, file_path, if_version}
// entries, so the run can pass a batch to ArtifactData without copying the documents through the conversation.
function writeBatches(out, writes) {
  fs.mkdirSync(path.join(out, 'docs'), { recursive: true });
  const entries = writes.map(e => {
    const f = path.resolve(out, 'docs', `${e.collection}__${e.doc_id}.json`);
    fs.writeFileSync(f, JSON.stringify(e.data));
    const { data, ...rest } = e;
    return { ...rest, file_path: f };
  });
  const files = [];
  for (let i = 0; i * 50 < entries.length; i++) {
    const f = path.join(out, `batch-${i + 1}.json`);
    fs.writeFileSync(f, JSON.stringify(entries.slice(i * 50, i * 50 + 50)));
    files.push(f);
  }
  console.log(`${entries.length} writes in ${files.length} batch file(s):\n${files.join('\n')}`);
}
let EXISTING = new Set(), MISSING = [];
function w(collection, doc_id, data, versions) {
  const e = { op: 'set', collection, doc_id, data };
  const k = `${collection}/${doc_id}`, v = versions && versions[k];
  if (v) e.if_version = v; else if (EXISTING.has(k)) MISSING.push(k);
  return e;
}
// An existing document can only be overwritten with its version: stop and say which versions to fetch.
function finish(out, writes) {
  if (MISSING.length) { console.error([...new Set(MISSING)].map(k => 'NEEDS_VERSION ' + k).join('\n')); process.exit(3); }
  writeBatches(out, writes);
}

function lockCmd() {
  const input = readJson(arg('input')), state = readJson(arg('state'));
  const eng = loadEngine(HTML), cfg = eng.mergeConfig(state.config), versions = state.versions || {};
  EXISTING = new Set(state.existing || []);
  const prevLocks = state.locks || [], writes = [], made = [];
  for (const chain of input.chains) {
    const bucket = eng.dteBucket(eng.ist(input.nowMs).date, chain.expiry);
    const ws = state.weights && state.weights[`${chain.idx}-${bucket}`];
    const key = `${chain.idx}-${chain.kind}`;
    const prev = prevLocks.filter(l => l.key === key && l.expiry === chain.expiry).sort((a, b) => a.madeAt - b.madeAt).pop() || null;
    const lock = buildLock({ chain, nowMs: input.nowMs, weights: ws || null, cfg, overlay: (input.overlays || {})[key], events: input.events, prevLock: prev, slot: input.slot, htmlPath: HTML });
    made.push(lock);
  }
  for (const l of made) writes.push(w('locks', l.id, l, versions));
  // Morning only: one paper trade per contract (kinds sharing an expiry share it). Never rewritten later, so the record has no hindsight.
  const trades = [];
  if ((input.slot || eng.ist(input.nowMs).hm) < '12:00') {
    const done = new Set(), history = input.history || state.history || null;
    input.chains.forEach((chain, i) => {
      const k = `${chain.idx}|${chain.expiry}`;
      if (done.has(k)) return; done.add(k);
      const t = buildTrade({ chain, lock: made[i], history, events: input.events, cfg, paper: paperRecord(state.tradescores, chain.idx), htmlPath: HTML });
      if (!EXISTING.has('trades/' + t.id)) { trades.push(t); writes.push(w('trades', t.id, t, versions)); }
      console.log(`TRADE ${t.id}: ${t.today.verdict} (${t.today.structure || '-'}) - ${t.today.reason}${t.historyUsed === false ? ' [no fresh price history]' : ''}`);
    });
  }
  writes.push(w('analyst', 'latest', {
    runMs: input.nowMs, slot: input.slot, events: input.events || [], notes: input.notes || '',
    overlays: Object.fromEntries(made.map(l => [l.key, { expiry: l.expiry, ...l.overlay, centre: l.centre, modelCentre: l.modelCentre, band68: l.band68, modelBand68: l.modelBand68 }])),
    sources: input.sources || [],
    // reusable context (expiry list, verified event calendar, candles) so later runs can skip refetching it
    cache: input.cache || null,
  }, versions));
  writes.push(w('runs', String(input.nowMs), { runMs: input.nowMs, kind: 'lock', slot: input.slot, status: 'ok', locks: made.map(l => l.id), trades: trades.map(t => `${t.id}: ${t.today.verdict}`) }, versions));
  finish(arg('out'), writes);
}

function settleCmd() {
  const state = readJson(arg('state')), candles = readJson(arg('candles'));
  const nowMs = Number(arg('now')) || Date.now(), eng = loadEngine(HTML), now = eng.ist(nowMs), versions = state.versions || {};
  let cfg = eng.mergeConfig(state.config);
  EXISTING = new Set(state.existing || []);
  const locks = state.locks || [], outcomes = state.outcomes || {}, scores = [...(state.scores || [])], props = [...(state.proposals || [])];
  const writes = [];
  // 1. apply proposals Rishi approved on the dashboard
  const { cfg: newCfg, appliedIds } = applyApproved(cfg, props.filter(p => p.status === 'approved'), nowMs);
  if (appliedIds.length) {
    cfg = newCfg;
    writes.push(w('config', 'model', { ...cfg, updatedMs: nowMs }, versions));
    for (const p of props.filter(p => appliedIds.includes(p.id))) { p.status = 'applied'; p.appliedMs = nowMs; writes.push(w('proposals', p.id, p, versions)); }
  }
  // 2. settle expired expiries that have locks
  const due = settleDue(locks, outcomes, candles, now);
  const touched = new Set(), outcomeWrites = [];
  for (const d of due) {
    const L = locks.filter(l => l.idx === d.idx && l.expiry === d.expiry);
    // the outcome marks an expiry as settled, so it is written last: a failed batch leaves the expiry to be retried
    outcomeWrites.push(w('outcomes', `${d.idx}-${d.expiry}`, { idx: d.idx, underlying: d.idx, expiry: d.expiry, settlement: d.settlement, settledMs: nowMs }, versions));
    for (const l of L) { const s = scoreLock(l, d.settlement); if (!scores.some(x => x.id === s.id)) scores.push(s); if (!EXISTING.has('scores/' + s.id)) writes.push(w('scores', s.id, s, versions)); }
    for (const kind of new Set(L.map(l => l.kind))) {
      const pm = postmortem(d.idx, d.expiry, L.filter(l => l.kind === kind), d.settlement);
      pm.id = `${d.idx}-${kind}-${d.expiry}`; pm.kind = kind;
      if (!EXISTING.has('postmortems/' + pm.id)) writes.push(w('postmortems', pm.id, pm, versions));
    }
    for (const t of (state.trades || []).filter(t => t.idx === d.idx && t.expiry === d.expiry && !t.error))
      if (!EXISTING.has('tradescores/' + t.id)) writes.push(w('tradescores', t.id, settleTrade(t, d.settlement), versions));
    touched.add(d.idx);
  }
  // 3. refit weights (model centre, shrinkage toward the prior) and raise proposals for every index that settled
  for (const idx of touched) {
    const mine = scores.filter(s => s.idx === idx);
    for (const bucket of new Set(mine.map(s => s.bucket))) {
      const rows = mine.filter(s => s.bucket === bucket);
      const recent = [...new Set(rows.map(r => r.expiry))].sort().slice(-20);
      const fit = eng.refit(rows.filter(r => recent.includes(r.expiry)).map(r => ({ ...r, centre: r.modelCentre })), { weights: eng.PRIOR[bucket], ...eng.PRIOR_K });
      writes.push(w('weights', `${idx}-${bucket}`, { ...fit, version: 'live-' + now.date.replace(/-/g, ''), source: 'live', updatedMs: nowMs }, versions));
    }
    for (const p of proposals(idx, mine, cfg, props, nowMs)) { props.push(p); writes.push(w('proposals', p.id, p, versions)); }
  }
  writes.push(...outcomeWrites);
  writes.push(w('runs', String(nowMs), { runMs: nowMs, kind: 'settle', status: 'ok', settled: due.map(d => `${d.idx}-${d.expiry}`), applied: appliedIds }, versions));
  finish(arg('out'), writes);
}

// Assemble state.json from an ArtifactData out_dir dump (<dir>/<collection>/<doc_id>.json) plus versions.json.
function stateCmd() {
  const dir = arg('dir'), read = col => { const d = path.join(dir, col); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => ({ id: f.slice(0, -5), ...readJson(path.join(d, f)) })) : []; };
  const byId = xs => Object.fromEntries(xs.map(x => [x.id, x]));
  const cfg = read('config').find(x => x.id === 'model');
  const state = {
    config: cfg ? (({ id, ...c }) => c)(cfg) : undefined,
    weights: byId(read('weights')), locks: read('locks'), outcomes: byId(read('outcomes')), scores: read('scores'), proposals: read('proposals'),
    trades: read('trades'), tradescores: read('tradescores'),
    // daily closes the page saves once a day, for realised volatility and the trend filter
    history: Object.fromEntries(read('latest').filter(x => x.id.startsWith('hist-')).map(x => [x.id.slice(5), { asOf: x.asOf, closes: x.closes }])),
    versions: arg('versions') && fs.existsSync(arg('versions')) ? readJson(arg('versions')) : {},
    existing: ['locks', 'outcomes', 'scores', 'proposals', 'weights', 'config', 'postmortems', 'analyst', 'trades', 'tradescores'].flatMap(col => read(col).map(x => `${col}/${x.id}`)),
  };
  fs.writeFileSync(arg('out'), JSON.stringify(state));
  console.log(`state: ${state.trades.length} trades, history ${Object.keys(state.history).join('/') || 'none'}, ${state.locks.length} locks, ${Object.keys(state.outcomes).length} outcomes, ${state.scores.length} scores, ${state.proposals.length} proposals, config ${cfg ? 'found' : 'default'}`);
}

try {
  const cmd = process.argv[2];
  if (cmd === 'lock') lockCmd(); else if (cmd === 'settle') settleCmd(); else if (cmd === 'state') stateCmd();
  else { console.error('usage: run.js lock|settle ...'); process.exit(2); }
} catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
