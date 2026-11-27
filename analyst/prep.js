#!/usr/bin/env node
'use strict';
// Token-saving helpers for the scheduled run: the model fetches, the script does the bookkeeping.
//   plan : node analyst/prep.js plan --latest DUMP/analyst/latest.json [--expiries 'NIFTY=d1,d2,...;BANKNIFTY=d1,...']
//                                  --spot 'NIFTY=25772.5,BANKNIFTY=63726.5' --now MS --out plan.json
//          Picks the contracts, symbol prefixes, futures and strike windows, and prints exactly what the two quote calls need.
//   build: node analyst/prep.js build --plan plan.json --quotes q1.json,q2.json [--candles candles.json]
//                                  [--latest DUMP/analyst/latest.json] --slot 09:40 --now MS --out input.json
//          Turns the saved quote files into input.json (chains, spot, futures, VIX, prevHLC, close3, cache).
//   quiet: node analyst/prep.js quiet --latest DUMP/analyst/latest.json --spot 'NIFTY=..,BANKNIFTY=..' --vix V --now MS
//          Afternoon only. Prints QUIET (skip this run) or RUN <reason>.
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine } = require('./engine');

const eng = loadEngine(path.join(__dirname, '..', 'artifact', 'fo_expiry_desk.html'));
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEK_M = '123456789OND';
const WINDOW = { weekly: 0.05, weekly2: 0.05, weekly3: 0.05, monthly: 0.07 };
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const kv = s => Object.fromEntries(String(s || '').split(/[;,]/).filter(x => x.includes('=')).map(x => { const [k, v] = x.split('='); return [k.trim(), v.trim()]; }));

// Contract selection, exactly as the dashboard does it: weekly/weekly2/weekly3 = 1st/2nd/3rd live expiry,
// monthly = the last live expiry in the first live expiry's calendar month.
function contracts(u, all, now) {
  const live = [...all].sort().filter(e => eng.isLive(e, now));
  if (!live.length) throw new Error(`no live expiry for ${u.name}`);
  const monthly = live.filter(e => e.slice(0, 7) === live[0].slice(0, 7)).pop();
  const out = [];
  ['weekly', 'weekly2', 'weekly3'].forEach((k, i) => { if (u.kinds.includes(k) && live[i]) out.push({ kind: k, expiry: live[i] }); });
  if (u.kinds.includes('monthly')) out.push({ kind: 'monthly', expiry: monthly });
  return { live, monthly, list: out };
}
// Symbol prefix: the last expiry of its calendar month uses NAME+YY+MON; any other weekly uses NAME+YY+M+DD.
function prefixFor(name, expiry, all) {
  const [y, m, d] = expiry.split('-'), yy = y.slice(2);
  const lastOfMonth = [...all].filter(e => e.slice(0, 7) === expiry.slice(0, 7)).sort().pop() === expiry;
  return lastOfMonth ? `NFO:${name}${yy}${MON[+m - 1]}` : `NFO:${name}${yy}${WEEK_M[+m - 1]}${d}`;
}
const futFor = (name, monthly) => `NFO:${name}${monthly.slice(2, 4)}${MON[+monthly.slice(5, 7) - 1]}FUT`;

