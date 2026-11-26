'use strict';
// Shared sample: 5-strike NIFTY chain, expiry 23-Nov-2026, taken 19-Nov 13:00 IST, F=25200, IV 14%.
const path = require('node:path');
const HTML = path.join(__dirname, '..', '..', 'artifact', 'fo_expiry_desk.html');
function sampleChain(eng) {
  const takenMs = Date.UTC(2026, 10, 19, 7, 30);
  const T = eng.yearFrac(takenMs, '2026-11-23');
  const ce = [100, 200, 300, 800, 500], pe = [600, 700, 400, 200, 100], rows = [];
  [25000, 25100, 25200, 25300, 25400].forEach((k, i) => {
    const c = Math.round(eng.b76(25200, k, T, 0.14, 'CE') / 0.05) * 0.05, p = Math.round(eng.b76(25200, k, T, 0.14, 'PE') / 0.05) * 0.05;
    rows.push({ strike: k, ce_oi: ce[i], ce_ltp: c, pe_oi: pe[i], pe_ltp: p });
  });
  return { idx: 'NIFTY', kind: 'monthly', expiry: '2026-11-23', futExpiry: '2026-11-23', takenMs, spot: 25180, future: 25200, vix: 16.2, step: 100, rows };
}
// Wide window (±7%) priced off a flat 14% smile, with big OI far out that must NOT move the ±3% signals.
function wideChain(eng) {
  const base = sampleChain(eng), T = eng.yearFrac(base.takenMs, base.expiry), rows = [];
  for (let k = 23450; k <= 26950; k += 50) {
    const inner = base.rows.find(r => r.strike === k);
    const px = t => Math.round(eng.b76(25200, k, T, 0.14, t) / 0.05) * 0.05;
    rows.push(inner || { strike: k, ce_oi: k > 26000 ? 90000 : 50, ce_ltp: px('CE'), pe_oi: k < 24400 ? 90000 : 50, pe_ltp: px('PE') });
  }
  return { ...base, step: 50, rows };
}
const history = (asOf, n = 260) => ({ asOf, closes: Array.from({ length: n }, (_, i) => 25200 * Math.exp(i % 2 ? 0.004 : 0)) });
module.exports = { HTML, sampleChain, wideChain, history };
