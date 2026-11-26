'use strict';
// Settlement, post-mortems and change proposals. Pure functions; the CLI turns them into database writes.

const { loadEngine } = require('./engine');
const ENG = () => loadEngine(require('node:path').join(__dirname, '..', 'artifact', 'fo_expiry_desk.html'));
const stepOf = l => l.step || ((ENG().UNDERLYINGS.find(u => u.name === l.idx) || {}).step) || 50;
const fmt = x => x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString('en-IN');
const pct = (p, s) => (p - s) / s * 100;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function percentile(xs, q) { xs = [...xs].sort((a, b) => a - b); if (!xs.length) return null; const p = q * (xs.length - 1), lo = Math.floor(p), hi = Math.min(lo + 1, xs.length - 1); return xs[lo] + (xs[hi] - xs[lo]) * (p - lo); }
const inside = (b, x) => b ? x >= b[0] && x <= b[1] : null;

const LESSON = {
  in_range: 'The range held. No change needed from this expiry.',
  event_shock: 'A scheduled event moved the market beyond the range. Event weeks may need wider ranges.',
  trend_breakout: 'The market broke through the strongest open-interest wall. Writers rolled instead of defending; pinning signals deserve less weight in trending weeks.',
  vol_surprise: 'The index moved more than implied volatility allowed. Ranges may be too tight when VIX is low.',
  vol_overpriced: 'The index barely moved, but the centre was off. The futures price would have done better here.',
  other_miss: 'A miss without a clear pattern. Watch for a repeat before changing anything.',
  no_range: 'No implied volatility was available, so no range could be judged.',
};

function classifyMiss(lock, settle) {
  const step = stepOf(lock);
  const pinHeld = (lock.maxPain != null && Math.abs(settle - lock.maxPain) <= step) || (lock.gammaPin != null && Math.abs(settle - lock.gammaPin) <= step);
  if (!lock.sigma || !lock.band68) return { type: 'no_range', pinHeld, z: null };
  const z = Math.abs(settle - lock.centre) / lock.sigma;
  const kEff = (lock.band68[1] - lock.band68[0]) / 2 / lock.sigma;
  if (inside(lock.band68, settle)) return { type: 'in_range', pinHeld, z };
  if (lock.eventsHigh && z > kEff) return { type: 'event_shock', pinHeld, z };
  const beyond = (lock.resistances && lock.resistances.length && settle > lock.resistances[0]) || (lock.supports && lock.supports.length && settle < lock.supports[0]);
  if (beyond && z > 1) return { type: 'trend_breakout', pinHeld, z };
  const move = Math.abs(settle - lock.spot) / lock.sigma;
  if (move > 1.5) return { type: 'vol_surprise', pinHeld, z };
  if (move < 0.3) return { type: 'vol_overpriced', pinHeld, z };
  return { type: 'other_miss', pinHeld, z };
}

function scoreLock(lock, settle) {
  const miss = classifyMiss(lock, settle);
  const modelCentre = lock.modelCentre ?? lock.centre;
  return {
    id: lock.id, idx: lock.idx, kind: lock.kind, expiry: lock.expiry, bucket: lock.bucket, madeAt: lock.madeAt, slot: lock.slot, date: lock.date,
    centre: lock.centre, modelCentre, future: lock.future, sigma: lock.sigma, settlement: settle,
    errPct: pct(lock.centre, settle), modelErrPct: pct(modelCentre, settle), futErrPct: pct(lock.forward ?? lock.future, settle),
    kEff: lock.kEff ?? (lock.modelBand68 && lock.sigma ? (lock.modelBand68[1] - lock.modelBand68[0]) / 2 / lock.sigma : null),
    in68: inside(lock.band68, settle), in90: inside(lock.band90, settle),
    zModel: lock.sigma ? Math.abs(settle - modelCentre) / lock.sigma : null,
    signalErrs: Object.fromEntries(Object.entries(lock.centres || {}).map(([k, c]) => [k, pct(c, settle)])),
    eventsHigh: !!lock.eventsHigh, miss: miss.type, pinHeld: miss.pinHeld,
  };
}

const NAMES = { forward: 'futures-implied', max_pain: 'max pain', wall_centre: 'OI walls', gamma_pin: 'gamma pin', pcr: 'PCR tilt', momentum: 'momentum', pivot: 'pivot' };

