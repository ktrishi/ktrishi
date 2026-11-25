#!/usr/bin/env node
'use strict';
// Analyst CLI. Produces ArtifactData batch files (<=50 writes each) for the F&O Expiry Desk database.
//   node analyst/run.js lock   --input input.json --state state.json --out DIR
//   node analyst/run.js settle --state state.json --candles candles.json [--now MS] --out DIR
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine, buildLock, DEFAULT_CONFIG } = require('./engine');
const { scoreLock, postmortem, settleDue, proposals, applyApproved } = require('./learn');

const HTML = path.join(__dirname, '..', 'artifact', 'fo_expiry_desk.html');
const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function writeBatches(out, writes) {
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  for (let i = 0; i * 50 < writes.length; i++) {
    const f = path.join(out, `batch-${i + 1}.json`);
    fs.writeFileSync(f, JSON.stringify(writes.slice(i * 50, i * 50 + 50), null, 1));
    files.push(f);
  }
  console.log(`${writes.length} writes in ${files.length} batch file(s):\n${files.join('\n')}`);
}
function w(collection, doc_id, data, versions) {
  const e = { op: 'set', collection, doc_id, data };
  const v = versions && versions[`${collection}/${doc_id}`];
  if (v) e.if_version = v;
  return e;
}

function lockCmd() {
  const input = readJson(arg('input')), state = readJson(arg('state'));
  const cfg = state.config || DEFAULT_CONFIG, eng = loadEngine(HTML), versions = state.versions || {};
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
  writes.push(w('analyst', 'latest', {
    runMs: input.nowMs, slot: input.slot, events: input.events || [], notes: input.notes || '',
    overlays: Object.fromEntries(made.map(l => [l.key, { expiry: l.expiry, ...l.overlay, centre: l.centre, modelCentre: l.modelCentre, band68: l.band68, modelBand68: l.modelBand68 }])),
    sources: input.sources || [],
  }, versions));
  writes.push(w('runs', String(input.nowMs), { runMs: input.nowMs, kind: 'lock', slot: input.slot, status: 'ok', locks: made.map(l => l.id) }, versions));
  writeBatches(arg('out'), writes);
}

function settleCmd() {
  const state = readJson(arg('state')), candles = readJson(arg('candles'));
  const nowMs = Number(arg('now')) || Date.now(), eng = loadEngine(HTML), now = eng.ist(nowMs), versions = state.versions || {};
  let cfg = state.config || DEFAULT_CONFIG;
  const locks = state.locks || [], outcomes = state.outcomes || {}, scores = [...(state.scores || [])], props = [...(state.proposals || [])];
  const writes = [];
  // 1. apply proposals Rishi approved on the dashboard
  const { cfg: newCfg, appliedIds } = applyApproved(cfg, props.filter(p => p.status === 'approved'));
  if (appliedIds.length) {
    cfg = newCfg;
    writes.push(w('config', 'model', { ...cfg, updatedMs: nowMs }, versions));
    for (const p of props.filter(p => appliedIds.includes(p.id))) { p.status = 'applied'; p.appliedMs = nowMs; writes.push(w('proposals', p.id, p, versions)); }
  }
  // 2. settle expired expiries that have locks
  const due = settleDue(locks, outcomes, candles, now);
  const touched = new Set();
  for (const d of due) {
    const L = locks.filter(l => l.idx === d.idx && l.expiry === d.expiry);
    writes.push(w('outcomes', `${d.idx}-${d.expiry}`, { idx: d.idx, underlying: d.idx, expiry: d.expiry, settlement: d.settlement, settledMs: nowMs }, versions));
    for (const l of L) { const s = scoreLock(l, d.settlement); scores.push(s); writes.push(w('scores', s.id, s, versions)); }
    for (const kind of new Set(L.map(l => l.kind))) {
      const pm = postmortem(d.idx, d.expiry, L.filter(l => l.kind === kind), d.settlement);
      pm.id = `${d.idx}-${kind}-${d.expiry}`; pm.kind = kind;
      writes.push(w('postmortems', pm.id, pm, versions));
    }
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
  writes.push(w('runs', String(nowMs), { runMs: nowMs, kind: 'settle', status: 'ok', settled: due.map(d => `${d.idx}-${d.expiry}`), applied: appliedIds }, versions));
  writeBatches(arg('out'), writes);
}

try {
  const cmd = process.argv[2];
  if (cmd === 'lock') lockCmd(); else if (cmd === 'settle') settleCmd();
  else { console.error('usage: run.js lock|settle ...'); process.exit(2); }
} catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
