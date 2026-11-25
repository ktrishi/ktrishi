'use strict';
// Loads the prediction engine straight out of the dashboard page so the analyst and the page can never disagree.
const fs = require('node:fs');

const EXPORTS = ['UNDERLYINGS', 'PRIOR', 'PRIOR_K', 'SIGNALS', 'ist', 'closeMs', 'yearFrac', 'isLive', 'dteBucket', 'ncdf', 'b76',
  'impliedVol', 'computeSignals', 'predict', 'fmt', 'compare', 'scoreLocks', 'refit', 'trackRecord', 'percentile', 'clamp'];

const DEFAULT_CONFIG = Object.freeze({
  kScale: { NIFTY: 1, BANKNIFTY: 1 }, eventBandMax: 1.3, nudgeCapSigma: 0.25,
  dropped: { NIFTY: [], BANKNIFTY: [] }, forwardFloor: { NIFTY: 0, BANKNIFTY: 0 },
});

let cached = null;
function loadEngine(htmlPath) {
  if (cached && cached.path === htmlPath) return cached.eng;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/\/\*ENGINE-START\*\/([\s\S]*?)\/\*ENGINE-END\*\//);
  if (!m) throw new Error(`engine block not found in ${htmlPath}`);
  const eng = new Function(`${m[1]}\nreturn { ${EXPORTS.join(', ')} };`)();
  cached = { path: htmlPath, eng };
  return eng;
}

function validateChain(c) {
  if (!c || !Array.isArray(c.rows) || !c.rows.length) throw new Error('chain has no strike rows');
  for (const f of ['idx', 'kind', 'expiry', 'futExpiry']) if (!c[f]) throw new Error(`chain is missing ${f}`);
  for (const f of ['spot', 'future', 'takenMs']) if (!(Number(c[f]) > 0)) throw new Error(`chain ${f} must be a positive number`);
  const seen = new Set();
  for (const r of c.rows) {
    if (seen.has(r.strike)) throw new Error(`duplicate strike ${r.strike}`);
    seen.add(r.strike);
    for (const f of ['ce_oi', 'pe_oi']) if (!(Number(r[f]) >= 0)) throw new Error(`negative OI at strike ${r.strike} (${f})`);
    for (const f of ['ce_ltp', 'pe_ltp']) if (!(Number(r[f]) >= 0)) throw new Error(`bad price at strike ${r.strike} (${f})`);
  }
  const ks = [...seen].sort((a, b) => a - b);
  if (c.spot < ks[0] || c.spot > ks[ks.length - 1]) throw new Error(`spot ${c.spot} is outside the strike window ${ks[0]}–${ks[ks.length - 1]}`);
  if (Math.abs(c.future / c.spot - 1) > 0.03) throw new Error(`future ${c.future} is more than 3% from spot ${c.spot}`);
}

function applyConfig(ws, cfg, idx) {
  cfg = cfg || DEFAULT_CONFIG;
  const drop = new Set((cfg.dropped && cfg.dropped[idx]) || []);
  let w = Object.fromEntries(Object.entries(ws.weights).filter(([k, v]) => !drop.has(k) && v > 0));
  let tot = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  w = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / tot]));
  const floor = (cfg.forwardFloor && cfg.forwardFloor[idx]) || 0;
  if (floor > 0 && (w.forward || 0) < floor) {
    const rest = 1 - (w.forward || 0);
    w = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, k === 'forward' ? floor : rest > 0 ? v * (1 - floor) / rest : 0]));
    if (!('forward' in w)) w.forward = floor;
  }
  const s = (cfg.kScale && cfg.kScale[idx]) || 1;
  return { ...ws, weights: w, k68: ws.k68 * s, k90: ws.k90 * s };
}

function toSnap(c) {
  return { expiry: c.expiry, futExpiry: c.futExpiry, takenMs: c.takenMs, spot: c.spot, future: c.future,
    options: c.rows.flatMap(r => [{ strike: r.strike, type: 'CE', ltp: r.ce_ltp, oi: r.ce_oi }, { strike: r.strike, type: 'PE', ltp: r.pe_ltp, oi: r.pe_oi }]) };
}

function buildLock({ chain, nowMs, weights, cfg, overlay, events, prevLock, slot, htmlPath }) {
  const eng = loadEngine(htmlPath || require('node:path').join(__dirname, '..', 'artifact', 'fo_expiry_desk.html'));
  cfg = cfg || DEFAULT_CONFIG;
  validateChain(chain);
  const now = eng.ist(nowMs);
  const sig = eng.computeSignals(toSnap(chain), chain.oiPrev || null, chain.prevHLC || null, chain.close3 || null);
  const bucket = eng.dteBucket(now.date, chain.expiry);
  const base = weights || { weights: eng.PRIOR[bucket], ...eng.PRIOR_K, version: 'uncalibrated', source: 'prior' };
  const ws = applyConfig(base, cfg, chain.idx);
  const p = eng.predict(sig, ws, bucket);
  const ov = overlay || {};
  const bandMult = eng.clamp(Number(ov.bandMult) || 1, 1, cfg.eventBandMax);
  const nudgeSigma = eng.clamp(Number(ov.nudgeSigma) || 0, -cfg.nudgeCapSigma, cfg.nudgeCapSigma);
  const sigma = sig.sigma;
  const centre = sigma ? p.centre + nudgeSigma * sigma : p.centre;
  const band = k => sigma ? [centre - k * sigma * bandMult, centre + k * sigma * bandMult] : null;
  const cur = { centre, supports: sig.supports, resistances: sig.resistances, pcrAtm: sig.pcrAtm };
  const [changed, reason] = eng.compare(prevLock ? { centre: prevLock.centre, supports: prevLock.supports, resistances: prevLock.resistances, pcrAtm: prevLock.pcrAtm } : null,
    cur, chain.idx === 'BANKNIFTY' ? 0.004 : 0.003);
  const key = `${chain.idx}-${chain.kind}`;
  return {
    id: `${key}-${chain.expiry}-${now.date}-${(slot || now.hm).replace(':', '')}`,
    key, idx: chain.idx, underlying: chain.idx, kind: chain.kind, expiry: chain.expiry, date: now.date, slot: slot || now.hm, madeAt: nowMs,
    centre, band68: band(ws.k68), band90: band(ws.k90), modelCentre: p.centre, modelBand68: p.band68, modelBand90: p.band90,
    sigma, forward: sig.forward, future: chain.future, spot: chain.spot, vix: chain.vix ?? null, step: chain.step,
    centres: sig.centres, supports: sig.supports, resistances: sig.resistances, maxPain: sig.maxPain, gammaPin: sig.gammaPin,
    pcrAtm: sig.pcrAtm, atmIv: sig.atmIv, quality: sig.quality, bucket, version: ws.version, weights: p.weights,
    overlay: { bandMult, nudgeSigma, reasons: Array.isArray(ov.reasons) ? ov.reasons.slice(0, 6) : [] },
    eventsHigh: (events || []).some(e => e.impact === 'high'), events: (events || []).map(e => e.title).slice(0, 8),
    changed, reason,
  };
}

module.exports = { loadEngine, validateChain, applyConfig, buildLock, toSnap, DEFAULT_CONFIG };
