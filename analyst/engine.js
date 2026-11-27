'use strict';
// Loads the prediction engine straight out of the dashboard page so the analyst and the page can never disagree.
const fs = require('node:fs');

const EXPORTS = ['UNDERLYINGS', 'PRIOR', 'PRIOR_K', 'SIGNALS', 'ist', 'closeMs', 'yearFrac', 'isLive', 'dteBucket', 'ncdf', 'b76',
  'impliedVol', 'computeSignals', 'predict', 'fmt', 'compare', 'scoreLocks', 'refit', 'trackRecord', 'percentile', 'clamp', 'applyConfig', 'mergeConfig', 'DEFAULT_CONFIG',
  'realizedVol', 'trendRegime', 'fairVol', 'fitSmile', 'impliedDist', 'gridCdf', 'gridQuantile', 'evalLegs', 'bandFinder', 'tradeVerdict', 'rangeView', 'tradeBands', 'eventBefore', 'closesFor', 'paperRecord', 'eventRisk', 'tradingDaysFrac',
  'buildupOf', 'vwapOf', 'pivots', 'openingRange', 'trendScore', 'trendTracker', 'reversalWatch', 'signalCheck', 'scoreSignal', 'tomorrowBias', 'parseOptionSymbol', 'positionRisk', 'BUILDUP', 'oiShift'];

const DEFAULT_HTML = require('node:path').join(__dirname, '..', 'artifact', 'fo_expiry_desk.html');

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
  for (const f of ['spot', 'future', 'takenMs', 'step']) if (!(Number(c[f]) > 0)) throw new Error(`chain ${f} must be a positive number`);
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

// Config handling lives in the page's engine block too, so both apply approved changes identically.
function applyConfig(ws, cfg, idx) { return loadEngine(DEFAULT_HTML).applyConfig(ws, cfg, idx); }

function toSnap(c) {
  return { expiry: c.expiry, futExpiry: c.futExpiry, takenMs: c.takenMs, spot: c.spot, future: c.future,
    options: c.rows.flatMap(r => [{ strike: r.strike, type: 'CE', ltp: r.ce_ltp, oi: r.ce_oi }, { strike: r.strike, type: 'PE', ltp: r.pe_ltp, oi: r.pe_oi }]) };
}

// Signals (max pain, walls, PCR, gamma pin) always use the ±3% strikes, exactly as the page does; the wider window is for trade bands.
const signalRows = c => c.rows.filter(r => r.strike >= c.spot * 0.97 && r.strike <= c.spot * 1.03);

function buildLock({ chain, nowMs, weights, cfg, overlay, events, prevLock, slot, htmlPath }) {
  const eng = loadEngine(htmlPath || DEFAULT_HTML);
  cfg = eng.mergeConfig(cfg);
  validateChain(chain);
  const now = eng.ist(nowMs);
  const sig = eng.computeSignals(toSnap({ ...chain, rows: signalRows(chain) }), chain.oiPrev || null, chain.prevHLC || null, chain.close3 || null);
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
    cur, (eng.UNDERLYINGS.find(u => u.name === chain.idx) || { thr: 0.003 }).thr);
  const key = `${chain.idx}-${chain.kind}`;
  return {
    id: `${key}-${chain.expiry}-${now.date}-${(slot || now.hm).replace(':', '')}`,
    key, idx: chain.idx, underlying: chain.idx, kind: chain.kind, expiry: chain.expiry, date: now.date, slot: slot || now.hm, madeAt: nowMs,
    centre, band68: band(ws.k68), band90: band(ws.k90), modelCentre: p.centre, modelBand68: p.band68, modelBand90: p.band90,
    sigma, kEff: ws.k68, forward: sig.forward, future: chain.future, spot: chain.spot, vix: chain.vix ?? null, step: chain.step,
    centres: sig.centres, supports: sig.supports, resistances: sig.resistances, maxPain: sig.maxPain, gammaPin: sig.gammaPin,
    pcrAtm: sig.pcrAtm, atmIv: sig.atmIv, quality: sig.quality, bucket, version: ws.version, weights: p.weights,
    overlay: { bandMult, nudgeSigma, reasons: Array.isArray(ov.reasons) ? ov.reasons.slice(0, 6) : [] },
    eventsHigh: (events || []).some(e => e.impact === 'high'), events: (events || []).map(e => e.title).slice(0, 8),
    changed, reason,
  };
}

// One paper trade per contract per morning: the trade-band verdict and the best condor and strangle, priced at the lock's quotes.
function buildTrade({ chain, lock, history, events, cfg, paper, htmlPath }) {
  const eng = loadEngine(htmlPath || DEFAULT_HTML), now = eng.ist(chain.takenMs);
  const highEvent = eng.eventRisk(events, chain.expiry);
  const closes = eng.closesFor(history, chain.idx, now.date);
  const tb = eng.tradeBands({ rows: chain.rows, F: lock.forward, T: eng.yearFrac(chain.takenMs, chain.expiry), tdays: eng.tradingDaysFrac(chain.takenMs, chain.expiry),
    closes, highEvent, idx: chain.idx, cfg, paper });
  const base = { id: `${lock.key}-${chain.expiry}-${now.date}`, key: lock.key, idx: chain.idx, kind: chain.kind, expiry: chain.expiry, date: now.date,
    madeAt: chain.takenMs, lockId: lock.id, spot: chain.spot, forward: lock.forward };
  if (tb.error) return { ...base, error: tb.error, today: { verdict: 'NO TRADE', reason: tb.error } };
  const slim = b => b && { p: b.p, legs: b.legs, credit: b.credit, ev: b.ev, pop: b.pop, maxLoss: b.maxLoss, breakevens: b.breakevens, loss2: b.loss2, loss3: b.loss3, score: b.score, inside: b.inside };
  return { ...base, sd: tb.sd, stressSd: tb.stressSd, tdays: tb.tdays, atmIv: tb.smile.atm, smileFlat: tb.smile.flat, fair: tb.fair, regime: tb.regime.regime, highEvent, historyUsed: !!closes,
    lot: tb.lot, costPts: tb.costPts, condor: slim(tb.condor.best), strangle: slim(tb.strangle.best), verdicts: tb.verdicts, today: tb.today, range: tb.range };
}

module.exports = { loadEngine, validateChain, applyConfig, buildLock, buildTrade, signalRows, toSnap, get DEFAULT_CONFIG() { return JSON.parse(JSON.stringify(loadEngine(DEFAULT_HTML).DEFAULT_CONFIG)); } };