function postmortem(idx, expiry, locks, settle) {
  const last = [...locks].sort((a, b) => a.madeAt - b.madeAt).pop();
  const s = scoreLock(last, settle);
  const closest = Object.entries(s.signalErrs).sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0];
  const overlayEffect = Math.abs(s.errPct) < Math.abs(s.modelErrPct) - 1e-9 ? 'helped' : Math.abs(s.errPct) > Math.abs(s.modelErrPct) + 1e-9 ? 'hurt' : 'made no difference';
  const range = last.band68 ? `68% range ${fmt(last.band68[0])}–${fmt(last.band68[1])}` : 'no range';
  const parts = [
    `Settled ${fmt(settle)}.`,
    `Last locked call (${last.date} ${last.slot}): ${fmt(last.centre)}, ${range}; error ${s.errPct.toFixed(2)}%, ${s.in68 ? 'inside' : 'outside'} the range.`,
    `Futures-implied level at that time: ${fmt(last.forward ?? s.future)} (error ${s.futErrPct.toFixed(2)}%). The analyst overlay ${overlayEffect}.`,
    closest ? `Closest signal: ${NAMES[closest[0]] || closest[0]} (${closest[1].toFixed(2)}%).` : '',
    s.pinHeld ? `The pin held: the settlement was within one strike of max pain or the gamma pin.` : '',
  ].filter(Boolean);
  return { id: `${idx}-${expiry}`, idx, expiry, settlement: settle, lastSlot: last.slot, lastDate: last.date, centre: last.centre,
    errPct: s.errPct, modelErrPct: s.modelErrPct, futErrPct: s.futErrPct, in68: s.in68, miss: s.miss, pinHeld: s.pinHeld,
    closestSignal: closest ? closest[0] : null, overlayEffect, narrative: parts.join(' '), lesson: LESSON[s.miss], locks: locks.length };
}

function settleDue(locks, outcomes, candles, now) {
  const live = e => e > now.date || (e === now.date && now.hm < '15:30');
  const due = new Map();
  for (const l of locks) {
    const k = `${l.idx}-${l.expiry}`;
    if (live(l.expiry) || outcomes[k] || due.has(k)) continue;
    const c = (candles[l.idx] || []).find(x => x.date === l.expiry);
    if (c) due.set(k, { idx: l.idx, expiry: l.expiry, settlement: c.close });
  }
  return [...due.values()];
}