function planCmd(o) {
  const now = eng.ist(+o.now || Date.now()), spot = kv(o.spot), latest = o.latest && fs.existsSync(o.latest) ? readJson(o.latest) : null;
  const cached = latest && latest.cache && latest.cache.date === now.date ? latest.cache.expiries : null;
  const expFor = name => {
    const raw = o.expiries ? (o.expiries.split(';').find(x => x.startsWith(name + '=')) || '').split('=')[1] : null;
    if (raw) return raw.split(',').map(s => s.trim()).filter(Boolean);
    return cached && cached[name] ? cached[name] : null;
  };
  const plan = { date: now.date, nowMs: now.ms, indices: {}, quote1: [], quote2: [] }, need = [];
  for (const u of eng.UNDERLYINGS) {
    const all = expFor(u.name);
    if (!all) { need.push(u.name); continue; }
    const c = contracts(u, all, now), s = +spot[u.name];
    if (!(s > 0)) throw new Error(`--spot is missing ${u.name}`);
    const idx = { expiries: all, monthly: c.monthly, future: futFor(u.name, c.monthly), spotSymbol: u.spot, step: u.step, spot: s, contracts: [] };
    const byExp = new Map();
    for (const k of c.list) {
      const pf = prefixFor(u.name, k.expiry, all), w = WINDOW[k.kind];
      const prev = byExp.get(k.expiry);
      if (prev) { prev.kinds.push(k.kind); prev.window = Math.max(prev.window, w); continue; }
      byExp.set(k.expiry, { expiry: k.expiry, prefix: pf, kinds: [k.kind], window: w });
    }
    for (const g of byExp.values()) {
      g.lo = Math.ceil(s * (1 - g.window) / u.step) * u.step; g.hi = Math.floor(s * (1 + g.window) / u.step) * u.step;
      g.instruments = 2 * ((g.hi - g.lo) / u.step + 1);
      // the Nifty weeklies go in quote call 1; Nifty monthly and Bank Nifty in call 2 (each well under 500)
      g.call = u.name === 'NIFTY' && !g.kinds.includes('monthly') ? 1 : 2;
      idx.contracts.push(g);
    }
    plan.indices[u.name] = idx;
  }
  if (need.length) {
    console.log(`NEED_EXPIRIES ${need.join(' ')}: call Kite market option_chain (limit 1) for each, then rerun plan with --expiries 'NIFTY=d1,d2,...;BANKNIFTY=d1,...'`);
    process.exit(5);
  }
  const extras = [...Object.values(plan.indices).map(i => i.future), ...eng.UNDERLYINGS.map(u => u.spot), 'NSE:INDIA VIX'];
  for (const call of [1, 2]) {
    const lines = []; let n = call === 2 ? extras.length : 0;
    for (const [name, idx] of Object.entries(plan.indices)) for (const g of idx.contracts.filter(g => g.call === call)) {
      lines.push(`  ${g.prefix}<strike>CE and ${g.prefix}<strike>PE for strikes ${g.lo} to ${g.hi} step ${idx.step} (${g.instruments}) - ${name} ${g.kinds.join('+')} ${g.expiry}`);
      n += g.instruments;
    }
    if (call === 2) lines.push(`  plus ${extras.join(', ')} (${extras.length})`);
    console.log(`QUOTE CALL ${call}: mode "quote", ${n} instruments\n${lines.join('\n')}`);
    if (n > 500) throw new Error(`quote call ${call} would need ${n} instruments (limit 500)`);
  }
  fs.writeFileSync(o.out, JSON.stringify(plan));
  console.log(`plan written to ${o.out}`);
}

function quotesFrom(files) {
  const all = {};
  for (const f of files) { const j = readJson(f); Object.assign(all, j.data || j); }
  return all;
}
function rowsFor(q, prefix) {
  const legs = {};
  for (const [sym, v] of Object.entries(q)) {
    if (!sym.startsWith(prefix)) continue;
    const m = sym.slice(prefix.length).match(/^(\d+(?:\.\d+)?)(CE|PE)$/);
    if (!m) continue;
    (legs[+m[1]] = legs[+m[1]] || {})[m[2]] = { oi: Number(v.oi) || 0, ltp: Number(v.last_price) || 0 };
  }
  return Object.keys(legs).map(Number).sort((a, b) => a - b).filter(k => legs[k].CE && legs[k].PE)
    .map(k => ({ strike: k, ce_oi: legs[k].CE.oi, ce_ltp: legs[k].CE.ltp, pe_oi: legs[k].PE.oi, pe_ltp: legs[k].PE.ltp }));
}
// candles: {"NIFTY":[{"date":"YYYY-MM-DD","high":n,"low":n,"close":n},...]} - only days before today count
function hlcFrom(candles, name, today) {
  const past = ((candles && candles[name]) || []).filter(c => String(c.date).slice(0, 10) < today).sort((a, b) => a.date < b.date ? -1 : 1);
  if (!past.length) return null;
  const L = past[past.length - 1];
  return { prevHLC: L.high != null && L.low != null ? [+L.high, +L.low, +L.close] : null, close3: past.length >= 3 ? +past[past.length - 3].close : null };
}

