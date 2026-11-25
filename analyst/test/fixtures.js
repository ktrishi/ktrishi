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
module.exports = { HTML, sampleChain };