const round05 = x => Math.round(x * 20) / 20;
function proposals(idx, scores, cfg, existing, nowMs = Date.now()) {
  const recentReject = p => p.status === 'rejected' && nowMs - (p.decidedMs || p.createdMs || 0) < 30 * 864e5;
  const pendingRules = new Set((existing || []).filter(p => p.idx === idx && (p.status === 'pending' || recentReject(p))).map(p => p.rule));
  const lastPerExpiry = new Map();
  for (const s of [...scores].filter(s => s.idx === idx).sort((a, b) => a.madeAt - b.madeAt)) lastPerExpiry.set(s.expiry, s);
  const rows = [...lastPerExpiry.values()].sort((a, b) => a.expiry.localeCompare(b.expiry)).slice(-8);
  if (rows.length < 6) return [];
  const out = [], date = new Date(nowMs).toISOString().slice(0, 10);
  const add = (rule, title, evidence, change) => { if (!pendingRules.has(rule)) out.push({ id: `${idx}-${rule}-${date}`, idx, rule, title, evidence, change, status: 'pending', createdMs: nowMs }); };
  const since = (cfg.changedMs && cfg.changedMs['kScale:' + idx]) || 0;
  const ranged = rows.filter(r => r.in68 != null && (r.madeAt || 0) > since);
  const cov = ranged.length ? ranged.filter(r => r.in68).length / ranged.length : null;
  const zs = ranged.map(r => r.zModel).filter(z => z != null);
  const curK = (cfg.kScale && cfg.kScale[idx]) || 1;
  const kE = ranged.map(r => r.kEff).filter(k => k > 0), kNow = kE.length ? percentile(kE, 0.5) : curK;
  const target = zs.length ? curK * percentile(zs, 0.68) / kNow : curK;
  if (cov != null && ranged.length >= 6 && cov < 0.5 && zs.length) {
    const v = Math.min(2.5, round05(Math.max(curK + 0.05, target)));
    add('widen_range', `Widen ${idx} ranges`, `The 68% range held in only ${ranged.filter(r => r.in68).length} of the last ${ranged.length} expiries.`, { field: 'kScale', idx, value: v });
  }
  if (cov != null && ranged.length >= 6 && cov > 0.85 && zs.length) {
    const v = Math.max(0.6, round05(Math.min(curK - 0.05, target)));
    add('narrow_range', `Narrow ${idx} ranges`, `The 68% range held in ${ranged.filter(r => r.in68).length} of the last ${ranged.length} expiries, more often than it should.`, { field: 'kScale', idx, value: v });
  }
  const mFinal = mean(rows.map(r => Math.abs(r.errPct))), mModel = mean(rows.map(r => Math.abs(r.modelErrPct))), mFut = mean(rows.map(r => Math.abs(r.futErrPct)));
  if (cfg.nudgeCapSigma > 0 && mFinal > mModel * 1.1)
    add('stop_nudging', 'Stop the analyst moving the centre', `With the analyst's nudge the mean error was ${mFinal.toFixed(2)}%, against ${mModel.toFixed(2)}% for the plain model.`, { field: 'nudgeCapSigma', value: 0 });
  const ev = rows.filter(r => r.eventsHigh), quiet = rows.filter(r => !r.eventsHigh);
  if (ev.length >= 2 && quiet.length >= 2) {
    const e = mean(ev.map(r => Math.abs(r.errPct))), q = mean(quiet.map(r => Math.abs(r.errPct)));
    if (e > 1.5 * q && cfg.eventBandMax < 1.8)
      add('wider_event_ranges', 'Allow wider ranges in event weeks', `Event-week error ${e.toFixed(2)}% versus ${q.toFixed(2)}% in quiet weeks.`, { field: 'eventBandMax', value: Math.round((cfg.eventBandMax + 0.1) * 10) / 10 });
  }
  if (rows.length >= 8 && mModel > mFut && ((cfg.forwardFloor && cfg.forwardFloor[idx]) || 0) < 0.6)
    add('lean_on_futures', `Lean on the futures price for ${idx}`, `Over ${rows.length} expiries the model's mean error was ${mModel.toFixed(2)}%, the plain futures price's ${mFut.toFixed(2)}%.`, { field: 'forwardFloor', idx, value: 0.6 });
  const worst = {};
  for (const r of rows) { const w = Object.entries(r.signalErrs || {}).filter(([k]) => k !== 'forward').sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]; if (w) worst[w[0]] = (worst[w[0]] || 0) + 1; }
  for (const [sig, n] of Object.entries(worst)) if (n >= 6 && !((cfg.dropped && cfg.dropped[idx]) || []).includes(sig))
    add('drop_' + sig, `Drop ${NAMES[sig] || sig} for ${idx}`, `${NAMES[sig] || sig} was the worst signal in ${n} of the last ${rows.length} expiries.`, { field: 'dropped', idx, add: sig });
  return out;
}

function applyApproved(cfg, approved, nowMs = Date.now()) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.changedMs = c.changedMs || {};
  const appliedIds = [];
  for (const p of approved) {
    if (p.status !== 'approved' || !p.change) continue;
    const ch = p.change;
    if (ch.field === 'kScale' || ch.field === 'forwardFloor') { c[ch.field] = c[ch.field] || {}; c[ch.field][ch.idx] = ch.value; c.changedMs[ch.field + ':' + ch.idx] = nowMs; }
    else if (ch.field === 'dropped') { c.dropped = c.dropped || {}; c.dropped[ch.idx] = [...new Set([...(c.dropped[ch.idx] || []), ch.add])]; }
    else if (ch.field === 'nudgeCapSigma' || ch.field === 'eventBandMax') c[ch.field] = ch.value;
    else continue;
    appliedIds.push(p.id);
  }
  return { cfg: c, appliedIds };
}

// Paper-trade P&L at the settlement, net of the same costs the verdict assumed. taken = the verdict did not say NO TRADE.
function settleTrade(t, settle) {
  const intr = (l, S) => l.type === 'CE' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
  const one = s => {
    const b = t[s]; if (!b) return null;
    const pts = b.legs.reduce((a, l) => a + l.side * (intr(l, settle) - l.price), 0) - (t.costPts || 0) * b.legs.length;
    return { pts, rupees: pts * (t.lot || 1), win: pts > 0, taken: !!(t.verdicts && t.verdicts[s] && t.verdicts[s].verdict !== 'NO TRADE'), ev: b.ev, credit: b.credit };
  };
  return { id: t.id, idx: t.idx, kind: t.kind, key: t.key, expiry: t.expiry, date: t.date, settlement: settle, verdict: t.today && t.today.verdict,
    condor: one('condor'), strangle: one('strangle') };
}
// Same count the page uses: shared from the engine block.
const paperCounts = (scores, idx) => ENG().paperCounts(scores, idx);

module.exports = { classifyMiss, scoreLock, postmortem, settleDue, proposals, applyApproved, settleTrade, paperCounts, LESSON };