function buildCmd(o) {
  const plan = readJson(o.plan), nowMs = +o.now || Date.now(), now = eng.ist(nowMs);
  const q = quotesFrom(String(o.quotes).split(',').filter(Boolean));
  const candles = o.candles && fs.existsSync(o.candles) ? readJson(o.candles) : null;
  const latest = o.latest && fs.existsSync(o.latest) ? readJson(o.latest) : null;
  const cachedC = latest && latest.cache && latest.cache.date === now.date ? latest.cache.candles || {} : {};
  const vix = q['NSE:INDIA VIX'] ? +q['NSE:INDIA VIX'].last_price || null : null;
  const chains = [], cacheCandles = {}, problems = [], summary = [];
  for (const [name, idx] of Object.entries(plan.indices)) {
    const spot = q[idx.spotSymbol] ? +q[idx.spotSymbol].last_price : idx.spot, fut = q[idx.future] ? +q[idx.future].last_price : null;
    if (!(fut > 0)) { problems.push(`MISSING ${idx.future} in the quote files`); continue; }
    const h = hlcFrom(candles, name, now.date) || cachedC[name] || null;
    if (h) cacheCandles[name] = h;
    for (const g of idx.contracts) {
      const rows = rowsFor(q, g.prefix);
      if (rows.length < 10) { problems.push(`MISSING ${g.prefix}: only ${rows.length} strikes came back - check the prefix with one option_chain call and re-quote that expiry`); continue; }
      for (const kind of g.kinds) chains.push({ idx: name, kind, expiry: g.expiry, futExpiry: idx.monthly, takenMs: nowMs, spot, future: fut, vix, step: idx.step,
        prevHLC: h ? h.prevHLC : null, close3: h ? h.close3 : null, rows });
      summary.push(`${name} ${g.kinds.join('+')} ${g.expiry}: ${rows.length} strikes ${rows[0].strike}-${rows[rows.length - 1].strike}, spot ${spot}, fut ${fut}`);
    }
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(4); }
  const input = { nowMs, slot: o.slot, chains,
    cache: { date: now.date, expiries: Object.fromEntries(Object.entries(plan.indices).map(([n, i]) => [n, i.expiries])), candles: cacheCandles,
      eventsVerifiedMs: latest && latest.cache ? latest.cache.eventsVerifiedMs || null : null } };
  fs.writeFileSync(o.out, JSON.stringify(input));
  console.log(summary.join('\n') + `\nVIX ${vix}\ninput written to ${o.out} (${chains.length} contracts)`);
}

// Afternoon only: skip the run when nothing has moved since this morning's lock. Never skip when an expiry is due today
// or on the next session (those last locks matter most for scoring), or when the morning lock is missing.
function quietCmd(o) {
  const nowMs = +o.now || Date.now(), now = eng.ist(nowMs), spot = kv(o.spot), vix = +o.vix || null;
  const latest = o.latest && fs.existsSync(o.latest) ? readJson(o.latest) : null;
  const run = why => { console.log(`RUN ${why}`); };
  if (!latest || !latest.runMs || eng.ist(latest.runMs).date !== now.date || latest.slot !== '09:40') return run('no 09:40 lock today');
  if (!latest.spots) return run('the morning lock did not record spots');
  const soon = Object.values(latest.overlays || {}).map(o => o.expiry).filter(Boolean).filter(e => eng.isLive(e, now) && eng.tradingDaysFrac(nowMs, e) <= 1.5);
  if (soon.length) return run(`expiry due ${[...new Set(soon)].join(', ')}: the last lock before settlement matters`);
  const today = (latest.events || []).filter(e => e.impact === 'high' && String(e.when || '').slice(0, 10) === now.date);
  if (today.length) return run(`high-impact event today (${today[0].title})`);
  const moves = [];
  for (const [name, s0] of Object.entries(latest.spots)) {
    const s1 = +spot[name]; if (!(s1 > 0 && s0 > 0)) return run(`no current spot for ${name}`);
    const m = (s1 / s0 - 1) * 100; moves.push(`${name === 'BANKNIFTY' ? 'BN' : 'Nifty'} ${m >= 0 ? '+' : ''}${m.toFixed(2)}%`);
    if (Math.abs(m) >= 0.5) return run(`${name} moved ${m.toFixed(2)}% since 09:40`);
  }
  let vm = null;
  if (vix && latest.vix) { vm = (vix / latest.vix - 1) * 100; if (Math.abs(vm) >= 10) return run(`VIX moved ${vm.toFixed(1)}% since 09:40`); }
  console.log(`QUIET ${moves.join(', ')}${vm == null ? '' : `, VIX ${vm >= 0 ? '+' : ''}${vm.toFixed(1)}%`} since 09:40`);
}

if (require.main === module) {
  const args = process.argv.slice(2), cmd = args.shift(), o = {};
  for (let i = 0; i < args.length; i += 2) o[args[i].replace(/^--/, '')] = args[i + 1];
  try {
    if (cmd === 'plan') planCmd(o); else if (cmd === 'build') buildCmd(o); else if (cmd === 'quiet') quietCmd(o);
    else { console.error('usage: prep.js plan|build ...'); process.exit(2); }
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
}
module.exports = { contracts, prefixFor, futFor, rowsFor, hlcFrom };
