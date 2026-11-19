"use strict";
const nf0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const lv = (x) => (x == null ? "—" : nf0.format(x));
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const charts = {};
const oiMode = {};
const LABEL = { weekly: "weekly", monthly: "monthly" };
const SIGNAL_LABEL = { forward: "Futures-implied", max_pain: "Max pain", wall_centre: "OI walls", gamma_pin: "Gamma pin",
  pcr: "PCR tilt", momentum: "Momentum", pivot: "Pivot" };

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function renderStatus(s) {
  const h = document.getElementById("status");
  const login = s.login === "login_needed";
  h.classList.toggle("alert", login || s.stale);
  h.classList.toggle("login", login);
  let state = login ? "Kite login needed" : s.day === "holiday" ? "Market closed (holiday)" : s.stale ? "Data is stale" : "Kite ✔ live";
  if (s.last_error && !login) state += ` · ${s.last_error}`;
  document.getElementById("st-login").textContent = state;
  const t = s.data_time ? new Date(s.data_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : "no data today";
  document.getElementById("st-data").textContent = `data ${t} IST`;
  document.getElementById("st-next").textContent = s.next_reassessment ? `next reassessment ${s.next_reassessment}` : "";
  const cal = { "uncalibrated": "weights: uncalibrated (run back-test)", "backtest-prior": "weights: back-test prior", "live": "weights: learned from live expiries" };
  document.getElementById("st-cal").textContent = cal[s.calibration] || "";
}

function panelCard(p) {
  const card = el("section", { class: "card", id: `card-${p.key}` });
  const title = el("h2", {}, `${p.underlying} ${LABEL[p.kind]}`);
  const sub = el("div", { class: "sub" }, p.expiry ? `expiry ${p.expiry_label}${p.dte_bucket ? " · " + ({ gt5: "6+ trading days", "2to5": "2–5 trading days", le1: "expiry day / 1 day" })[p.dte_bucket] : ""}` : "waiting for first data");
  card.append(title, sub);
  if (!p.prediction) return card;
  const q = el("div", { class: "quote" });
  q.append(el("span", {}, `Spot ${lv(p.spot)}`), el("span", {}, `Fut ${lv(p.future)}`), el("span", {}, `VIX ${p.vix == null ? "—" : nf2.format(p.vix)}`));
  card.append(q);
  const pr = p.prediction;
  const stamp = (s, withDate) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false,
    hour: "2-digit", minute: "2-digit", ...(withDate ? { day: "2-digit", month: "short" } : {}) });
  const today = (s) => new Date(s).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) === new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  card.append(el("div", { class: "sub" }, `data ${p.data_time ? stamp(p.data_time, !today(p.data_time)) : "—"} · prediction ${stamp(pr.made_at, !today(pr.made_at))} IST`));
  const hl = el("div", { class: "headline" });
  hl.append(el("div", { class: "lbl" }, "Expected settlement"), el("div", { class: "centre" }, lv(pr.centre)));
  const r = el("div", { class: "range" });
  if (pr.band68) {
    r.innerHTML = `<span>68%</span> ${lv(pr.band68[0])}–${lv(pr.band68[1])} &nbsp; <span>90%</span> ${lv(pr.band90[0])}–${lv(pr.band90[1])}`;
  }
  hl.append(r);
  if (pr.note) hl.append(el("div", { class: "note" }, pr.note));
  card.append(hl);
  const s = p.signals;
  const dl = el("dl");
  const row = (k, v) => { dl.append(el("dt", {}, k), el("dd", {}, v)); };
  row("Supports", p.supports.map(lv).join(" · ") || "—");
  row("Resistances", p.resistances.map(lv).join(" · ") || "—");
  row("Max pain", lv(s.max_pain));
  row("PCR (near ATM)", s.pcr_atm == null ? "—" : `${nf2.format(s.pcr_atm)} (total ${nf2.format(s.pcr_total)})`);
  row("ATM IV", s.atm_iv == null ? "—" : `${nf2.format(s.atm_iv * 100)}% · ±${lv(s.sigma_remaining)} pts 1σ`);
  const probs = pr.probs_above.filter(([k]) => p.supports.includes(k) || p.resistances.includes(k));
  row("P(settle above)", probs.map(([k, v]) => `${lv(k)}: ${pct(v)}`).join(" · ") || "—");
  card.append(dl);

  const mode = oiMode[p.key] || "oi";
  const head = el("div", { class: "chart-head" });
  head.append(el("span", {}, mode === "oi" ? "Open interest by strike" : "OI change since previous close"));
  const tg = el("span", { class: "toggle" });
  for (const [m, label] of [["oi", "OI"], ["chg", "Change"]]) {
    const b = el("button", { type: "button", class: m === mode ? "on" : "" }, label);
    b.onclick = () => { oiMode[p.key] = m; refresh(); };
    tg.append(b);
  }
  head.append(tg);
  card.append(head);
  const c1 = el("div", { class: "chart" }); const cv1 = el("canvas", { "aria-label": `${p.key} open interest chart`, role: "img" }); c1.append(cv1);
  card.append(c1);
  card.append(el("div", { class: "chart-head" }, "Prediction through the series (locked reassessments)"));
  const c2 = el("div", { class: "chart" }); const cv2 = el("canvas", { "aria-label": `${p.key} prediction drift chart`, role: "img" }); c2.append(cv2);
  card.append(c2);

  const log = el("div", { class: "log" });
  if (!p.log.length) log.append(el("div", { class: "muted" }, "No locked reassessment yet (09:45 / 12:30 / 15:05)."));
  for (const e of p.log.slice(0, 12)) {
    const d = el("div");
    d.innerHTML = `<b>${e.time}</b> ${lv(e.centre)} — `;
    d.append(el("span", { class: e.changed ? "chg" : "muted" }, e.reason));
    log.append(d);
  }
  card.append(log);
  requestAnimationFrame(() => drawCharts(p, cv1, cv2, mode));
  return card;
}

