#!/usr/bin/env node
'use strict';
// Build chain rows from saved Kite `market` quote results, so numbers never pass through hand transcription.
//   node analyst/chain_from_quotes.js --prefix NFO:NIFTY26D01 --out rows.json quotes1.json [quotes2.json ...]
// Each input is a Kite quote result ({data:{SYMBOL:{last_price, oi, ...}}}); options matching <prefix><strike>CE|PE become
// [{strike, ce_oi, ce_ltp, pe_oi, pe_ltp}] for strikes that have both legs.
const fs = require('node:fs');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const prefix = opt('prefix'), out = opt('out');
if (!prefix || !out || !args.length) { console.error('usage: chain_from_quotes.js --prefix NFO:NIFTY26D01 --out rows.json quotes.json...'); process.exit(2); }
const legs = {};
for (const f of args) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const data = j.data || j;
  for (const [sym, q] of Object.entries(data)) {
    if (!sym.startsWith(prefix)) continue;
    const m = sym.slice(prefix.length).match(/^(\d+(?:\.\d+)?)(CE|PE)$/);
    if (!m) continue;
    const k = Number(m[1]);
    legs[k] = legs[k] || {};
    legs[k][m[2]] = { oi: Number(q.oi) || 0, ltp: Number(q.last_price) || 0 };
  }
}
const rows = Object.keys(legs).map(Number).sort((a, b) => a - b).filter(k => legs[k].CE && legs[k].PE)
  .map(k => ({ strike: k, ce_oi: legs[k].CE.oi, ce_ltp: legs[k].CE.ltp, pe_oi: legs[k].PE.oi, pe_ltp: legs[k].PE.ltp }));
fs.writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} strikes written to ${out} (${Object.keys(legs).length - rows.length} skipped for a missing leg)`);
