/* tw5_consolidated.js — consolidation layer for the Tiwari Family Wealth dashboard (V4 base).
 * Adds four tabs to tw4_app.js: Update & Audit, Behavioural, History, Export; plus a status bar
 * that runs the audit and a live NSE price check the moment the page opens.
 * Prepended to tw4_app.js by patch_tw4_app.py. Reads window.MODEL, window.TW4 and window.TWAPP
 * (helpers exposed by the patched app). Never mutates MODEL: live prices are an overlay only,
 * so the headline still reconciles to the audited build to the rupee.
 */
(function () {
  'use strict';
  const NSE = 'cm-market', CCR = 'Claude Code Remote';
  const IDX = { NIFTY: 'NIFTY 50', BANKNIFTY: 'NIFTY BANK', FINNIFTY: 'NIFTY FIN SERVICE', MIDCPNIFTY: 'NIFTY MID SELECT' };
  const PLAN_RATE = 0.11, PLAN_BASE = '2026-10-12';
  const T = { openedAt: new Date(), mcp: null, perm: 'unknown', dl: null,
    live: { state: 'idle', q: {}, idx: {}, err: {}, at: null, n: 0, done: 0, code: null } };

  const A = () => window.TWAPP, H = () => window.TWAPP.h, M = () => window.MODEL, E = () => window.TW4;
  const R = () => window.TWAPP.R;
  const base = s => String(s || '').replace(/-(SM|BE|ST|BZ)$/i, '').toUpperCase();
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const hhmm = d => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  const istStamp = iso => { try { const d = new Date(iso); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-') + ' ' + hhmm(d) + ' IST'; } catch (e) { return iso; } };
  const isWk = d => { const w = d.getUTCDay(); return w === 0 || w === 6; };
  const bdBetween = (a, b) => { const d0 = new Date(a + 'T00:00:00Z'), d1 = new Date(b + 'T00:00:00Z'); let n = 0; for (let d = new Date(d0); d < d1; d.setUTCDate(d.getUTCDate() + 1)) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + 1); if (!isWk(x)) n++; } return n; };
  const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // ---------- styles (scoped x5-, built on the page's own tokens)
  const CSS = `
.x5bar{background:var(--surface);border-bottom:1px solid var(--line)}
.x5bar .wrap{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding-block:8px;font-size:12.5px;color:var(--muted)}
.x5bar b{color:var(--ink);font-weight:600}.x5bar .sep{width:1px;height:14px;background:var(--line)}
.x5bar button{border:1px solid var(--line);background:var(--surface2);color:var(--ink);border-radius:999px;padding:3px 10px;font-size:12px}
.x5bar .dotx{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle;background:var(--muted)}
.x5bar .dotx.g{background:var(--good)}.x5bar .dotx.w{background:var(--warn)}.x5bar .dotx.b{background:var(--bad)}
.x5-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.x5-step{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--surface);display:grid;gap:4px;min-width:0}
.x5-step .k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.x5-step .v{font:600 18px/1.2 var(--serif)}
.x5-step .s{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
@media (max-width:900px){.x5-steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:520px){.x5-steps{grid-template-columns:minmax(0,1fr)}}
.x5-exp{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.x5-exp .card{display:grid;gap:8px;align-content:start}
.x5-exp .card .btns{display:flex;gap:6px;flex-wrap:wrap}
.x5-bias{display:grid;gap:12px}
.x5-ev{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:12.5px;background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0;overflow-wrap:anywhere}
.x5-tag{font-size:11px;color:var(--muted)}
/* Classic view: the look of the earlier V2 page (light, blue button tabs, KPI strip). Wins over both dark blocks. */
:root:root[data-skin="classic"]{--bg:#f6f7f9;--surface:#fff;--surface2:#f4f6fb;--ink:#1a2233;--muted:#6b7280;--line:#e5e8ee;--band:#f6f7f9;--band-ink:#1a2233;--band-muted:#5b6472;--accent:#0f4bd8;--accent-soft:#eef3ff;--focus:#0f4bd8;--good:#0b8a4b;--good-soft:#dcf5e6;--bad:#cc3344;--bad-soft:#fde3e3;--warn:#b45309;--warn-soft:#fef3d7;--info:#0f4bd8;--info-soft:#e8efff;--crit:#cc3344;--crit-soft:#fde3e3;--c1:#0e9f6e;--c2:#7c5cff;--c3:#e05252;--c4:#1a4fa0;--c5:#d99a00;--c6:#8a93a3;--c7:#b4539a;--shadow:none;--hero:#fff;--hero-2:#fff;--hero-ink:#1a2233;--hero-muted:#6b7280;--hero-line:#0f4bd8;--hero-fill:rgba(15,75,216,.08);--hero-rule:#e5e8ee;--hero-pos:#0b8a4b;--hero-neg:#cc3344;--serif:-apple-system,'Segoe UI',Roboto,sans-serif;--sans:-apple-system,'Segoe UI',Roboto,sans-serif;color-scheme:light}
[data-skin="classic"] .mast{border-bottom:2px solid var(--line)}
[data-skin="classic"] .brand h1{font:700 20px/1.2 var(--sans)}
[data-skin="classic"] .chip{border:1px solid #d7dbe3;background:#fff;color:#1a2233;border-radius:8px;padding:7px 14px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
[data-skin="classic"] .chip[aria-pressed="true"]{background:#fbfcff;border-color:#0f4bd8;box-shadow:inset 0 0 0 1px #0f4bd8;color:#1a2233}
[data-skin="classic"] #upd-go{background:#fff;color:#0f4bd8;border-color:#0f4bd8}
[data-skin="classic"] .icon-btn{border:1px solid #d7dbe3;background:#fff;color:#374151}
[data-skin="classic"] .icon-btn[aria-pressed="true"]{background:#1a2233;color:#fff}
[data-skin="classic"] #theme{display:none}
[data-skin="classic"] .tabs{gap:8px;padding-block:8px 10px;border-top:1px solid #eceef2}
[data-skin="classic"] .tab{border:1px solid #d7dbe3;border-radius:8px;background:#fff;color:#3a4354;padding:8px 14px;font:600 13px/1 var(--sans);box-shadow:0 1px 2px rgba(16,24,40,.05)}
[data-skin="classic"] .tab:hover{border-color:#0f4bd8;color:#3a4354}
[data-skin="classic"] .tab[aria-selected="true"]{background:#0f4bd8;color:#fff;border-color:#0f4bd8}
[data-skin="classic"] .tab .n{background:#e05252;color:#fff}
[data-skin="classic"] .card{border-radius:10px;box-shadow:none}
[data-skin="classic"] .kpi .l{font-size:11px;letter-spacing:.5px}
[data-skin="classic"] .kpi .v{font:650 20px/1.2 var(--sans)}
[data-skin="classic"] .hero{border:1px solid var(--line);box-shadow:none}
[data-skin="classic"] .hero-num{font-weight:700;font-size:clamp(32px,4.6vw,46px)}
[data-skin="classic"] th{background:#f0f2f6;color:#5b6472;letter-spacing:.4px}
[data-skin="classic"] .sec-h h2{font:700 16px/1.3 var(--sans)}
.x5-badge{display:inline-block;color:#fff;font-size:11px;font-weight:600;padding:2px 9px;border-radius:9px;white-space:nowrap}
.x5h-h{margin:22px 0 10px;font:600 15px/1.3 var(--sans)}
.x5h-k{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:10px}
.x5h-k .k{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:0}
.x5h-k .kl{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.x5h-k .kv{font-size:20px;font-weight:650;margin-top:2px}
.x5h-k .kv.pos{color:var(--good)}.x5h-k .kv.neg{color:var(--bad)}.x5h-k .kv.warn{color:var(--warn)}
.x5h-k .ks{font-size:11px;color:var(--muted);margin-top:2px}
@media (max-width:900px){.x5h-k{grid-template-columns:repeat(2,minmax(0,1fr))}}
.x5-more{margin-top:24px}.x5-more>summary{cursor:pointer;font-weight:600;padding:8px 0}
.x5kp{display:none}
[data-skin="classic"] .x5kp{display:block;background:var(--bg)}
.x5kp .wrap{padding-block:12px 4px}
.x5kp .row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@media (max-width:900px){.x5kp .row{grid-template-columns:repeat(2,minmax(0,1fr))}}
.x5kp .k{background:#fff;border:1px solid #e5e8ee;border-radius:10px;padding:12px 16px;min-width:0}
.x5kp .kl{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280}
.x5kp .kv{font-size:20px;font-weight:650;margin-top:2px;color:#1a2233}
.x5kp .kv.neg{color:#cc3344}.x5kp .kv.pos{color:#0b8a4b}
.x5kp .ks{font-size:11px;color:#6b7280;margin-top:2px}
.x5kp .tie{font-size:12px;color:#6b7280;margin:10px 0 0;overflow-wrap:anywhere}
`;
  const SKIN_KEY = 'tw5.skin';
  const getSkin = () => { try { return localStorage.getItem(SKIN_KEY) || 'classic'; } catch (e) { return 'classic'; } };
  const setSkin = v => { document.documentElement.setAttribute('data-skin', v); try { localStorage.setItem(SKIN_KEY, v); } catch (e) { } };
  document.documentElement.setAttribute('data-skin', getSkin());
  // V2-style headline strip; same definitions as both "How the figures tie" lines
  function kpiStrip() {
    const m = M(), h = H(), t = m.totals, sumC = c => m.holdings.filter(x => x.cls === c).reduce((a, x) => a + x.value, 0);
    const cash = sumC('Cash & Receivables'), fd = sumC('Fixed Deposit'), re = sumC('Real Estate'), exP = t.netTracked + cash + fd, gnw = exP + re;
    const mtfM = Object.keys(m.mtfByMember || {}).filter(k => (m.mtfByMember[k] || 0) > 0).map(k => h.mname(k));
    const k = (l, v, sub, cls) => '<div class="k"><div class="kl">' + l + '</div><div class="kv ' + (cls || '') + '">' + v + '</div>' + (sub ? '<div class="ks">' + sub + '</div>' : '') + '</div>';
    const full = v => h.money(v, 1);
    return '<div class="wrap"><div class="row">' + k('Gross Assets', h.money(t.grossTracked)) + k('Manual Entry Assets', h.money(t.manual), 'cash, FD, property — not in Gross Assets') + k('MTF Loans', h.money(t.mtf), mtfM.length + ' members (' + h.esc(mtfM.join(', ')) + ')', 'neg') + k('Bank Debt', h.money(t.bankDebt), 'OD, auto loan, cards · bureau', 'neg') + k('Tracked Net Worth', h.money(t.netTracked), 'gross − MTF − bank debt') + k('Net Worth excl. Property', h.money(exP), 'tracked + cash &amp; receivables + FD', 'pos') + k('Gross Net Worth', h.money(gnw), 'incl. real estate ' + h.money(re)) + k('Retirement (NPS+EPF)', h.money(t.retire), 'illiquid — Rishi') + '</div>'
      + '<p class="tie">How the figures tie: tracked net ' + full(t.netTracked) + ' + cash &amp; receivables ' + full(cash) + ' + FD ' + full(fd) + ' = net worth excl. property ' + full(exP) + ' · + real estate ' + full(re) + ' = gross net worth ' + full(gnw) + '</p></div>';
  }
  function injectCss() { if (document.getElementById('x5-css')) return; const s = document.createElement('style'); s.id = 'x5-css'; s.textContent = CSS; document.head.appendChild(s); }

  // ---------- live NSE prices (overlay; never written into MODEL)
  function liveUniverse() {
    const m = M(), eq = new Set(), und = new Set();
    m.holdings.forEach(h => { if (h.cls === 'Equity' && h.sym && !h.manual) eq.add(base(h.sym)); });
    (m.mtf || []).forEach(r => r.sym && eq.add(base(r.sym)));
    Object.keys(m.FO || {}).forEach(k => ((m.FO[k] || {}).legs || []).forEach(l => { if (l.und && !IDX[l.und]) eq.add(base(l.und)); if (l.und && IDX[l.und]) und.add(IDX[l.und]); }));
    und.add('NIFTY 50'); und.add('NIFTY BANK'); und.add('INDIA VIX');
    return { eq: Array.from(eq).sort(), idx: Array.from(und) };
  }
  async function callRead(tool, input) {
    try { return (await T.mcp.callTool(NSE, tool, input, { cache: { staleTime: 60000, gcTime: 600000 } })).payload; }
    catch (e) {
      if (e && e.retryable) { await new Promise(r => setTimeout(r, Math.min(e.retryAfterMs || 1500, 8000) + Math.random() * 800)); return (await T.mcp.callTool(NSE, tool, input, { cache: { staleTime: 60000, gcTime: 600000 } })).payload; }
      throw e;
    }
  }
  async function runLive(force) {
    const L = T.live; if (!T.mcp || L.state === 'running') return;
    if (force) { try { await T.mcp.invalidate(NSE); } catch (e) { } }
    const U = liveUniverse(); L.state = 'running'; L.err = {}; L.code = null; L.n = U.eq.length + U.idx.length; L.done = 0; paint();
    const jobs = U.eq.map(s => ['q', s]).concat(U.idx.map(s => ['i', s]));
    let i = 0, fatal = null;
    const worker = async () => {
      while (i < jobs.length && !fatal) {
        const [k, s] = jobs[i++];
        try {
          if (k === 'q') { const p = await callRead('cm_get_stock_quote', { symbol: s }); const st = p && p.stock; if (st && num(st.lastTradedPrice)) L.q[s] = { ltp: st.lastTradedPrice, prev: st.preClosePrice, pc: st.perChange, ts: st.latestTimestamp, series: st.series }; else L.err[s] = 'no quote'; }
          else { const p = await callRead('cm_get_index_quote', { indexName: s }); const x = p && p.index; if (x && num(x.last)) L.idx[s] = { last: x.last, prev: x.previousClose, pc: x.percChange, ts: p.nseTimestamp, w1: x.comparisons && x.comparisons.oneWeekAgo }; else L.err[s] = 'no quote'; }
        } catch (e) {
          const c = (e && e.code) || 'upstream_error';
          if (['needs_reauth', 'server_not_connected', 'not_in_manifest', 'blocked_by_policy', 'approval_required', 'selection_required', 'not_granted', 'capability_disabled', 'consent_required'].includes(c)) { fatal = c; break; }
          L.err[s] = c;
        }
        L.done++; if (L.done % 6 === 0) paint();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (fatal) { L.state = 'blocked'; L.code = fatal; L.q = {}; L.idx = {}; }
    else { L.state = Object.keys(L.q).length ? 'ok' : 'failed'; L.at = new Date(); }
    paint();
  }
  function liveMarks() {
    const m = M(), L = T.live, rows = [];
    m.holdings.forEach(h => {
      if (h.cls !== 'Equity' || !h.sym) return; const q = L.q[base(h.sym)]; if (!q) return;
      const liveV = h.qty * q.ltp; rows.push({ h, q, liveV, d: liveV - h.value, dev: h.price ? (q.ltp - h.price) / h.price : 0 });
    });
    const byM = {}; rows.forEach(r => { byM[r.h.member] = (byM[r.h.member] || 0) + r.d; });
    const mtf = (m.mtf || []).map(r => { const q = L.q[base(r.sym)]; return q ? { r, q, pnl: r.qty * (q.ltp - r.ac) } : null; }).filter(Boolean);
    return { rows, byM, total: rows.reduce((a, r) => a + r.d, 0), mtf, mtfPnl: mtf.reduce((a, x) => a + x.pnl, 0), mtfBooked: (m.mtf || []).reduce((a, r) => a + (r.pnl || 0), 0) };
  }
  // short option legs that live spot has reached or nearly reached
  function foProximity() {
    const m = M(), L = T.live, out = [], td = m.today;
    Object.keys(m.FO || {}).forEach(mem => ((m.FO[mem] || {}).legs || []).forEach(l => {
      if (!(l.q < 0) || !l.k || (l.exp && l.exp < td)) return;
      const spot = IDX[l.und] ? (L.idx[IDX[l.und]] || {}).last : (L.q[base(l.und)] || {}).ltp; if (!spot) return;
      const dist = l.t === 'CE' ? (l.k - spot) / spot : (spot - l.k) / spot;
      if (dist < 0.02) out.push({ mem, l, spot, dist, asof: (m.FO[mem] || {}).asof });
    }));
    return out.sort((a, b) => a.dist - b.dist);
  }

  // ---------- underlying audit (browser, runs on every open; complements the engine audit)
  function underlying() {
    const m = M(), f = [], td = m.today, add = (sev, area, title, detail, fix, value) => f.push({ sev, area, title, detail, fix, value: value || 0 });
    const H_ = m.holdings;
    // 1 arithmetic: qty x price = value
    const arith = H_.filter(h => num(h.qty) != null && num(h.price) != null && Math.abs(h.qty * h.price - h.value) > 1);
    arith.length ? add('fail', 'Arithmetic', arith.length + ' rows where quantity × price ≠ value', arith.slice(0, 6).map(h => h.member + ' ' + (h.sym || h.name)).join(', '), 'Re-run the build; if it persists the generator is mis-reading a row.') : add('pass', 'Arithmetic', 'Quantity × price = value on every priced row', H_.length + ' rows checked');
    // 2 MTF must finance a subset of the holding
    const over = H_.filter(h => h.mtfQty && h.mtfQty > h.qty + 0.001);
    over.length ? add('fail', 'MTF', 'MTF quantity exceeds the holding on ' + over.length + ' rows', over.map(h => h.member + ' ' + h.sym + ' MTF ' + h.mtfQty + ' > ' + h.qty).join('; '), 'MTF rows finance part of EQ; fix the EQ qty or the MTF row.') : add('pass', 'MTF', 'MTF quantities sit inside the holdings', (m.mtf || []).length + ' financed lines');
    const pl = H_.filter(h => h.cls === 'Equity' && (h.pledged || 0) + (h.mtfQty || 0) > h.qty + 0.001);
    if (pl.length) add('warn', 'MTF', 'Pledged + MTF exceeds quantity on ' + pl.length + ' rows', pl.map(h => h.member + ' ' + h.sym + ' (' + (h.pledged || 0) + '+' + (h.mtfQty || 0) + ' > ' + h.qty + ')').join('; '), 'Check the pledge statement; the two should not overlap.');
    const mtfSum = (m.mtf || []).reduce((a, r) => a + (r.loan || 0), 0);
    Math.abs(mtfSum - m.totals.mtf) > 1 ? add('fail', 'MTF', 'MTF lines do not add up to the MTF total', 'Lines ₹' + Math.round(mtfSum).toLocaleString('en-IN') + ' vs total ₹' + Math.round(m.totals.mtf).toLocaleString('en-IN'), 'Rebuild; the total must be the sum of the lines.') : add('pass', 'MTF', 'MTF lines add up to the MTF loan total', '');
    const derived = (m.mtf || []).filter(r => /derive|web|verify|Kite-derived/i.test(r.loanSrc || ''));
    if (derived.length) add('warn', 'MTF', derived.length + ' of ' + (m.mtf || []).length + ' MTF loans are derived, not statement figures', derived.map(r => r.member + ' ' + r.sym).join(', '), 'Upload the latest ICICI MTF open-position statement to the Inbox.', derived.reduce((a, r) => a + r.loan, 0));
    // 3 class totals tie to the audited totals
    const cls = (c) => H_.filter(h => h.cls === c).reduce((a, h) => a + h.value, 0);
    const ties = [['Equity', 'eq'], ['Mutual Fund', 'mf'], ['ETF', 'etf'], ['Bond', 'bond'], ['Retirement', 'retire']].map(([c, k]) => [c, cls(c), m.totals[k]]);
    const eqU = cls('Unlisted'); const bad = ties.filter(([c, v, t]) => t != null && Math.abs(v + (c === 'Equity' ? eqU : 0) - t) > 1 && Math.abs(v - t) > 1);
    bad.length ? add('fail', 'Reconcile', 'Holdings do not add up to the audited class totals', bad.map(([c, v, t]) => c + ' ' + Math.round(v) + ' vs ' + Math.round(t)).join('; '), 'Do not rely on the headline until rebuilt.') : add('pass', 'Reconcile', 'Every asset class adds up to the audited totals', ties.map(([c]) => c).join(', '));
    const pa = m.prodAudit || {}; const dNet = Math.round((m.totals.netTracked || 0) - (pa.net || 0));
    (pa.reconcile && pa.reconcile.ok && dNet === 0) ? add('pass', 'Reconcile', 'Build reconciles to the production audit, Δ₹0', (pa.reconcile.note || '').slice(0, 160)) : add('fail', 'Reconcile', 'Build does not reconcile to the production audit (Δ₹' + dNet + ')', (pa.reconcile && pa.reconcile.note) || '', 'Stop: restore the last backup and rebuild.');
    // 4 price freshness for listed rows
    const lastSess = (m.lineage && m.lineage[0] && m.lineage[0].asOf) || td;
    const staleEq = H_.filter(h => h.cls === 'Equity' && h.asOf && h.asOf < lastSess);
    staleEq.length ? add('warn', 'Freshness', staleEq.length + ' listed stocks priced before ' + lastSess, staleEq.map(h => h.member + ' ' + h.sym + ' ' + h.asOf).join(', '), 'Please update TW now.', staleEq.reduce((a, h) => a + h.value, 0)) : add('pass', 'Freshness', 'All listed stocks priced on the last session', lastSess);
    const etf = H_.filter(h => h.cls === 'ETF'), etfOld = etf.filter(h => !h.asOf || bdBetween(h.asOf, td) >= 2), etfOldV = etfOld.reduce((a, h) => a + h.value, 0);
    if (etfOld.length) { const oldest = etfOld.filter(h => h.asOf).map(h => h.asOf).sort()[0]; add(etfOldV > 100000 ? 'fail' : 'warn', 'Freshness', etfOld.length + ' of ' + etf.length + ' demat ETFs are not repriced by the daily run', 'Value ₹' + Math.round(etfOldV).toLocaleString('en-IN') + '; oldest price ' + (oldest || 'undated') + (etfOld.some(h => !h.asOf) ? '; some rows carry no price date' : '') + '. The daily price step prices EQ and MTF rows by symbol; ETF rows are matched by ISIN in price_etfs.py.', 'Run python price_etfs.py --apply (part of the 23:30 IST update).', etfOldV); }
    const mfs = H_.filter(h => h.cls === 'Mutual Fund'), mfLag = mfs.filter(h => (h.lagBd || 0) >= 2);
    mfLag.length ? add('warn', 'Freshness', mfLag.length + ' fund NAVs 2+ business days behind', mfLag.map(h => h.name).join(', '), 'python nav_amfi.py auto', mfLag.reduce((a, h) => a + h.value, 0)) : add('pass', 'Freshness', 'All ' + mfs.length + ' fund NAVs current', 'NAV dates ' + Array.from(new Set(mfs.map(h => h.asOf))).sort().join(', '));
    // 5 provenance
    const nof = mfs.filter(h => !h.folio); if (nof.length) add('warn', 'Provenance', nof.length + ' fund rows with no folio', nof.map(h => h.member + ': ' + h.name).join('; '), 'Attach the folio from a CAS, or remove the row.', nof.reduce((a, h) => a + h.value, 0));
    const nocost = H_.filter(h => ['Equity', 'Mutual Fund'].includes(h.cls) && h.cost == null);
    if (nocost.length) add('warn', 'Provenance', nocost.length + ' listed holdings carry no cost basis', nocost.map(h => h.member + ' ' + (h.sym || h.name)).join(', ') + ' — gains and tax cannot be computed for them.', 'Add average cost from the holding broker (Nuvama / other) statement.', nocost.reduce((a, h) => a + h.value, 0));
    const noisin = H_.filter(h => h.cls === 'Equity' && !h.isin); if (noisin.length) add('info', 'Provenance', noisin.length + ' equity rows identified by symbol only (no ISIN)', noisin.map(h => h.member + ' ' + h.sym).join(', '), 'Add ISINs so a symbol change or demerger cannot mis-map a row.');
    const reg = mfs.filter(h => h.plan && h.plan !== 'Direct'); if (reg.length) add('warn', 'Cost', reg.length + ' Regular-plan fund rows', reg.map(h => h.member + ': ' + h.name + ' ₹' + Math.round(h.value).toLocaleString('en-IN')).join('; '), 'Switch to Direct after checking exit load and capital gains.', reg.reduce((a, h) => a + h.value, 0));
    const tiny = H_.filter(h => ['ETF', 'Mutual Fund'].includes(h.cls) && h.value < 2000); if (tiny.length) add('info', 'Housekeeping', tiny.length + ' positions under ₹2,000', 'They add statements and audit noise without changing the outcome.', 'Consolidate or redeem.', tiny.reduce((a, h) => a + h.value, 0));
    // 6 manual / estimated assets
    const est = H_.filter(h => /ESTIMATE|est\./i.test((h.note || '') + ' ' + h.name)); if (est.length) add('warn', 'Estimates', est.length + ' rows are estimates, not statements', est.map(h => h.member + ': ' + h.name.slice(0, 60)).join('; '), 'Replace with the bank / broker ledger figure.', est.reduce((a, h) => a + h.value, 0));
    const re = H_.filter(h => h.cls === 'Real Estate'); re.forEach(h => { if (dayAgeOf(h.asOf) > 180) add('info', 'Estimates', 'Real estate ' + h.name + ' last valued ' + h.asOf, 'Self-reported; no valuation basis on file.', 'Add a dated valuation (circle rate or broker quote).', h.value); });
    // 7 derivatives book freshness
    Object.keys(m.FO || {}).forEach(k => { const F = m.FO[k]; if (!F || !(F.legs || []).length) return; const age = bdBetween(F.asof, td); if (age >= 2) add('fail', 'Derivatives', (m.members[k] ? m.members[k].name : k) + ' option book last refreshed ' + F.asof + ' (' + age + ' weekdays)', F.legs.length + ' legs; MTM, POP and max-loss shown for this book are stale.', 'Upload the ICICIdirect position file before expiry.'); const exp = F.legs.filter(l => l.exp && l.exp < td); if (exp.length) add('warn', 'Derivatives', exp.length + ' expired legs still listed for ' + k, '', 'Remove expired legs and book the realised P&L.'); });
    // 8 live-price cross-check (only after the live pass)
    if (T.live.state === 'ok') { const lm = liveMarks(); const dev = lm.rows.filter(r => Math.abs(r.dev) > 0.08); dev.length ? add('warn', 'Live check', dev.length + ' booked prices differ from live NSE by more than 8%', dev.map(r => r.h.sym + ' booked ' + r.h.price + ' vs live ' + r.q.ltp).join('; '), 'Check for a split, bonus or wrong symbol before the next build.') : add('pass', 'Live check', 'Booked prices agree with live NSE within 8%', lm.rows.length + ' rows compared'); const miss = Object.keys(T.live.err); if (miss.length) add('warn', 'Live check', 'NSE returned no quote for ' + miss.length + ' symbols', miss.join(', '), 'Confirm the NSE symbol in dash_data.json.'); }
    return f;
  }
  const dayAgeOf = iso => iso ? E().dayDiff(iso, M().today) : 9999;
  const sevOrd = { fail: 0, warn: 1, info: 2, pass: 3 };
  function allChecks() { const eng = (R().audit || []).map(a => Object.assign({ src: 'engine' }, a)); const und = underlying().map(a => Object.assign({ src: 'underlying' }, a)); return und.concat(eng).sort((a, b) => sevOrd[a.sev] - sevOrd[b.sev]); }
  const count = (L, s) => L.filter(x => x.sev === s).length;

  // ---------- status bar (always visible; the "runs the moment it opens" surface)
  function bar() {
    const m = M(), h = H(), chk = allChecks(), nf = count(chk, 'fail'), nw = count(chk, 'warn'), L = T.live;
    const built = new Date(m.builtAt), ageH = (Date.now() - built.getTime()) / 36e5, bd = bdBetween(m.builtAt.slice(0, 10), todayIST());
    const dataTone = bd >= 2 ? 'b' : bd === 1 ? 'w' : 'g';
    const nav = m.lineage && m.lineage[1] ? (m.lineage[1].oldest || m.lineage[1].asOf) : null;
    let live;
    if (L.state === 'running') live = 'Live NSE: checking ' + L.done + '/' + L.n + '…';
    else if (L.state === 'ok') { const lm = liveMarks(), fx = foProximity(); live = '<span class="dotx ' + (fx.length ? 'b' : 'g') + '"></span>Live NSE ' + hhmm(L.at) + ': equity ' + h.sgn(lm.total, v => h.money(v)) + ' vs build' + (fx.length ? ' · <b>' + fx.length + ' short option legs at or within 2% of spot</b>' : ''); }
    else if (L.state === 'blocked') live = '<span class="dotx w"></span>Live prices off (' + L.code + ')';
    else if (T.perm === 'prompt' && T.mcp) live = '<button data-x5="allow">Turn on live NSE prices</button>';
    else if (!T.mcp) live = 'Live prices need claude.ai';
    else live = 'Live NSE: waiting';
    return '<div class="wrap"><span><span class="dotx ' + (nf ? 'b' : nw ? 'w' : 'g') + '"></span>Audit ran on open ' + hhmm(T.openedAt) + ': <b>' + nf + ' fail · ' + nw + ' warn</b></span><span class="sep"></span>'
      + '<span>Portfolio score <b>' + Math.round(R().scores.overall) + '</b>/100</span><span class="sep"></span>'
      + '<span><span class="dotx ' + dataTone + '"></span>Data built <b>' + istStamp(m.builtAt) + '</b>' + (ageH > 1 ? ' (' + (ageH < 48 ? Math.round(ageH) + 'h' : Math.round(ageH / 24) + 'd') + ' ago)' : '') + '</span><span class="sep"></span>'
      + '<span>NAVs ' + h.fmtD(nav) + ' <span title="AMFI publishes NAV for a day at about 23:00 IST, so during the day the latest NAV is the previous trading day">(T−1 by design)</span></span><span class="sep"></span><span>' + live + '</span>'
      + '<span style="flex:1"></span><button data-x5="goupd">Update &amp; Audit →</button></div>';
  }
  function paint() {
    const b = document.getElementById('x5-bar'); if (b) b.innerHTML = bar();
    const kp = document.getElementById('x5-kpis'); if (kp) kp.innerHTML = kpiStrip();
    const sb = document.getElementById('x5-skin'); if (sb) { const cl = getSkin() === 'classic'; sb.textContent = cl ? 'Modern view' : 'Classic view'; sb.title = cl ? 'Switch to the navy V4 layout' : 'Switch to the earlier V2 layout'; }
    if (A().S.tab === 'update') { const el = document.getElementById('x5-live'); if (el) el.innerHTML = liveSection(); const au = document.getElementById('x5-aud'); if (au) au.innerHTML = auditSection(); const st = document.getElementById('x5-steps'); if (st) st.innerHTML = steps(); }
  }

  // ---------- Update & Audit tab
  function steps() {
    const m = M(), h = H(), L = T.live, chk = allChecks(), lin = m.lineage || [];
    const bd = bdBetween(m.builtAt.slice(0, 10), todayIST());
    const st = (k, v, s) => '<div class="x5-step"><span class="k">' + k + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></div>';
    const lv = L.state === 'ok' ? h.sgn(liveMarks().total, v => h.money(v)) : L.state === 'running' ? L.done + '/' + L.n : L.state === 'blocked' ? 'Off' : '—';
    return st('1 · Audit on open', count(chk, 'fail') + ' fail · ' + count(chk, 'warn') + ' warn', count(chk, 'pass') + ' checks passed · ran ' + hhmm(T.openedAt) + ' IST')
      + st('2 · Live NSE check', lv, L.state === 'ok' ? Object.keys(L.q).length + ' stocks + ' + Object.keys(L.idx).length + ' indices at ' + hhmm(L.at) + ' IST' : 'listed equity, MTF and option underlyings')
      + (() => { const hr = healthRows('all'), L = [].concat(hr.mf, hr.eq, hr.etf, hr.oth); return st('3 · Asset health', L.filter(x => x.st === 'stale').length + ' stale · ' + L.filter(x => x.st === 'watch').length + ' watch', L.filter(x => x.st === 'current').length + ' current · funds, stocks, ETFs, other'); })()
      + st('4 · Last full update', (bd === 0 ? 'Today' : bd + ' bd ago'), istStamp(m.builtAt) + ' · prices ' + h.fmtD(lin[0] && lin[0].asOf) + ' · NAV ' + h.fmtD(lin[1] && lin[1].asOf));
  }
  function liveSection() {
    const h = H(), L = T.live, m = M();
    if (!T.mcp) return '<p class="note">Live prices run only when this page is open in claude.ai. The figures below are from the last full update.</p>';
    if (L.state === 'blocked') return '<div class="callout">Live NSE prices are off for this view (' + h.esc(L.code) + '). ' + ({ server_not_connected: 'Add the cm-market connector in claude.ai Settings → Connectors.', needs_reauth: 'Reconnect cm-market in claude.ai Settings → Connectors.', not_in_manifest: 'You turned the connector off for this page; allow it from the artifact’s Permissions menu.', consent_required: 'Allow the connector when asked.', blocked_by_policy: 'Your organisation blocks this connector here.' }[L.code] || 'Use the full update below.') + '</div>';
    if (L.state !== 'ok') return '<p class="note">' + (L.state === 'running' ? 'Fetching live quotes from NSE… ' + L.done + ' of ' + L.n : T.perm === 'prompt' ? 'Click “Turn on live NSE prices” once; after that the check runs every time the page opens.' : 'Waiting for NSE.') + '</p>';
    const lm = liveMarks(), fx = foProximity();
    let o = '<div class="grid">' + m.memberOrder.map(k => '<div class="s4">' + h.kpi(h.dot(k) + h.mname(k), lm.byM[k] != null ? h.sgn(lm.byM[k], v => h.money(v)) : '—', 'listed equity, live vs build') + '</div>').join('') + '</div>';
    const ix = Object.keys(L.idx).map(n => { const x = L.idx[n]; return '<tr><td>' + h.esc(n) + '</td><td class="r">' + x.last.toLocaleString('en-IN', { maximumFractionDigits: 2 }) + '</td><td class="r">' + h.sgn(x.pc, v => Math.abs(v).toFixed(2) + '%') + '</td><td class="r">' + (x.w1 ? h.sgn(x.w1.changePct, v => Math.abs(v).toFixed(1) + '%') : '—') + '</td><td class="note">' + h.esc(x.ts || '') + '</td></tr>'; }).join('');
    o += '<div class="grid" style="margin-top:14px"><div class="s5">' + h.card('Indices', 'NSE cm-market, live', '<div class="tw"><table><thead><tr><th>Index</th><th class="r">Level</th><th class="r">Day</th><th class="r">1 week</th><th>As of</th></tr></thead><tbody>' + ix + '</tbody></table></div>') + '</div>';
    o += '<div class="s7">' + h.card('Option legs close to the money', 'Short legs not yet expired whose strike live spot has reached or is within 2% of. Option MTM is not in net worth.', fx.length ? '<div class="tw"><table><thead><tr><th>Member</th><th>Leg</th><th class="r">Qty</th><th class="r">Spot</th><th class="r">Distance</th><th>Book as of</th></tr></thead><tbody>' + fx.slice(0, 14).map(x => '<tr><td>' + h.dot(x.mem) + h.mname(x.mem) + '</td><td>' + h.esc(x.l.und + ' ' + x.l.k + ' ' + x.l.t) + '<small>exp ' + h.fmtD(x.l.exp) + '</small></td><td class="r">' + x.l.q + '</td><td class="r">' + x.spot.toLocaleString('en-IN') + '</td><td class="r">' + (x.dist < 0 ? h.pill('critical', 'ITM ' + (Math.abs(x.dist) * 100).toFixed(1) + '%') : h.pill('high', (x.dist * 100).toFixed(1) + '%')) + '</td><td class="note">' + h.fmtD(x.asof) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="note">No short leg is within 2% of live spot.</p>') + '</div></div>';
    const top = lm.rows.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12);
    o += h.card('Listed equity — booked vs live', 'Booked = price in the last full update. Live = NSE last traded price. Overlay only: the headline stays on audited figures until the next full update.', '<div class="tw"><table><thead><tr><th>Holding</th><th class="r">Qty</th><th class="r">Booked</th><th class="r">Live</th><th class="r">Day</th><th class="r">Δ vs build</th></tr></thead><tbody>' + top.map(r => '<tr><td>' + h.dot(r.h.member) + h.esc(r.h.sym) + '<small>' + h.esc(h.mname(r.h.member)) + ' · ' + h.fmtD(r.h.asOf) + '</small></td><td class="r">' + r.h.qty.toLocaleString('en-IN') + '</td><td class="r">' + r.h.price.toLocaleString('en-IN') + '</td><td class="r">' + r.q.ltp.toLocaleString('en-IN') + '<small>' + h.esc((r.q.ts || '').slice(11, 16)) + '</small></td><td class="r">' + (num(r.q.pc) != null ? h.sgn(r.q.pc, v => Math.abs(v).toFixed(2) + '%') : '—') + '</td><td class="r">' + h.sgn(r.d, v => h.money(v)) + '</td></tr>').join('') + '</tbody></table></div>'
      + '<p class="note" style="margin-top:8px">MTF unrealised P&amp;L at live prices: ' + h.sgn(lm.mtfPnl, v => h.money(v)) + ' (booked ' + h.sgn(lm.mtfBooked, v => h.money(v)) + '). Mutual fund NAVs, ETFs and bonds are not live-priced here; NAVs come from AMFI in the full update.</p>');
    return o;
  }
  function auditSection() {
    const h = H(), chk = allChecks(), f = T.audFilter || 'open';
    const rows = chk.filter(x => f === 'all' || (f === 'open' ? x.sev === 'fail' || x.sev === 'warn' : x.sev === f));
    const sp = s => h.pill(s === 'fail' ? 'fail' : s === 'warn' ? 'warn' : s === 'pass' ? 'pass' : 'info', s);
    return '<div class="filters"><div class="seg">' + [['open', 'Fail + warn'], ['fail', 'Fail'], ['warn', 'Warn'], ['pass', 'Passed'], ['all', 'All']].map(([k, l]) => '<button data-x5aud="' + k + '" aria-pressed="' + (f === k) + '">' + l + ' (' + (k === 'open' ? count(chk, 'fail') + count(chk, 'warn') : k === 'all' ? chk.length : count(chk, k)) + ')</button>').join('') + '</div><button class="btn sm" data-x5="copyaud">Copy audit</button></div>'
      + '<div class="tw"><table><thead><tr><th>Result</th><th>Area</th><th>Finding</th><th class="r">Value at stake</th><th>Fix</th></tr></thead><tbody>'
      + rows.map(x => '<tr><td>' + sp(x.sev) + '<small>' + (x.src === 'underlying' ? 'underlying' : 'engine') + '</small></td><td class="nw">' + h.esc(x.area) + '</td><td><b>' + h.esc(x.title) + '</b>' + (x.detail ? '<small>' + h.esc(x.detail) + '</small>' : '') + '</td><td class="r">' + (x.value ? h.money(x.value) : '') + '</td><td class="note">' + h.esc(x.fix || '') + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function tabUpdate() {
    const h = H(), m = M();
    let o = h.secH('Update & Audit', 'Each time this page opens it re-runs the audit and checks live NSE prices. The full update refreshes every source and republishes this page.');
    o += '<div class="x5-steps" id="x5-steps">' + steps() + '</div>';
    o += '<div class="grid" style="margin-top:14px"><div class="s7">' + h.card('Run the full update', 'Starts the “TW Update Now” task on your PC: AMFI NAVs, NSE prices, Kite holdings and margins, rebuild, reconcile to Δ₹0, republish. It also runs daily at 10:00 IST; if the PC is off then, it runs as soon as the PC is back online.',
      '<div id="upd-box" style="margin:6px 0 4px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--surface2)"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn primary" id="twRunBtn" disabled>↻ Run full update</button><button class="btn" data-x5="relive">Re-check live prices</button></div><div id="twRunMsg" class="note" style="margin-top:8px;min-height:1.2em">Checking whether one-click run is available in this view…</div></div>'
      + h.cmd('Please update TW now', 'Or paste this in a Claude chat')) + '</div>';
    o += '<div class="s5">' + h.card('What the full update touches', 'In order, with the source each step trusts.', '<table><tbody>' + [['MF NAVs', 'AMFI (nav_amfi.py auto)'], ['Stock prices', 'NSE bhavcopy / cm-market, Kite fallback'], ['Rishi holdings, MF units, margins', 'Kite (read-only)'], ['Build + audit', 'reconcile must be Δ₹0 or nothing publishes'], ['This page', 'rebuilt and republished from the same build']].map(r => '<tr><td>' + r[0] + '</td><td class="note">' + r[1] + '</td></tr>').join('') + '</tbody></table><p class="note" style="margin-top:8px">Shanti and Shilpi (ICICIdirect, Nuvama) have no feed: send statements through the Inbox tab.</p>') + '</div></div>';
    o += h.secH('Live check', 'NSE last traded prices against the last full update, plus option legs near the money.') + '<div id="x5-live">' + liveSection() + '</div>';
    o += h.secH('Audit of underlyings', 'Engine checks (same rules as audit_v4.js) plus underlying checks run in the browser: arithmetic, MTF ties, reconciliation, price and NAV freshness, provenance, estimates, stale option books.') + '<div id="x5-aud">' + auditSection() + '</div>';
    o += '<p class="note" style="margin-top:10px">Informational. Not investment, tax or legal advice.</p>';
    return o;
  }
  function initUpdateTab() { try { H().initUpdate(); } catch (e) { } const b = document.getElementById('twRunBtn'); if (b) b.textContent = '↻ Run full update'; }

  // ---------- Asset Health in the V2 layout: one row per fund / stock / ETF, Current · Watch · Stale
  // Status is recomputed when the page opens, against today's expected NSE session (not the build date),
  // so an old build shows its rows going stale instead of looking current.
  const NSE_CLOSED = new Set(['2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25']);
  const isSession = d => { const w = d.getUTCDay(); return w !== 0 && w !== 6 && !NSE_CLOSED.has(d.toISOString().slice(0, 10)); };
  const istNow = () => { const n = new Date(Date.now() + 5.5 * 36e5); return { d: n.toISOString().slice(0, 10), mins: n.getUTCHours() * 60 + n.getUTCMinutes() }; };
  const prevSession = iso => { const d = new Date(iso + 'T00:00:00Z'); do { d.setUTCDate(d.getUTCDate() - 1); } while (!isSession(d)); return d.toISOString().slice(0, 10); };
  const sessionsBetween = (a, b) => { if (!a || !b || a >= b) return 0; let n = 0; const d = new Date(a + 'T00:00:00Z'); while (true) { d.setUTCDate(d.getUTCDate() + 1); const s = d.toISOString().slice(0, 10); if (s > b) break; if (isSession(d)) n++; } return n; };
  function expected() {
    const t = istNow(), today = new Date(t.d + 'T00:00:00Z'), todayIs = isSession(today);
    const px = todayIs && t.mins >= 555 ? t.d : (todayIs ? prevSession(t.d) : prevSession(t.d));   // price: today's session once open (09:15)
    const navBase = todayIs && t.mins >= 1380 ? t.d : prevSession(t.d);                              // NAV for D lands ~23:00 IST
    const bm = M().lineage && M().lineage[0] && M().lineage[0].asOf;                                  // never expect less than the build already had
    const etf = todayIs && t.mins >= 1140 ? t.d : prevSession(t.d);                                  // ETFs: official close, bhavcopy after ~19:00 IST
    return { px: bm && bm > px ? bm : px, nav: navBase, etf };
  }
  const stat = bd => bd == null ? 'stale' : bd <= 0 ? 'current' : bd === 1 ? 'watch' : 'stale';
  const STAT = { current: ['Current', 'var(--good)'], watch: ['Watch', 'var(--warn)'], stale: ['Stale', 'var(--bad)'] };
  const badge = (st, why) => '<span class="x5-badge" style="background:' + STAT[st][1] + '" title="' + (why || STAT[st][0]) + '">' + STAT[st][0] + '</span>';
  function healthRows(mem) {
    const m = M(), ex = expected(), inM = h => mem === 'all' || h.member === mem;
    const group = (list, keyOf) => { const g = {}; list.forEach(h => { const k = keyOf(h); (g[k] = g[k] || { rows: [] }).rows.push(h); }); return Object.values(g).map(x => { const r0 = x.rows[0]; const dates = x.rows.map(r => r.asOf).filter(Boolean).sort(); return { h: r0, holders: Array.from(new Set(x.rows.map(r => r.member))), value: x.rows.reduce((a, r) => a + r.value, 0), asOf: dates[0] || null }; }); };
    const mf = group(m.holdings.filter(h => h.cls === 'Mutual Fund' && inM(h)), h => h.isin || h.name).map(g => { const fof = /FoF|Fund of Fund|International|Nasdaq|Global|Overseas|US /i.test(g.h.fullName || g.h.name); let bd = g.asOf ? sessionsBetween(g.asOf, ex.nav) : null; const st = bd != null && fof && bd === 1 ? 'watch' : stat(bd); return Object.assign(g, { bd, st, fof }); });
    const eq = group(m.holdings.filter(h => h.cls === 'Equity' && h.sym && inM(h)), h => base(h.sym)).map(g => { const bd = g.asOf ? sessionsBetween(g.asOf, ex.px) : null; return Object.assign(g, { bd, st: stat(bd), live: T.live.q[base(g.h.sym)] }); });
    const etf = group(m.holdings.filter(h => h.cls === 'ETF' && inM(h)), h => h.isin || h.name).map(g => { const bd = g.asOf ? sessionsBetween(g.asOf, ex.etf) : null; return Object.assign(g, { bd, st: stat(bd) }); });
    const LIM = { Bond: [7, 'SGB price, weekly'], Unlisted: [120, 'latest round / board value'], 'Fixed Deposit': [2, 'accrued daily'], 'Cash & Receivables': [10, 'ledger / bank statement'], Retirement: [60, 'NPS / EPF statement, monthly'], 'Real Estate': [365, 'valuation, yearly'] };
    const oth = m.holdings.filter(h => LIM[h.cls] && inM(h)).map(h => { const age = h.asOf ? E().dayDiff(h.asOf, m.today) + Math.max(0, E().dayDiff(m.today, istNow().d)) : null; const [lim, cad] = LIM[h.cls]; const st = age == null ? 'stale' : age <= lim * 0.6 ? 'current' : age <= lim ? 'watch' : 'stale'; return { h, holders: [h.member], value: h.value, asOf: h.asOf, age, st, cad, lim }; });
    const by = (a, b) => ({ stale: 0, watch: 1, current: 2 }[a.st] - { stale: 0, watch: 1, current: 2 }[b.st]) || b.value - a.value;
    return { ex, mf: mf.sort(by), eq: eq.sort(by), etf: etf.sort(by), oth: oth.sort(by) };
  }
  function staleCount(mem) { const r = healthRows(mem || 'all'); return [].concat(r.mf, r.eq, r.etf, r.oth).filter(x => x.st === 'stale').length; }
  function tabHealth(origTab) {
    const h = H(), m = M(), mem = A().S.member, R_ = healthRows(mem), hold = ks => ks.map(k => h.mname(k)).join(', ');
    const sumV = L => L.reduce((a, x) => a + x.value, 0);
    const strip = (label, L, book, unit) => { const st = L.filter(x => x.st === 'stale'), wt = L.filter(x => x.st === 'watch'), cu = L.filter(x => x.st === 'current'); const worst = L.reduce((a, x) => Math.max(a, x.bd == null ? 999 : x.bd), 0); const sv = sumV(st);
      return '<div class="x5h-k">' + [['Stale ' + unit, st.length, '≥2 business days behind', st.length ? 'neg' : 'pos'], ['Watch', wt.length, '1 business day behind', wt.length ? 'warn' : 'pos'], ['Current', cu.length, 'on latest expected date', 'pos'], ['Value on stale ' + unit, h.money(sv), (book ? (sv / book * 100).toFixed(1) : '0') + '% of ' + label, sv ? 'neg' : 'pos'], ['Stalest', worst === 999 ? 'undated' : worst + ' bd', 'as of ' + h.fmtD(istNow().d), '']].map(([l, v, s, c]) => '<div class="k"><div class="kl">' + l + '</div><div class="kv ' + c + '">' + v + '</div><div class="ks">' + s + '</div></div>').join('') + '</div>'; };
    let o = '<div class="sec-h"><h2>Asset Health <span class="x5-tag">NAV &amp; price freshness, checked when this page opened (' + hhmm(T.openedAt) + ' IST)</span></h2></div>';
    o += '<p class="note" style="margin:0 0 6px">Expected dates now: stock prices <b>' + h.fmtD(R_.ex.px) + '</b> · fund NAVs <b>' + h.fmtD(R_.ex.nav) + '</b>. Current = on the expected date · Watch = 1 business day behind (normal for fund-of-funds before ~11:00 IST) · Stale = 2 or more.</p>';
    // Mutual funds
    o += '<h4 class="x5h-h">Mutual Fund NAVs</h4>' + strip('MF book', R_.mf, sumV(R_.mf), 'NAVs');
    o += '<div class="tw"><table><thead><tr><th>Fund</th><th>Holders</th><th class="r">NAV</th><th class="r">NAV Date</th><th class="r">Behind (bd)</th><th>Status</th><th class="r">Family Value</th></tr></thead><tbody>' + R_.mf.map(x => '<tr><td>' + h.esc(x.h.fullName || x.h.name) + (x.h.plan && x.h.plan !== 'Direct' ? ' <span class="x5-tag">Regular</span>' : '') + (x.fof ? ' <span class="x5-tag">FoF</span>' : '') + '</td><td>' + hold(x.holders) + '</td><td class="r">' + (x.h.price != null ? x.h.price : '—') + '</td><td class="r nw">' + h.fmtD(x.asOf) + '</td><td class="r">' + (x.bd == null ? '—' : x.bd) + '</td><td>' + badge(x.st) + '</td><td class="r">' + h.money(x.value, 1) + '</td></tr>').join('') + '</tbody></table></div>';
    o += '<p class="note">NAVs come from AMFI in the full update (nav_amfi.py auto). A Stale fund should be checked against AMFI before relying on its value.</p>';
    // Stocks
    o += '<h4 class="x5h-h">Direct Equity — Stock LTPs</h4>' + strip('equity book', R_.eq, sumV(R_.eq), 'LTPs');
    const liveOn = T.live.state === 'ok';
    o += '<div class="tw"><table><thead><tr><th>Symbol</th><th>Company</th><th>Holders</th><th class="r">LTP</th><th class="r">LTP Date</th><th class="r">Behind (bd)</th><th>Status</th>' + (liveOn ? '<th class="r">Live NSE</th>' : '') + '<th class="r">Family Value</th></tr></thead><tbody>' + R_.eq.map(x => { const lv = x.live; return '<tr><td><b>' + h.esc(x.h.sym) + '</b></td><td>' + h.esc(x.h.name) + '</td><td>' + hold(x.holders) + '</td><td class="r">' + h.money(x.h.price, 1) + '</td><td class="r nw">' + h.fmtD(x.asOf) + '</td><td class="r">' + (x.bd == null ? '—' : x.bd) + '</td><td>' + badge(x.st) + '</td>' + (liveOn ? '<td class="r">' + (lv ? lv.ltp.toLocaleString('en-IN') + '<small>' + h.esc((lv.ts || '').slice(0, 16)) + '</small>' : '<span class="note">no quote</span>') + '</td>' : '') + '<td class="r">' + h.money(x.value, 1) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    o += '<p class="note">' + (liveOn ? 'Live NSE column: last traded price checked when this page opened (display only; the booked LTP changes with the full update).' : 'Turn on live NSE prices from the bar above to see a live column here.') + ' TRUSTPLUTUS (unlisted) is never priced and is listed under Other assets.</p>';
    // ETFs
    if (R_.etf.length) {
      o += '<h4 class="x5h-h">Demat ETFs</h4>' + strip('ETF book', R_.etf, sumV(R_.etf), 'prices');
      o += '<div class="tw"><table><thead><tr><th>ETF</th><th>ISIN</th><th>Holders</th><th class="r">Price</th><th class="r">Price Date</th><th class="r">Behind (bd)</th><th>Status</th><th class="r">Family Value</th></tr></thead><tbody>' + R_.etf.map(x => '<tr><td>' + h.esc(x.h.name) + '</td><td class="mono">' + h.esc(x.h.isin || '') + '</td><td>' + hold(x.holders) + '</td><td class="r">' + (x.h.price != null ? x.h.price : '—') + '</td><td class="r nw">' + (x.asOf ? h.fmtD(x.asOf) : 'no date') + '</td><td class="r">' + (x.bd == null ? '—' : x.bd) + '</td><td>' + badge(x.st, x.asOf ? '' : 'No price date on record') + '</td><td class="r">' + h.money(x.value, 1) + '</td></tr>').join('') + '</tbody></table></div>';
      o += '<p class="note">ETFs are priced from NSE\'s official closing bhavcopy, matched by ISIN (price_etfs.py), in the 23:30 IST run. Expected date now: <b>' + h.fmtD(R_.ex.etf) + '</b>.</p>';
    }
    // Other assets
    o += '<h4 class="x5h-h">Other assets</h4><div class="tw"><table><thead><tr><th>Asset</th><th>Holder</th><th>Updated by</th><th class="r">As of</th><th class="r">Age (days)</th><th>Status</th><th class="r">Value</th></tr></thead><tbody>' + R_.oth.map(x => '<tr><td>' + h.esc(x.h.name) + '<small>' + h.esc(x.h.cls) + '</small></td><td>' + hold(x.holders) + '</td><td class="note">' + h.esc(x.cad) + '</td><td class="r nw">' + (x.asOf ? h.fmtD(x.asOf) : 'no date') + '</td><td class="r">' + (x.age == null ? '—' : x.age) + '</td><td>' + badge(x.st, 'Limit ' + x.lim + ' days') + '</td><td class="r">' + h.money(x.value, 1) + '</td></tr>').join('') + '</tbody></table></div>';
    o += '<p class="note">Other assets are judged in calendar days against how often their statement arrives: Current within 60% of that interval, Watch up to 100%, Stale beyond it.</p>';
    if (typeof origTab === 'function') o += '<details class="x5-more"><summary>Holding health scores (freshness, source, leverage, size, cost)</summary>' + origTab() + '</details>';
    return o;
  }

  // ---------- Behavioural tab (live version of the Behavioral Ledger)
  function tabBehaviour() {
    const h = H(), m = M(), X = R().X, hs = m.holdings;
    const mf = hs.filter(x => x.cls === 'Mutual Fund'), mfT = mf.reduce((a, x) => a + x.value, 0);
    const amc = {}; mf.forEach(x => amc[x.amc || '?'] = (amc[x.amc || '?'] || 0) + x.value); const amcL = Object.entries(amc).sort((a, b) => b[1] - a[1]);
    const eqN = {}; hs.filter(x => x.cls === 'Equity').forEach(x => eqN[x.sym] = (eqN[x.sym] || 0) + x.value); const eqL = Object.entries(eqN).sort((a, b) => b[1] - a[1]), eqT = eqL.reduce((a, x) => a + x[1], 0);
    const top4 = eqL.slice(0, 4), top4S = top4.reduce((a, x) => a + x[1], 0) / (eqT || 1);
    const mtfOnTop = (m.mtf || []).filter(r => top4.some(t => t[0] === r.sym)).reduce((a, r) => a + r.loan, 0), mtfT = m.totals.mtf || 0;
    const reg = mf.filter(x => x.plan && x.plan !== 'Direct'), regV = reg.reduce((a, x) => a + x.value, 0);
    const hot = mf.filter(x => (x.xirr || 0) >= 40);
    const open = R().advice.filter(a => /nominee|transmission|estate|succession/i.test((a.title || '') + ' ' + (a.rule || '')));
    const leg = Object.keys(m.FO || {}).reduce((a, k) => a + ((m.FO[k] || {}).combined || []).filter(c => c.naked).length, 0);
    const E_ = (sev, tag, title, ev, mech) => '<section class="card adv sev-' + sev + '"><div class="adv-h"><h4>' + title + '</h4>' + h.pill(sev === 'high' ? 'high' : sev === 'medium' ? 'medium' : 'low', tag) + '</div><div class="x5-ev">' + ev + '</div><p style="margin:0;color:var(--muted)">' + mech + '</p></section>';
    let o = h.secH('Behavioural', 'Six documented investor biases, each matched to a live number in this book. Recomputed on every build.');
    o += '<div class="grid" style="margin-bottom:14px"><div class="s3">' + h.kpi('Top AMC share', ((amcL[0] || [, 0])[1] / (mfT || 1) * 100).toFixed(1) + '%', h.esc((amcL[0] || ['—'])[0]) + ' of the MF book') + '</div><div class="s3">' + h.kpi('Top-4 stocks', (top4S * 100).toFixed(1) + '%', 'of direct equity') + '</div><div class="s3">' + h.kpi('MTF on top-4', mtfT ? (mtfOnTop / mtfT * 100).toFixed(0) + '%' : '0%', h.money(mtfOnTop) + ' of ' + h.money(mtfT)) + '</div><div class="s3">' + h.kpi('Naked option structures', String(leg), 'across members') + '</div></div>';
    o += '<div class="x5-bias">'
      + E_(amcL[0] && amcL[0][1] / mfT > 0.35 ? 'high' : 'medium', 'Herding / familiarity', 'One fund house carries a large share of the fund book', h.esc(amcL.slice(0, 3).map(a => a[0] + ' ' + (a[1] / mfT * 100).toFixed(1) + '%').join(' · ')) + ' of ' + h.money(mfT) + ' across ' + amcL.length + ' AMCs', 'Many schemes from a familiar house reads as spread, but the book still rides one investment process and one risk team. Check whether new SIPs go to this AMC by habit.')
      + E_(mtfT && mtfOnTop / mtfT > 0.4 ? 'high' : 'medium', 'Overconfidence', 'Leverage sits on names that are already concentrated', 'Top-4: ' + h.esc(top4.map(t => t[0]).join(', ')) + ' = ' + (top4S * 100).toFixed(1) + '% of direct equity · ' + h.money(mtfOnTop) + ' of ' + h.money(mtfT) + ' MTF on them', 'Liking a stock and borrowing to own more of it are two separate decisions. When both stack on the same names, a fall hits the holding and the margin at once.')
      + E_(regV > 50000 ? 'medium' : 'low', 'Status quo / inertia', 'Regular-plan share classes still held', reg.length ? h.esc(reg.map(x => h.mname(x.member) + ': ' + x.name).join('; ')) + ' · ' + h.money(regV) : 'None — every fund is a Direct plan', 'A Regular plan pays a distributor trail every year with nothing in return when a Direct twin exists. It survives only because switching needs a decision.')
      + E_(hot.length >= 3 ? 'medium' : 'low', 'Recency bias', 'Rally-era XIRRs can be mistaken for the forward rate', hot.length ? h.esc(hot.slice(0, 5).map(x => x.name + ' ' + x.xirr.toFixed(1) + '%').join(' · ')) + (hot[0] && hot[0].xirrAsOf ? ' (XIRR as of ' + h.fmtD(hot[0].xirrAsOf) + ')' : '') : 'No fund shows an XIRR above 40%', 'The plan assumes equity returns of ' + (R().A.equityReturn || 12) + '% a year. Size SIPs and retirement maths on that, not on a short window\'s XIRR.')
      + E_(open.length ? 'high' : 'low', 'Present bias', 'Low-effort, high-consequence paperwork keeps slipping', open.length ? h.esc(open.slice(0, 3).map(a => a.title).join(' · ')) : 'No open nominee, transmission or estate item', 'A five-minute form with no payoff today loses to whatever feels urgent. The cost lands later, on the family, as a succession problem.')
      + E_(leg ? 'high' : 'low', 'Loss aversion / disposition', 'Selling premium against a trending market', leg + ' naked structures · see Update & Audit for legs near the money', 'Short-option books feel safe because most expire worthless. The losses come in the few weeks the market trends, and the urge to hold a losing short "until it comes back" is the disposition effect.')
      + '</div><p class="note" style="margin-top:10px">Patterns are matched to portfolio facts; this is not a psychological assessment or investment advice.</p>';
    return o;
  }

  // ---------- History tab (net worth log + plan vs actual)
  function tabHistory() {
    const h = H(), m = M(), hist = (m.hist || []).slice(); if (!hist.length) return h.secH('History') + '<p class="note">No history yet.</p>';
    const first = hist[0], last = hist[hist.length - 1];
    const b0 = hist.find(r => r.d >= PLAN_BASE) || first;
    const plan = d => b0.net * Math.pow(1 + PLAN_RATE, E().dayDiff(b0.d, d) / 365);
    const months = {}; hist.forEach(r => months[r.d.slice(0, 7)] = r);
    let o = h.secH('History', 'Daily end-of-day log from networth_history.csv. Tracked net = listed + retirement − MTF − bank debt (excludes cash, FD and property).');
    o += '<div class="grid"><div class="s3">' + h.kpi('Tracked net', h.money(last.net), h.fmtD(last.d)) + '</div><div class="s3">' + h.kpi('Since ' + h.fmtD(first.d), h.sgn(last.net - first.net, v => h.money(v)), ((last.net / first.net - 1) * 100).toFixed(1) + '% · includes Vijai’s account closing') + '</div><div class="s3">' + h.kpi('Plan at 11%', h.money(plan(last.d)), 'from ' + h.fmtD(b0.d)) + '</div><div class="s3">' + h.kpi('Versus plan', h.sgn(last.net - plan(last.d), v => h.money(v)), ((last.net / plan(last.d) - 1) * 100).toFixed(2) + '%') + '</div></div>';
    o += h.card('Tracked net worth vs 11% plan', 'Plan compounds the ' + h.fmtD(b0.d) + ' figure at a flat 11% a year.', '<div class="chart-box"><canvas id="x5-hc"></canvas></div>');
    o += h.secH('Month ends') + '<div class="tw"><table><thead><tr><th>Month</th><th class="r">Gross</th><th class="r">MTF</th><th class="r">Bank debt</th><th class="r">Tracked net</th><th class="r">Plan</th><th class="r">Deviation</th></tr></thead><tbody>' + Object.keys(months).sort().reverse().map(k => { const r = months[k], p = r.d >= b0.d ? plan(r.d) : null; return '<tr><td>' + k + '<small>' + h.fmtD(r.d) + '</small></td><td class="r">' + h.money(r.gross, 1) + '</td><td class="r">' + h.money(r.mtf || 0) + '</td><td class="r">' + h.money(r.debt || 0) + '</td><td class="r">' + h.money(r.net, 1) + '</td><td class="r">' + (p ? h.money(p, 1) : '—') + '</td><td class="r">' + (p ? h.sgn(r.net - p, v => h.money(v)) : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    o += h.secH('Daily log') + '<div class="tw" style="max-height:420px;overflow-y:auto"><table><thead><tr><th>Date</th><th class="r">Gross</th><th class="r">Equity</th><th class="r">Funds</th><th class="r">Tracked net</th><th class="r">Day Δ</th></tr></thead><tbody>' + hist.slice().reverse().map((r, i, a) => { const p = a[i + 1]; return '<tr><td>' + h.fmtD(r.d) + '</td><td class="r">' + h.money(r.gross, 1) + '</td><td class="r">' + h.money(r.equity || 0) + '</td><td class="r">' + h.money(r.mf || 0) + '</td><td class="r">' + h.money(r.net, 1) + '</td><td class="r">' + (p ? h.sgn(r.net - p.net, v => h.money(v)) : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    return o;
  }
  function initHistory() {
    const h = H(), m = M(), hist = m.hist || []; if (hist.length < 2) return;
    const b0 = hist.find(r => r.d >= PLAN_BASE) || hist[0]; const pal = h.palette();
    h.mkChart('x5-hc', { type: 'line', data: { labels: hist.map(r => r.d.slice(5)), datasets: [
      { label: 'Tracked net', data: hist.map(r => r.net), borderColor: pal[3], backgroundColor: 'transparent', pointRadius: 0, borderWidth: 2, tension: .2 },
      { label: 'Plan 11%', data: hist.map(r => r.d >= b0.d ? b0.net * Math.pow(1 + PLAN_RATE, E().dayDiff(b0.d, r.d) / 365) : null), borderColor: pal[4], borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, spanGaps: true }] },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + E().inr(c.parsed.y) } } }, scales: { y: { ticks: { callback: v => E().inrS(v) }, grid: { color: h.cssv('--line') } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } } } } });
  }

  // ---------- Export tab
  const csvCell = v => { if (v == null) return ''; const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const toCsv = (cols, rows) => cols.map(c => c[0]).join(',') + '\n' + rows.map(r => cols.map(c => csvCell(typeof c[1] === 'function' ? c[1](r) : r[c[1]])).join(',')).join('\n') + '\n';
  function exports_() {
    const m = M(), mem = A().S.member, inM = x => mem === 'all' || x.member === mem, mn = k => (m.members[k] ? m.members[k].name : k);
    const hold = m.holdings.filter(inM);
    return {
      holdings: ['All holdings', 'Every asset row for the selected member filter, with value, cost, price date and liquidity.', () => toCsv([['member', r => mn(r.member)], ['class', 'cls'], ['name', 'name'], ['symbol', 'sym'], ['isin', 'isin'], ['qty', 'qty'], ['price', 'price'], ['value_inr', 'value'], ['cost_inr', 'cost'], ['gain_inr', r => r.cost != null ? r.value - r.cost : null], ['price_date', 'asOf'], ['sector', 'sector'], ['mtf_qty', 'mtfQty'], ['mtf_loan', 'mtfLoan'], ['liquidity', 'liquidity']], hold)],
      mf: ['Mutual funds', 'Units, NAV and date, cost, XIRR, AMC, category, plan, folio flag and the review view.', () => toCsv([['member', r => mn(r.member)], ['fund', 'fullName'], ['isin', 'isin'], ['amc', 'amc'], ['category', 'cat'], ['plan', 'plan'], ['units', 'qty'], ['nav', 'price'], ['nav_date', 'asOf'], ['value_inr', 'value'], ['cost_inr', 'cost'], ['xirr_pct', 'xirr'], ['folio_on_record', r => r.folio ? 'yes' : 'no'], ['view', r => r.reco && r.reco.act]], hold.filter(x => x.cls === 'Mutual Fund'))],
      eq: ['Equity & MTF', 'Listed stocks with pledged and margin-funded quantities, plus live NSE price if checked this session.', () => toCsv([['member', r => mn(r.member)], ['symbol', 'sym'], ['name', 'name'], ['qty', 'qty'], ['booked_price', 'price'], ['price_date', 'asOf'], ['value_inr', 'value'], ['cost_inr', 'cost'], ['pledged', 'pledged'], ['mtf_qty', 'mtfQty'], ['mtf_loan', 'mtfLoan'], ['live_ltp', r => (T.live.q[base(r.sym)] || {}).ltp], ['live_time', r => (T.live.q[base(r.sym)] || {}).ts], ['consensus_target', r => r.reco && r.reco.tgt], ['view', r => r.reco && r.reco.act]], hold.filter(x => x.cls === 'Equity'))],
      debt: ['Liabilities', 'MTF lines, bureau-reported bank accounts and card balances.', () => toCsv([['type', 'type'], ['member', 'member'], ['lender', 'lender'], ['detail', 'detail'], ['balance_inr', 'bal'], ['limit_inr', 'limit'], ['as_of', 'asOf']], [].concat((m.mtf || []).filter(inM).map(r => ({ type: 'MTF', member: mn(r.member), lender: 'Broker', detail: r.sym + ' ' + r.qty + ' sh', bal: r.loan, limit: null, asOf: '' })), ((m.CREDIT || {}).accounts || []).map(a => ({ type: a.type, member: 'Rishi', lender: a.lender, detail: a.note || '', bal: a.bal, limit: a.limit, asOf: a.reported })), (m.cards || []).filter(inM).map(c => ({ type: 'Card', member: mn(c.member), lender: c.issuer, detail: c.name, bal: c.out, limit: c.limit, asOf: c.asOf }))))],
      fo: ['Derivatives', 'Every open option leg by member, with strike, quantity, average, LTP and P&L as last refreshed.', () => { const rows = []; Object.keys(m.FO || {}).forEach(k => { if (mem !== 'all' && k !== mem) return; ((m.FO[k] || {}).legs || []).forEach(l => rows.push(Object.assign({ member: mn(k), asof: m.FO[k].asof }, l))); }); return toCsv([['member', 'member'], ['book_as_of', 'asof'], ['contract', 'sym'], ['underlying', 'und'], ['expiry', 'exp'], ['strike', 'k'], ['type', 't'], ['qty', 'q'], ['avg', 'avg'], ['ltp', 'ltp'], ['iv', 'iv'], ['breakeven', 'be'], ['pnl_inr', 'pnl']], rows); }],
      history: ['Net worth history', 'Daily log: gross, equity, funds, ETFs, bonds, retirement, MTF, bank debt, tracked net.', () => toCsv([['date', 'd'], ['gross', 'gross'], ['equity', 'equity'], ['mf', 'mf'], ['etf', 'etf'], ['bonds', 'bonds'], ['retirement', 'retire'], ['mtf', 'mtf'], ['bank_debt', 'debt'], ['tracked_net', 'net']], m.hist || [])],
      audit: ['Audit findings', 'Engine and underlying checks from this open, with value at stake and the fix.', () => toCsv([['result', 'sev'], ['source', 'src'], ['area', 'area'], ['finding', 'title'], ['detail', 'detail'], ['value_at_stake', 'value'], ['fix', 'fix']], allChecks())],
      advice: ['Advisor actions', 'Every advice item with severity, members and the recommended action.', () => toCsv([['severity', 'sev'], ['area', 'area'], ['title', 'title'], ['members', r => (r.who || []).map(mn).join(' ')], ['action', r => r.action || r.act || ''], ['rule', 'rule']], R().advice)],
      json: ['Full data (JSON)', 'The complete model behind this page, for Excel Power Query or another tool. Contains no PANs, passwords or folio numbers.', () => JSON.stringify(M(), null, 1)]
    };
  }
  function tabExport() {
    const h = H(), X = exports_(), mem = A().S.member;
    let o = h.secH('Export', 'Download the data behind every tab. Files follow the member filter in the header (now: ' + (mem === 'all' ? 'whole family' : h.esc(h.mname(mem))) + ').');
    if (!T.dl) o += '<div class="callout" style="margin-bottom:12px">Downloads need this page open in claude.ai. Here you can still copy any file’s contents and paste it into Excel or a text file.</div>';
    o += '<div class="x5-exp">' + Object.keys(X).map(k => { const [t, d] = X[k]; const ext = k === 'json' ? 'json' : 'csv'; return '<section class="card"><h3>' + t + '</h3><div class="sub" style="margin:0">' + d + '</div><div class="btns">' + (T.dl ? '<button class="btn primary sm" data-x5dl="' + k + '">Download .' + ext + '</button>' : '') + '<button class="btn sm" data-x5cp="' + k + '">Copy</button></div></section>'; }).join('') + '</div>';
    o += '<p class="note" style="margin-top:12px">CSV amounts are in rupees, unrounded to the paisa. Hidden-amount mode does not apply to exports: check the file before sending it to anyone.</p>';
    return o;
  }
  async function doDownload(k) {
    const h = H(), X = exports_()[k]; if (!X) return; const ext = k === 'json' ? 'json' : 'csv'; const mem = A().S.member;
    const fn = 'TW_' + (k === 'json' ? 'data' : k) + (mem === 'all' ? '' : '_' + mem) + '_' + M().today + '.' + ext;
    try { await T.dl.save({ filename: fn, data: X[2]() }); h.toast('Saved ' + fn); }
    catch (e) { const c = e && e.code; h.toast(c === 'declined' ? 'Download cancelled' : c === 'rate_limited' ? 'Another download is open; try again' : 'Download not available here — use Copy'); }
  }

  // ---------- events + boot
  document.addEventListener('click', ev => {
    if (ev.target.closest('#x5-skin')) { setSkin(getSkin() === 'classic' ? 'modern' : 'classic'); paint(); if (window.TWAPP) window.TWAPP.render(); return; }
    const t = ev.target.closest('[data-x5],[data-x5aud],[data-x5dl],[data-x5cp]'); if (!t || !window.TWAPP) return;
    const k = t.dataset.x5;
    if (k === 'goupd') return A().go('update');
    if (k === 'relive') return runLive(true);
    if (k === 'allow') { T.perm = 'granted'; return runLive(false); }
    if (k === 'copyaud') return H().copy('TW AUDIT — ' + M().todayLabel + ' (opened ' + hhmm(T.openedAt) + ' IST)\n' + allChecks().filter(x => x.sev !== 'pass').map(x => '[' + x.sev.toUpperCase() + '] ' + x.area + ': ' + x.title + (x.fix ? ' → ' + x.fix : '')).join('\n'));
    if (t.dataset.x5aud) { T.audFilter = t.dataset.x5aud; const au = document.getElementById('x5-aud'); if (au) au.innerHTML = auditSection(); return; }
    if (t.dataset.x5dl) return doDownload(t.dataset.x5dl);
    if (t.dataset.x5cp) { const X = exports_()[t.dataset.x5cp]; if (X) H().copy(X[2]()); }
  });

  async function boot() {
    injectCss();
    const view = document.getElementById('view');
    if (view && !document.getElementById('x5-bar')) { const b = document.createElement('div'); b.id = 'x5-bar'; b.className = 'x5bar'; const mast = document.querySelector('header.mast'); (mast && mast.parentNode ? mast.parentNode.insertBefore(b, mast.nextSibling) : view.parentNode.insertBefore(b, view)); }
    if (!document.getElementById('x5-kpis')) { const kp = document.createElement('div'); kp.id = 'x5-kpis'; kp.className = 'x5kp'; const bar = document.getElementById('x5-bar'); bar.parentNode.insertBefore(kp, bar); }
    const mb = document.getElementById('mask');
    if (mb && !document.getElementById('x5-skin')) { const sb = document.createElement('button'); sb.id = 'x5-skin'; sb.className = 'chip'; sb.type = 'button'; mb.parentNode.insertBefore(sb, mb); }
    paint();
    const c = window.claude; if (!c || typeof c.use !== 'function') return;
    c.use('downloads').then(d => { T.dl = d; if (A().S.tab === 'export') A().render(); }).catch(() => { });
    let mcp = null; try { mcp = await c.use('mcp'); } catch (e) { mcp = null; }
    T.mcp = mcp; if (!mcp) { paint(); return; }
    let st = 'prompt'; try { const p = await c.use('permissions'); if (p) st = await p.state('mcp:' + NSE).catch(() => 'prompt'); } catch (e) { }
    T.perm = st;
    if (st === 'granted') runLive(false);
    else if (st === 'denied') { T.live.state = 'blocked'; T.live.code = 'not_in_manifest'; paint(); }
    else if (st === 'unavailable') { T.mcp = null; paint(); }
    else paint();
  }
  window.TW5 = { tabHealth, staleCount, boot, tabUpdate, initUpdateTab, tabBehaviour, tabHistory, initHistory, tabExport, paint, get live() { return T.live; }, _underlying: underlying };
})();