const spotLine = {
  id: "spotLine",
  afterDatasetsDraw(chart, _a, opts) {
    if (opts.index == null || opts.index < 0) return;
    const x = chart.scales.x.getPixelForValue(opts.index);
    const { top, bottom } = chart.chartArea; const ctx = chart.ctx;
    ctx.save(); ctx.strokeStyle = css("--text-3"); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = css("--text-2"); ctx.font = "11px system-ui"; ctx.fillText("Spot", x + 4, top + 10);
    ctx.restore();
  },
};

function baseOpts() {
  const grid = css("--grid"), tick = css("--text-2");
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { color: tick, boxWidth: 10, boxHeight: 10 } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? "—" : nf0.format(c.parsed.y)}` } } },
    scales: { x: { grid: { display: false }, ticks: { color: tick, maxRotation: 0, autoSkipPadding: 8 } },
      y: { grid: { color: grid }, border: { display: false }, ticks: { color: tick, callback: (v) => nf0.format(v) } } },
  };
}

function drawCharts(p, cv1, cv2, mode) {
  for (const k of [`${p.key}-oi`, `${p.key}-drift`]) if (charts[k]) charts[k].destroy();
  const o = p.oi_chart;
  const spotIdx = o.strikes.length ? o.strikes.reduce((bi, k, i) => (Math.abs(k - p.spot) < Math.abs(o.strikes[bi] - p.spot) ? i : bi), 0) : -1;
  const ce = mode === "oi" ? o.ce_oi : o.ce_chg, pe = mode === "oi" ? o.pe_oi : o.pe_chg;
  const opts1 = baseOpts();
  opts1.plugins.spotLine = { index: spotIdx };
  charts[`${p.key}-oi`] = new Chart(cv1, {
    type: "bar", plugins: [spotLine],
    data: { labels: o.strikes.map(lv), datasets: [
      { label: "Calls (CE)", data: ce, backgroundColor: css("--ce"), borderRadius: 2, borderSkipped: "start", categoryPercentage: .8, barPercentage: .9 },
      { label: "Puts (PE)", data: pe, backgroundColor: css("--pe"), borderRadius: 2, borderSkipped: "start", categoryPercentage: .8, barPercentage: .9 }] },
    options: opts1,
  });
  const d = p.drift;
  charts[`${p.key}-drift`] = new Chart(cv2, {
    type: "line",
    data: { labels: d.map((x) => x.time), datasets: [
      { label: "68% low", data: d.map((x) => x.lo68), borderWidth: 0, pointRadius: 0, fill: false },
      { label: "68% band", data: d.map((x) => x.hi68), borderWidth: 0, pointRadius: 0, backgroundColor: css("--band"), fill: "-1" },
      { label: "Expected settlement", data: d.map((x) => x.centre), borderColor: css("--ce"), backgroundColor: css("--ce"), borderWidth: 2, pointRadius: 4 },
      { label: "Futures-implied", data: d.map((x) => x.forward), borderColor: css("--fwd"), borderDash: [5, 4], borderWidth: 2, pointRadius: 0 }] },
    options: (() => { const op = baseOpts(); op.plugins.legend.labels.filter = (i) => i.text !== "68% low"; return op; })(),
  });
}

function renderTrack(tr) {
  const wrap = document.getElementById("track"); wrap.innerHTML = "";
  const t = el("table");
  t.innerHTML = "<tr><th>Index</th><th>Expiries</th><th>Mean error</th><th>Futures baseline</th><th>Within ±0.5%</th><th>Within ±1%</th><th>68% band hit</th><th>90% band hit</th></tr>";
  const fmt = (x) => (x == null ? "—" : `${nf2.format(x)}%`);
  for (const [name, r] of Object.entries(tr)) {
    if (name === "weights") continue;
    const tr_ = el("tr");
    tr_.innerHTML = `<td>${name}</td><td>${r.expiries}</td><td>${fmt(r.mean_abs_err_pct)}</td><td>${fmt(r.forward_mean_abs_err_pct)}</td><td>${pct(r.within_0_5pct)}</td><td>${pct(r.within_1pct)}</td><td>${pct(r.cov68)}</td><td>${pct(r.cov90)}</td>`;
    t.append(tr_);
  }
  wrap.append(t);
  for (const [name, r] of Object.entries(tr)) {
    if (name === "weights" || r.beats_baseline == null) continue;
    wrap.append(el("p", { class: "verdict" }, r.beats_baseline ? `${name}: beating the plain futures price.` : `${name}: NOT beating the plain futures price yet — treat the signals with caution.`));
  }
  if (Object.entries(tr).every(([n, r]) => n === "weights" || !r.expiries)) wrap.append(el("p", { class: "muted" }, "No settled expiries yet. The record starts after the first expiry closes."));
}

function renderWeights(w) {
  const wrap = document.getElementById("weights"); wrap.innerHTML = "";
  const names = Object.keys(SIGNAL_LABEL);
  const t = el("table");
  t.innerHTML = `<tr><th>Index · stage</th>${names.map((n) => `<th>${SIGNAL_LABEL[n]}</th>`).join("")}<th>Source</th></tr>`;
  const stage = { gt5: "6+ days", "2to5": "2–5 days", le1: "last day" };
  for (const [name, buckets] of Object.entries(w)) for (const [b, ws] of Object.entries(buckets)) {
    const r = el("tr");
    r.innerHTML = `<td>${name} · ${stage[b]}</td>${names.map((n) => `<td>${ws.weights[n] == null ? "—" : pct(ws.weights[n])}</td>`).join("")}<td>${ws.source}</td>`;
    t.append(r);
  }
  wrap.append(t);
}

function renderGaps(g) {
  const wrap = document.getElementById("gaps");
  wrap.textContent = g.length ? "" : "None.";
  for (const x of g) {
    const t = (s) => new Date(s).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
    wrap.append(el("div", {}, `${x.what}: ${t(x.start)}${x.end ? "–" + t(x.end) : ""}`));
  }
}

async function refresh() {
  try {
    const st = await (await fetch("/api/state", { cache: "no-store" })).json();
    renderStatus(st.status);
    const box = document.getElementById("panels"); box.innerHTML = "";
    for (const p of st.panels) box.append(panelCard(p));
    renderTrack(st.track_record);
    renderWeights(st.track_record.weights);
    renderGaps(st.gaps);
  } catch (e) {
    document.getElementById("st-login").textContent = "Dashboard server not reachable";
    document.getElementById("status").classList.add("alert");
  }
}
refresh();
setInterval(refresh, 60000);
