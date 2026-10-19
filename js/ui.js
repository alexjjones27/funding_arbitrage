/* Rendering: header status, controls, KPI strip, opportunities table, detail, funding matrix,
 * venue panel, alerts and settings. */
(function () {
  'use strict';
  const FAS = window.FAS;
  const E = FAS.engine;
  const f = FAS.fmt;
  const esc = FAS.esc;
  const isNum = FAS.isNum;
  const $ = (id) => document.getElementById(id);
  const U = (FAS.ui = {});
  const S = () => FAS.state;
  const set = () => FAS.state.settings;

  const STRUCT = { perp: 'Perp-perp', carry: 'Cash-and-carry', reverse: 'Reverse carry' };
  const STRUCT_SHORT = { perp: 'P/P', carry: 'C&C', reverse: 'Rev' };
  U.structName = (s) => STRUCT[s] || s;
  const vname = (v) => (FAS.venues[v] ? FAS.venues[v].name : v);
  const signCls = (x) => (isNum(x) ? (x > 0 ? 'pos' : x < 0 ? 'neg' : '') : 'muted');

  // ------------------------------------------------------------ table columns
  const legCell = (leg) => {
    const m = leg.m;
    if (leg.kind === 'spot') return `<span class="venue">${esc(vname(m.venue))}</span> <span class="muted">spot</span>`;
    const r8 = E.norm8(m.rate, m.intervalH) * 1e4;
    return `<span class="venue">${esc(vname(m.venue))}</span> <span class="${signCls(r8)}">${f.bps(r8, 2)}</span> <span class="muted">${m.intervalH}h</span>`;
  };
  const COLS = [
    { k: 'base', label: 'Asset', get: (o) => o.base, html: (o) => `<b>${esc(o.base)}</b>`, cls: 'l' },
    { k: 'structure', label: 'Type', title: 'P/P perp-perp across venues; C&C long spot short perp; Rev short spot long perp', get: (o) => o.structure, html: (o) => `<span class="tag t-${o.structure}">${STRUCT_SHORT[o.structure]}</span>`, cls: 'l' },
    { k: 'long', label: 'Long leg', title: 'Venue, current funding in bps per 8h, native interval', get: (o) => o.long.m.venue, html: (o) => legCell(o.long), cls: 'l' },
    { k: 'short', label: 'Short leg', get: (o) => o.short.m.venue, html: (o) => legCell(o.short), cls: 'l' },
    { k: 'grossBps8', label: 'Gross bps/8h', title: 'Funding received minus funding paid, 8h-equivalent, on the carry estimate chosen in the toolbar', get: (o) => o.grossBps8, html: (o) => f.bps(o.grossBps8, 2) },
    { k: 'grossApr', label: 'Gross APR', get: (o) => o.grossApr, html: (o) => f.pct(o.grossApr) },
    { k: 'costRtBps', label: 'RT cost bps', title: 'Round trip: entry and exit on both legs, fees plus slippage at your size', get: (o) => o.costRtBps, html: (o) => `${f.bps(o.costRtBps)}${o.booksLoaded ? '' : '<sup title="Slippage from top of book or assumed until the order book loads">*</sup>'}` },
    { k: 'beBps8', label: 'B/E bps/8h', title: 'Spread needed per 8h to cover costs and borrow over the holding period', get: (o) => o.beBps8, html: (o) => f.bps(o.beBps8, 2) },
    { k: 'netApr', label: 'Net APR', title: 'Annualized net carry over the holding period, on notional', get: (o) => o.netApr, html: (o) => `<b class="${signCls(o.netApr)}">${f.pct(o.netApr)}</b>` },
    { k: 'rocApr', label: 'ROC APR', title: 'Net APR on the capital both legs tie up (spot plus perp margin)', get: (o) => o.rocApr, html: (o) => f.pct(o.rocApr) },
    { k: 'pnl1', label: 'P&L 1d', get: (o) => o.pnl1, html: (o) => `<span class="${signCls(o.pnl1)}">${f.pnl(o.pnl1)}</span>` },
    { k: 'pnl7', label: '7d', get: (o) => o.pnl7, html: (o) => `<span class="${signCls(o.pnl7)}">${f.pnl(o.pnl7)}</span>` },
    { k: 'pnl30', label: '30d', get: (o) => o.pnl30, html: (o) => `<span class="${signCls(o.pnl30)}">${f.pnl(o.pnl30)}</span>` },
    { k: 'consec', label: 'Streak', title: 'Consecutive favorable 8h windows (spread above the persistence threshold)', get: (o) => (o.persist ? o.persist.consec : -1), html: (o) => (o.persist ? String(o.persist.consec) : pend(o)) },
    { k: 'pct7d', label: '% 7d', title: 'Share of 8h windows in the last 7 days above the threshold', get: (o) => (o.persist ? o.persist.pct7d : -1), html: (o) => (o.persist ? f.pct(o.persist.pct7d * 100, 0) : pend(o)) },
    { k: 'z', label: 'z', title: 'Latest 8h spread versus its trailing 30-day median (robust z)', get: (o) => (o.persist && isNum(o.persist.z) ? o.persist.z : -99), html: (o) => (o.persist ? f.num(o.persist.z, 1) : pend(o)) },
    { k: 'minOiUsd', label: 'Min OI', title: 'Open interest of the thinner perp leg', get: (o) => o.minOiUsd ?? -1, html: (o) => f.usd(o.minOiUsd) },
    { k: 'minVolUsd', label: 'Min vol', title: '24h notional volume of the thinner leg', get: (o) => o.minVolUsd ?? -1, html: (o) => f.usd(o.minVolUsd) },
    { k: 'maxSlipBps', label: 'Slip bps', title: 'Worst leg entry slippage vs mid at your notional (order book)', get: (o) => o.maxSlipBps, html: (o) => (o.maxSlipBps === Infinity ? '<span class="neg">depth</span>' : o.booksLoaded ? f.bps(o.maxSlipBps, 1) : '<span class="muted">' + f.bps(o.maxSlipBps, 1) + '*</span>') },
    { k: 'liqDistPct', label: 'Liq dist', title: 'Adverse move that liquidates the weaker perp leg at your leverage (isolated)', get: (o) => o.liqDistPct, html: (o) => f.pct(o.liqDistPct) + (isNum(o.liqSigma) ? ` <span class="muted">${o.liqSigma.toFixed(1)}σ</span>` : '') },
    { k: 'basisBps', label: 'Basis bps', title: 'Price of the short leg minus the long leg, per unit of underlying. Positive is a favorable entry', get: (o) => o.basisBps, html: (o) => `<span class="${Math.abs(o.basisBps || 0) > set().basisAlertBps ? 'warn-t' : ''}">${f.bps(o.basisBps, 1)}</span>` },
    { k: 'toSettleMs', label: 'Next', title: 'Time to the next settlement on either perp leg', get: (o) => o.toSettleMs ?? 9e15, html: (o) => f.dur(o.toSettleMs) },
    { k: 'conditionsMet', label: 'Alert', title: 'Alert conditions met (all must pass)', get: (o) => o.conditionsMet, html: (o) => `<span class="cond ${o.alertable ? 'ok' : ''}">${o.conditionsMet}/${o.conditions.length}</span>` },
    { k: 'flags', label: 'Flags', get: (o) => o.flags.length, html: (o) => o.flags.map((x) => `<span class="flag f-${x.level}">${esc(x.label)}</span>`).join(''), cls: 'l flags' },
    { k: 'score', label: 'Score', title: 'w1·net APR + w2·persistence + w3·liquidity + w4·feasibility − w5·risk penalties', get: (o) => o.score, html: (o) => `<b>${f.num(o.score, 0)}</b>` },
  ];
  function pend(o) {
    const keys = [o.long, o.short].filter((l) => l.kind === 'perp').map((l) => 'h:' + E.key(l.m));
    return keys.some((k) => S().pending.has(k)) ? '<span class="muted">…</span>' : '<span class="muted">–</span>';
  }

  // ------------------------------------------------------------ init
  U.init = function () {
    const s = set();
    applyTheme(s.theme);
    $('themeBtn').onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      s.theme = cur === 'dark' ? 'light' : 'dark';
      applyTheme(s.theme);
      FAS.saveSettings();
      U.render();
    };
    $('refreshBtn').onclick = () => FAS.refresh();
    $('settingsBtn').onclick = () => toggleSettings(true);
    $('settingsClose').onclick = () => toggleSettings(false);
    $('clearAlerts').onclick = () => { S().alerts = []; FAS.store.set('alerts', []); U.render(); };

    seg('structSeg', [['all', 'All'], ['perp', 'Perp-perp'], ['carry', 'Cash-and-carry'], ['reverse', 'Reverse carry']], () => s.structureFilter, (v) => { s.structureFilter = v; });
    seg('tabSeg', [['opps', 'Opportunities'], ['matrix', 'Funding matrix'], ['venues', 'Venues & method']], () => s.tab, (v) => { s.tab = v; });

    const notional = $('notional');
    notional.value = s.notional;
    notional.onchange = () => { const v = +notional.value; if (v > 0) { s.notional = v; changed(true); } };
    const hold = $('hold');
    hold.value = s.holdDays;
    hold.onchange = () => { const v = +hold.value; if (v > 0) { s.holdDays = v; changed(); } };
    const basis = $('basis');
    basis.value = s.carryBasis;
    basis.onchange = () => { s.carryBasis = basis.value; changed(); };
    const search = $('search');
    search.value = s.search || '';
    search.oninput = () => { s.search = search.value.trim().toUpperCase(); U.render(); };
    for (const id of ['hideIlliquid', 'hideNegative', 'alertableOnly', 'bestPairOnly']) {
      const el = $(id);
      el.checked = !!s[id];
      el.onchange = () => { s[id] = el.checked; changed(id === 'bestPairOnly'); };
    }

    $('main').addEventListener('click', (ev) => {
      const th = ev.target.closest('th[data-k]');
      if (th) {
        const k = th.dataset.k;
        if (s.sortKey === k) s.sortDir = -s.sortDir; else { s.sortKey = k; s.sortDir = ['base', 'structure', 'long', 'short', 'toSettleMs', 'costRtBps', 'beBps8', 'maxSlipBps'].includes(k) ? 1 : -1; }
        FAS.saveSettings();
        U.render();
        return;
      }
      const tr = ev.target.closest('tr[data-key]');
      if (tr) {
        S().selected = tr.dataset.key;
        U.render();
        FAS.enrich();
        if (matchMedia('(max-width: 1100px)').matches) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      const mt = ev.target.closest('tr[data-base]');
      if (mt) {
        s.search = mt.dataset.base;
        $('search').value = s.search;
        s.tab = 'opps';
        U.render();
      }
    });
    $('alerts').addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-key]');
      if (!li) return;
      S().selected = li.dataset.key;
      s.tab = 'opps';
      U.render();
      FAS.enrich();
    });
    buildSettings();
    U.render();
  };

  function changed(rebuild) {
    FAS.saveSettings();
    FAS.recompute(true);
    if (rebuild) FAS.enrich();
  }

  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }

  function seg(id, opts, get, put) {
    const el = $(id);
    el.innerHTML = opts.map(([v, l]) => `<button type="button" role="radio" data-v="${v}">${l}</button>`).join('');
    const sync = () => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === get())));
    el.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      put(b.dataset.v);
      FAS.saveSettings();
      sync();
      U.render();
    };
    sync();
    U['sync_' + id] = sync;
  }

  // ------------------------------------------------------------ header status
  U.status = function () {
    const st = S();
    $('clock').textContent = new Date().toISOString().slice(11, 19) + 'Z';
    const pills = FAS.venueOrder.map((v) => {
      if (set().venues[v] === false) return `<span class="pill off" title="Disabled in Settings">${vname(v)}</span>`;
      const sn = st.snap[v];
      const h = FAS.health[v] || {};
      let cls = 'wait', tip = 'Loading';
      if (sn && sn.mode === 'live') {
        cls = sn.err ? 'warn' : 'ok';
        tip = `${(sn.perps || []).length} perps, ${(sn.spots || []).length} spot pairs. Updated ${f.ago(sn.t)}${sn.err ? '. Last error: ' + sn.err : ''}`;
      } else if (sn && sn.mode === 'rate-only') {
        cls = 'warn';
        tip = `${h.blocked ? 'Blocked from this location' : 'Unreachable'}; ${(sn.perps || []).length} funding rates via Hyperliquid (no OI, volume or book)`;
      } else if (sn && sn.mode === 'down') {
        cls = 'bad';
        tip = sn.err || 'Unreachable';
      }
      const label = sn && sn.mode === 'rate-only' ? vname(v) + ' (rates)' : vname(v);
      return `<span class="pill ${cls}" title="${esc(tip)}">${label}</span>`;
    }).join('');
    if ($('venuePills').dataset.html !== pills) { $('venuePills').innerHTML = pills; $('venuePills').dataset.html = pills; }
    const pend = st.pending.size;
    $('syncStatus').textContent = st.busy ? 'Refreshing…' : st.lastSnap ? `Snapshot ${f.ago(st.lastSnap)}${pend ? ` · loading ${pend}` : ''}` : 'Loading…';
  };

  // ------------------------------------------------------------ render
  U.render = function () {
    const s = set();
    U.sync_structSeg && U.sync_structSeg();
    U.sync_tabSeg && U.sync_tabSeg();
    U.status();
    renderKpis();
    const rows = visibleOpps();
    $('oppView').hidden = s.tab !== 'opps';
    $('matrixView').hidden = s.tab !== 'matrix';
    $('venueView').hidden = s.tab !== 'venues';
    $('oppControls').hidden = s.tab !== 'opps';
    if (s.tab === 'opps') renderTable(rows);
    if (s.tab === 'matrix') renderMatrix();
    if (s.tab === 'venues') renderVenues();
    renderDetail();
    renderAlerts();
  };

  U.failsLiquidity = failsLiquidity;
  function failsLiquidity(o) {
    return o.liq.some((x) => x.oiOk === false || x.volOk === false || x.spreadOk === false || x.slipOk === false) || o.maxSlipBps === Infinity;
  }
  function visibleOpps() {
    const s = set();
    let rows = S().opps || [];
    if (s.structureFilter !== 'all') rows = rows.filter((o) => o.structure === s.structureFilter);
    if (s.search) rows = rows.filter((o) => o.base.includes(s.search) || o.long.m.venue.toUpperCase().includes(s.search) || o.short.m.venue.toUpperCase().includes(s.search));
    if (s.hideIlliquid) rows = rows.filter((o) => !failsLiquidity(o));
    if (s.hideNegative) rows = rows.filter((o) => o.netApr > 0);
    if (s.alertableOnly) rows = rows.filter((o) => o.alertable);
    const col = COLS.find((c) => c.k === s.sortKey) || COLS[COLS.length - 1];
    const dir = s.sortDir;
    return rows.slice().sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      if (typeof x === 'string') return dir * x.localeCompare(y);
      return dir * ((isNum(x) ? x : -Infinity) - (isNum(y) ? y : -Infinity));
    });
  }

  function renderKpis() {
    const st = S();
    const opps = st.opps || [];
    const multi = (st.matrix || []).filter((r) => r.n >= 2);
    const clean = opps.filter((o) => !failsLiquidity(o) && o.netApr > 0);
    const alertable = opps.filter((o) => o.alertable);
    const best = clean.slice().sort((a, b) => b.netApr - a.netApr)[0];
    const spreads = multi.map((r) => r.spread8 * 1e4).filter(isNum);
    const k = [
      ['Perp markets', String(st.perps.length), `${new Set(st.perps.map((m) => m.base)).size} assets`],
      ['Listed on 2+ venues', String(multi.length), 'assets with a cross-venue pair'],
      ['Top-decile max-min spread', f.bps(quantile(spreads, 0.9), 2) + ' bps', `per 8h, current rates; median ${f.bps(FAS.stats.median(spreads), 2)}`],
      ['Net-positive and liquid', String(clean.length), `of ${opps.length} evaluated${st.excluded ? `, ${st.excluded} pairs dropped for price mismatch` : ''}`],
      ['Alertable now', String(alertable.length), 'all alert conditions met'],
      ['Best net APR', best ? f.pct(best.netApr) : '–', best ? `${best.base} ${STRUCT_SHORT[best.structure]} ${vname(best.long.m.venue)} / ${vname(best.short.m.venue)}` : ''],
    ];
    $('kpis').innerHTML = k.map(([l, v, sub]) => `<div class="kpi"><div class="kpi-l">${l}</div><div class="kpi-v">${v}</div><div class="kpi-s">${esc(sub)}</div></div>`).join('');
  }

  function quantile(a, q) {
    const v = a.slice().sort((x, y) => x - y);
    return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null;
  }

  function renderTable(rows) {
    const s = set();
    $('tableSub').textContent = `${rows.length} rows · ${f.usd(s.notional)} per leg · ${s.holdDays}d hold · carry estimate: ${basisLabel(s.carryBasis)} · * slippage not yet from the order book`;
    $('gridHead').innerHTML = '<tr>' + COLS.map((c) => `<th data-k="${c.k}" class="${c.cls || ''}${s.sortKey === c.k ? ' sorted' : ''}" title="${esc(c.title || '')}" aria-sort="${s.sortKey === c.k ? (s.sortDir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}${s.sortKey === c.k ? (s.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
    const shown = rows.slice(0, 250);
    $('gridBody').innerHTML = shown.length
      ? shown.map((o) => `<tr data-key="${esc(o.key)}" class="${o.key === S().selected ? 'sel' : ''}${o.alertable ? ' alertable' : ''}">${COLS.map((c) => `<td class="${c.cls || ''}">${c.html(o)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${COLS.length}" class="empty">${S().lastSnap ? 'Nothing passes the current filters. Loosen them in the toolbar or Settings.' : 'Loading venue snapshots…'}</td></tr>`;
  }
  function basisLabel(b) { return { current: 'current rate', predicted: 'predicted next', mean7: '7d mean', blend: 'blend of next and 7d mean' }[b] || b; }

  // ------------------------------------------------------------ detail
  function renderDetail() {
    const el = $('detail');
    const st = S();
    const s = set();
    const o = (st.opps || []).find((x) => x.key === st.selected);
    if (!o) {
      el.innerHTML = '<div class="card-head"><h2>Detail</h2></div><p class="empty">Select a row to see both legs, costs, persistence, margin and comparability.</p>';
      return;
    }
    const L = o.long, Sh = o.short;
    const legs = [L, Sh];
    const p = o.persist;
    const legStat = (leg) => (leg.kind === 'perp' && st.hist[E.key(leg.m)] ? E.legStats(st.hist[E.key(leg.m)].rows, leg.m) : null);
    const ls = legs.map(legStat);
    const row = (label, fn, title) => `<tr${title ? ` title="${esc(title)}"` : ''}><th>${label}</th>${legs.map((l, i) => `<td>${fn(l, i)}</td>`).join('')}</tr>`;
    const perpOnly = (fn) => (l, i) => (l.kind === 'perp' ? fn(l.m, l, i) : '<span class="muted">spot</span>');
    const prem = (m) => (isNum(m.mark) && isNum(m.index) && m.index ? ((m.mark - m.index) / m.index) * 1e4 : null);
    const depthCell = (l, b) => {
      const d = l.cost.depth && l.cost.depth.find((x) => x.bps === b);
      if (!d) return '<span class="muted">–</span>';
      return `${f.usd(d.bid)} / ${f.usd(d.ask)}${d.complete ? '' : '<sup title="Book returned by the venue ends inside this band">+</sup>'}`;
    };
    const fee = (l) => {
      const fe = s.fees[l.m.venue] || {};
      return l.kind === 'spot' ? `${f.num(fe.spotTaker, 3)}% / ${f.num(fe.spotMaker, 3)}%` : `${f.num(fe.perpTaker, 3)}% / ${f.num(fe.perpMaker, 3)}%`;
    };

    const cond = o.conditions.map((c) => `<li class="${c.pass === true ? 'ok' : c.pass === false ? 'no' : 'na'}"><span class="mk">${c.pass === true ? '✓' : c.pass === false ? '✕' : '…'}</span><b>${esc(c.label)}</b><span class="muted"> ${esc(c.detail)}</span></li>`).join('');
    const checks = o.checks.map((c) => `<li class="${c.level}"><span class="lvl">${c.level}</span><b>${esc(c.name)}</b> <span class="muted">${esc(c.text)}</span></li>`).join('');
    const comp = o.components;
    const w = s.weights;

    const econ = [
      ['Gross spread (estimate)', `${f.bps(o.grossBps8, 2)} bps/8h · ${f.pct(o.grossApr)} APR`],
      ['Current / predicted', `${f.bps(o.grossCur8 * 1e4, 2)} / ${f.bps(o.grossPred8 * 1e4, 2)} bps/8h`],
      ['Round-trip cost', `${f.bps(o.costRtBps, 1)} bps (fees ${f.bps(legs.reduce((a, l) => a + 2 * l.cost.feeOne, 0) * 1e4, 1)}, slippage ${f.bps(o.costRtBps - legs.reduce((a, l) => a + 2 * l.cost.feeOne, 0) * 1e4, 1)})`],
      o.structure === 'reverse' ? ['Borrow cost', `${f.pct(o.borrowApr)} APR (${esc(o.borrowSrc)})`] : null,
      o.structure === 'carry' && s.capitalCostAprPct ? ['Capital cost', f.pct(s.capitalCostAprPct) + ' APR on the spot leg'] : null,
      ['Break-even', `${f.bps(o.beBps8, 2)} bps/8h over ${s.holdDays}d · ${isFinite(o.breakEvenDays) ? f.num(o.breakEvenDays, 1) + ' days to recoup costs' : 'never at this spread'}`],
      ['Net over hold', `${f.bps(o.netBps8, 2)} bps/8h · <b class="${signCls(o.netApr)}">${f.pct(o.netApr)}</b> APR on notional · ${f.pct(o.rocApr)} on capital`],
      ['Expected P&L', `1d ${f.pnl(o.pnl1)} · 7d ${f.pnl(o.pnl7)} · 30d ${f.pnl(o.pnl30)} on ${f.usd(s.notional)}`],
      ['Capital tied up', `${f.usd(o.capital)} (${o.structure === 'perp' ? 'margin on both venues' : o.structure === 'carry' ? 'spot plus perp margin' : 'perp margin plus spot-short collateral'})`],
    ].filter(Boolean).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');

    const pRows = p ? [
      ['Streak (8h windows)', `${p.consec} favorable${p.consecNeg ? ` · last ${p.consecNeg} unfavorable` : ''}`],
      ['Above threshold', `24h ${f.pct(p.pct24 * 100, 0)} · 48h ${f.pct(p.pct48 * 100, 0)} · 7d ${f.pct(p.pct7d * 100, 0)}`],
      ['Mean bps/8h', `7d ${f.bps(p.mean7 * 1e4, 2)} · 14d ${f.bps(p.mean14 * 1e4, 2)} · 30d ${f.bps(p.mean30 * 1e4, 2)}`],
      ['Median bps/8h', `7d ${f.bps(p.med7 * 1e4, 2)} · 30d ${f.bps(p.med30 * 1e4, 2)}`],
      ['Std dev bps/8h', `7d ${f.bps(p.std7 * 1e4, 2)} · 30d ${f.bps(p.std30 * 1e4, 2)}${isNum(p.cv) ? ` · CV ${p.cv.toFixed(2)}` : ''}`],
      ['Latest vs median', `${f.bps(p.last * 1e4, 2)} bps · z ${f.num(p.z, 1)}`],
      ['Cumulative', `7d ${f.bps(p.cum7 * 1e4, 1)} bps · 30d ${f.bps(p.cum30 * 1e4, 1)} bps (${p.n} windows)`],
    ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('') : `<tr><td class="muted">${pend(o) === '<span class="muted">…</span>' ? 'Loading funding history…' : 'History loads for the top ' + s.enrichN + ' rows and the selected row.'}</td></tr>`;

    el.innerHTML = `
      <div class="card-head">
        <h2>${esc(o.base)} · ${STRUCT[o.structure]}</h2>
        <span class="sub">long ${esc(vname(L.m.venue))} ${L.kind}, short ${esc(vname(Sh.m.venue))} ${Sh.kind}</span>
        <span class="score-pill ${o.alertable ? 'ok' : ''}">Score ${f.num(o.score, 0)}${o.alertable ? ' · alertable' : ''}</span>
      </div>
      <div class="detail-grid">
        <section><h3>Alert conditions</h3><ul class="conds">${cond}</ul></section>
        <section><h3>Economics</h3><table class="kv">${econ}</table></section>
        <section class="wide"><h3>Funding history <span class="muted">bps per 8h; bars = trade's net funding per 8h window, lines = each perp leg</span></h3><div id="fundChart" class="chart"></div>
          <div class="legend">${legs.filter((l) => l.kind === 'perp').map((l) => `<span><i class="sw ${l.side}"></i>${esc(vname(l.m.venue))} (${l.side})</span>`).join('')}<span><i class="sw bar"></i>net spread</span><span><i class="sw thr"></i>threshold</span></div>
        </section>
        <section class="wide"><h3>Legs</h3>
          <div class="table-scroll"><table class="legs">
            <tr><th></th>${legs.map((l) => `<th>${l.side === 'long' ? 'Long' : 'Short'} · ${esc(vname(l.m.venue))}</th>`).join('')}</tr>
            ${row('Symbol', (l) => `${esc(l.m.id)} <span class="muted">${l.kind === 'spot' ? 'spot' : l.m.type}${l.m.mult !== 1 ? ' · ' + l.m.mult + 'x' : ''}</span>`)}
            ${row('Quote / collateral', (l) => esc(l.m.quote))}
            ${row('Funding interval', perpOnly((m) => m.intervalH + 'h'))}
            ${row('Current rate', perpOnly((m) => `${f.rate(m.rate)} <span class="muted">${f.bps(E.norm8(m.rate, m.intervalH) * 1e4, 2)} bps/8h · ${f.pct(E.apr(E.norm8(m.rate, m.intervalH)))}</span>`))}
            ${row('Predicted next', perpOnly((m) => (isNum(m.predicted) ? `${f.rate(m.predicted)} <span class="muted">${f.bps(E.norm8(m.predicted, m.intervalH) * 1e4, 2)} bps/8h</span>` : '<span class="muted">not published</span>')))}
            ${row('Last settled', perpOnly((m, l, i) => { const rows = st.hist[E.key(m)]; const last = rows && rows.rows.length ? rows.rows[rows.rows.length - 1] : null; return isNum(m.lastSettled) ? f.rate(m.lastSettled) : last ? `${f.rate(last.r)} <span class="muted">${f.time(last.t)}</span>` : (ls[i] ? '–' : '<span class="muted">–</span>'); }))}
            ${row('Next settlement', perpOnly((m) => `${f.time(m.nextTs)} <span class="muted">in ${f.dur(m.nextTs - Date.now())}</span>`))}
            ${row('Funding cap', perpOnly((m) => (isNum(m.capRate) ? '±' + f.rate(m.capRate) : '–')))}
            ${row('Mean bps/8h: last 3 / 7d / 14d / 30d', (l, i) => (ls[i] ? `${f.bps(ls[i].last3 * 1e4, 2)} / ${f.bps(ls[i].mean7 * 1e4, 2)} / ${f.bps(ls[i].mean14 * 1e4, 2)} / ${f.bps(ls[i].mean30 * 1e4, 2)}` : '<span class="muted">' + (l.kind === 'spot' ? 'spot' : '–') + '</span>'))}
            ${row('Cumulative funding 1d / 7d / 30d', (l, i) => (ls[i] ? `${f.bps(ls[i].cum1 * 1e4, 1)} / ${f.bps(ls[i].cum7 * 1e4, 1)} / ${f.bps(ls[i].cum30 * 1e4, 1)} bps` : '<span class="muted">–</span>'), 'Sum of settled rates; positive means longs paid shorts')}
            ${row('Mark / index', (l) => (l.kind === 'perp' ? `${f.px(l.m.mark)} / ${f.px(l.m.index)} <span class="muted">${f.bps(prem(l.m), 1)} bps</span>` : `${f.px(l.m.bid)} / ${f.px(l.m.ask)} <span class="muted">bid / ask</span>`))}
            ${row('Open interest', perpOnly((m) => f.usd(m.oiUsd) + (isNum(m.oiUsd) && m.oiUsd > 0 ? ` <span class="muted">size ${f.pct((s.notional / m.oiUsd) * 100, 2)} of OI</span>` : '')))}
            ${row('24h volume', (l) => f.usd(l.m.volUsd))}
            ${row('Spread', (l) => (isNum(l.cost.spreadBps) ? f.bps(l.cost.spreadBps, 2) + ' bps' : '–'))}
            ${row('Slippage in / out', (l) => `${slip(l.cost.slipIn)} / ${slip(l.cost.slipOut)} bps <span class="muted">${l.cost.slipSrc}</span>`, 'Average fill vs mid for your notional: entry and exit')}
            ${FAS.config.depthBandsBps.map((b) => row(`Depth ±${b} bps (bid / ask)`, (l) => depthCell(l, b))).join('')}
            ${row('Fee taker / maker', fee)}
            ${row('Leverage / max', perpOnly((m, l) => `${l.margin.L}x / ${m.maxLev ? m.maxLev + 'x' : '–'}`))}
            ${row('Maintenance margin', perpOnly((m, l) => `${f.pct(l.margin.mmr * 100, 2)} <span class="muted">${l.margin.mmrSrc}</span>`))}
            ${row('Liquidation distance', perpOnly((m, l) => `${f.pct(l.margin.liqDist * 100)}${isNum(l.margin.liqSigma) ? ` <span class="muted">${l.margin.liqSigma.toFixed(1)} daily σ</span>` : ''}`), 'Adverse move that liquidates this leg on its own (isolated margin, no top-up)')}
            ${row('Stressed utilization', perpOnly((m, l) => (l.margin.stressUtil === Infinity ? '<span class="neg">liquidated</span>' : f.pct((l.margin.stressUtil ?? NaN) * 100))), `Maintenance margin / equity after a ${s.stressSigma}σ daily move against the leg`)}
            ${row('Status', (l) => (l.m.status === 'ok' ? '<span class="pos">trading</span>' : `<span class="neg">${esc(l.m.note || l.m.status)}</span>`))}
          </table></div>
        </section>
        <section><h3>Persistence <span class="muted">trade spread, 8h windows</span></h3><table class="kv">${pRows}</table></section>
        <section><h3>Margin and basis</h3><table class="kv">
          <tr><th>Basis between legs</th><td>${f.bps(o.basisBps, 1)} bps <span class="muted">${isNum(o.basisBps) ? (o.basisBps >= 0 ? 'short leg richer: convergence adds to carry' : 'short leg cheaper: convergence costs') : ''}</span></td></tr>
          <tr><th>Daily volatility</th><td>${isNum(o.sigmaD) ? f.pct(o.sigmaD * 100, 2) : '–'} <span class="muted">Parkinson, 24h range</span></td></tr>
          <tr><th>Weakest leg</th><td>liquidates on a ${f.pct(o.liqDistPct)} adverse move${isNum(o.liqSigma) ? ` (${o.liqSigma.toFixed(1)}σ daily)` : ''}</td></tr>
          <tr><th>Stressed utilization</th><td>${o.stressUtil === Infinity ? '<span class="neg">liquidated</span>' : f.pct((o.stressUtil ?? NaN) * 100)} <span class="muted">ceiling ${s.riskCeilingPct}%</span></td></tr>
          <tr><td colspan="2" class="note">${o.structure === 'perp' ? 'The hedge sits on another venue: a move that drains one account credits the other, but the credit cannot meet the margin call until you transfer it. Watch the basis and keep transfer rails ready.' : o.structure === 'carry' ? 'The spot leg cannot be liquidated; the short perp can. Cross margin with spot as collateral (unified accounts) removes most of this risk on the same venue.' : 'Both legs carry liquidation risk: the long perp on a fall and the borrowed spot short on a rally. Borrow can be recalled or repriced.'}</td></tr>
        </table></section>
        <section><h3>Comparability</h3><ul class="checks">${checks}</ul></section>
        <section><h3>Score breakdown</h3><table class="kv">
          <tr><th>Net APR</th><td>${f.num(comp.apr, 2)} × ${w.apr}</td></tr>
          <tr><th>Persistence</th><td>${f.num(comp.persist, 2)} × ${w.persist}</td></tr>
          <tr><th>Liquidity</th><td>${f.num(comp.liq, 2)} × ${w.liq}</td></tr>
          <tr><th>Execution feasibility</th><td>${f.num(comp.feas, 2)} × ${w.feas}</td></tr>
          <tr><th>Risk penalties</th><td>−${f.num(comp.penalty, 2)} × ${w.risk} <span class="muted">${Object.entries(comp.pen).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(', ') || 'none'}</span></td></tr>
          <tr><th>Score</th><td><b>${f.num(o.score, 1)}</b> <span class="muted">scaled to 100 by the positive weights</span></td></tr>
        </table></section>
      </div>`;
    const legSeries = legs.map((l, i) => (ls[i] ? { label: `${vname(l.m.venue)} ${l.side}`, cls: l.side, series: ls[i].series.slice(-90) } : null)).filter(Boolean);
    FAS.charts.funding($('fundChart'), o.series ? o.series.slice(-90) : null, legSeries, s.persistThrBps);
  }
  function slip(x) { return x === Infinity ? '<span class="neg">beyond book</span>' : f.bps(x, 1); }

  // ------------------------------------------------------------ alerts
  function renderAlerts() {
    const list = S().alerts || [];
    $('alertsSub').textContent = set().alertsOn ? `${list.length} logged · 30 min cooldown per opportunity` : 'Alerts off (Settings)';
    $('alerts').innerHTML = list.length
      ? list.slice(0, 80).map((a) => `<li data-key="${esc(a.key)}"><span class="t">${f.date(a.t)}</span> <b>${esc(a.base)}</b> <span class="tag t-${a.structure}">${STRUCT_SHORT[a.structure]}</span> long ${esc(vname(a.long))}, short ${esc(vname(a.short))} · <b class="pos">${f.pct(a.netApr)}</b> net · ${f.bps(a.netBps8, 2)} bps/8h${isNum(a.consec) ? ` · ${a.consec} windows` : ''}</li>`).join('')
      : '<li class="empty">No alerts yet. An alert fires only when every condition holds: net hurdle, persistence, OI and volume, book depth, predicted funding, settlement window, margin and comparability.</li>';
  }

  // ------------------------------------------------------------ funding matrix
  function renderMatrix() {
    const s = set();
    const venues = FAS.venueOrder.filter((v) => s.venues[v] !== false);
    let rows = (S().matrix || []).filter((r) => r.n >= 2);
    if (s.search) rows = rows.filter((r) => r.base.includes(s.search));
    rows.sort((a, b) => (b.spread8 || 0) - (a.spread8 || 0));
    const shown = rows.slice(0, 300);
    $('matrixSub').textContent = `${rows.length} assets on 2+ venues · current rates normalized to bps per 8h · click a row to screen it`;
    $('matrixHead').innerHTML = `<tr><th class="l">Asset</th>${venues.map((v) => `<th>${vname(v)}</th>`).join('')}<th>Max-min</th><th>APR</th><th>Total OI</th></tr>`;
    $('matrixBody').innerHTML = shown.map((r) => {
      const cells = venues.map((v) => {
        const c = r.cells[v];
        if (!c) return '<td class="muted">·</td>';
        const b = c.r8 * 1e4;
        const a = Math.min(1, Math.abs(b) / 10);
        const bg = b >= 0 ? `rgba(var(--pos-rgb), ${(0.08 + 0.5 * a).toFixed(2)})` : `rgba(var(--neg-rgb), ${(0.08 + 0.5 * a).toFixed(2)})`;
        const hiLo = c.r8 === r.max ? ' hi' : c.r8 === r.min ? ' lo' : '';
        const tip = `${c.m.id}: ${f.rate(c.m.rate)} per ${c.m.intervalH}h, ${f.pct(c.apr)} APR, next ${f.time(c.m.nextTs)}${c.m.rateOnly ? ' (rate only)' : ''}`;
        return `<td class="cell${hiLo}" style="background:${bg}" title="${esc(tip)}">${f.bps(b, 2)}${c.m.intervalH !== 8 ? `<sub>${c.m.intervalH}h</sub>` : ''}</td>`;
      }).join('');
      return `<tr data-base="${esc(r.base)}"><td class="l"><b>${esc(r.base)}</b></td>${cells}<td><b>${f.bps(r.spread8 * 1e4, 2)}</b></td><td>${f.pct(E.apr(r.spread8))}</td><td>${f.usd(r.oi)}</td></tr>`;
    }).join('') || '<tr><td class="empty">Loading…</td></tr>';
  }

  // ------------------------------------------------------------ venues and method
  function renderVenues() {
    const st = S();
    const rows = FAS.venueOrder.map((v) => {
      const ad = FAS.venues[v];
      const sn = st.snap[v] || {};
      const h = FAS.health[v] || {};
      const mode = set().venues[v] === false ? 'disabled' : sn.mode || 'loading';
      return `<tr><td class="l"><b>${ad.name}</b></td><td class="l"><span class="pill ${mode === 'live' ? 'ok' : mode === 'rate-only' ? 'warn' : mode === 'down' ? 'bad' : 'wait'}">${mode}</span></td>
        <td>${(sn.perps || []).length}</td><td>${(sn.spots || []).length}</td><td>${FAS.http.perMinute(v)}</td><td class="l">${f.ago(h.lastOk)}</td>
        <td class="l">${esc(ad.collateral)}</td><td class="l">${esc(ad.info.intervals)}</td><td class="l">${esc(ad.info.caps)}</td>
        <td class="l">${esc(ad.info.margin)}</td><td class="l">${esc(ad.info.adl)}</td><td class="l">${esc(ad.info.transfer)}</td><td class="l">${esc(ad.info.limits)}</td><td class="l">${esc(ad.info.access)}${h.lastErr ? `<br><span class="neg">${esc(h.lastErr.msg)}</span>` : ''}</td></tr>`;
    }).join('');
    $('venueBody').innerHTML = rows;
  }

  // ------------------------------------------------------------ settings
  const FIELDS = [
    ['Trade', [
      ['notional', 'Notional per leg (USD)', 'number', 100],
      ['holdDays', 'Holding period (days)', 'number', 1],
      ['leverage', 'Leverage per perp leg', 'number', 0.5],
      ['makerSharePct', 'Share filled as maker (%)', 'number', 5],
    ]],
    ['Liquidity filters (each leg)', [
      ['minOiUsd', 'Min open interest (USD)', 'number', 100000],
      ['minVolUsd', 'Min 24h volume (USD)', 'number', 100000],
      ['maxSpreadBps', 'Max bid/ask spread (bps)', 'number', 1],
      ['slipBudgetBps', 'Slippage budget per leg (bps)', 'number', 1],
      ['maxSizeOfOiPct', 'Max size as % of leg OI', 'number', 0.1],
      ['maxPriceDevPct', 'Max price gap between legs (%)', 'number', 0.5],
    ]],
    ['Hurdles and alerts', [
      ['minNetBps8h', 'Net spread hurdle (bps/8h)', 'number', 0.5],
      ['minNetAprPct', 'or net APR hurdle (%)', 'number', 1],
      ['persistN', 'Consecutive favorable 8h windows', 'number', 1],
      ['persistThrBps', 'Persistence threshold (bps/8h)', 'number', 0.1],
      ['leadMin', 'Min lead before settlement (min)', 'number', 1],
      ['captureWindowH', 'Settlement within (hours)', 'number', 1],
      ['riskCeilingPct', 'Margin utilization ceiling (%)', 'number', 5],
      ['stressSigma', 'Stress move (daily σ)', 'number', 0.5],
      ['basisAlertBps', 'Basis warning (bps)', 'number', 5],
      ['alertsOn', 'Log alerts', 'checkbox'],
      ['notify', 'Browser notifications', 'checkbox'],
    ]],
    ['Carry costs', [
      ['borrowAprPct', 'Borrow APR when not published (%)', 'number', 1],
      ['capitalCostAprPct', 'Cost of spot capital, C&C (APR %)', 'number', 0.5],
    ]],
    ['Ranking', [
      ['weights.apr', 'w1 net APR', 'number', 0.1],
      ['weights.persist', 'w2 persistence', 'number', 0.1],
      ['weights.liq', 'w3 liquidity', 'number', 0.1],
      ['weights.feas', 'w4 execution feasibility', 'number', 0.1],
      ['weights.risk', 'w5 risk penalties', 'number', 0.1],
      ['aprCapPct', 'Net APR that scores full marks (%)', 'number', 5],
      ['enrichN', 'Rows that load history and books', 'number', 5],
    ]],
    ['Structures and data', [
      ['structures.perp', 'Perp-perp across venues', 'checkbox'],
      ['structures.carry', 'Cash-and-carry', 'checkbox'],
      ['structures.reverse', 'Reverse carry', 'checkbox'],
      ['includeInverse', 'Include coin-margined (OKX inverse)', 'checkbox'],
      ['allowRateOnly', 'Allow rate-only legs (no liquidity data)', 'checkbox'],
    ]],
  ];
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a ? a[k] : undefined), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

  function buildSettings() {
    const s = set();
    let html = '';
    for (const [title, fields] of FIELDS) {
      html += `<fieldset><legend>${title}</legend>`;
      for (const [k, label, type, step] of fields) {
        const v = getPath(s, k);
        html += type === 'checkbox'
          ? `<label class="check"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}> ${label}</label>`
          : `<label><span>${label}</span><input type="number" data-k="${k}" value="${v}" step="${step}"></label>`;
      }
      html += '</fieldset>';
    }
    html += '<fieldset><legend>Venues</legend>' + FAS.venueOrder.map((v) => `<label class="check"><input type="checkbox" data-k="venues.${v}" ${s.venues[v] !== false ? 'checked' : ''}> ${vname(v)}</label>`).join('') + '</fieldset>';
    html += '<fieldset class="fees"><legend>Fees (% of notional): perp taker / maker, spot taker / maker</legend>' + FAS.venueOrder.map((v) => {
      const fe = s.fees[v] || {};
      const inp = (k) => (fe[k] === null || fe[k] === undefined ? '<input type="number" disabled placeholder="n/a">' : `<input type="number" step="0.005" data-k="fees.${v}.${k}" value="${fe[k]}">`);
      return `<div class="fee-row"><span>${vname(v)}</span>${inp('perpTaker')}${inp('perpMaker')}${inp('spotTaker')}${inp('spotMaker')}</div>`;
    }).join('') + '</fieldset>';
    html += '<div class="settings-actions"><button type="button" class="btn" id="resetSettings">Reset to defaults</button></div>';
    const form = $('settingsForm');
    form.innerHTML = html;
    form.onchange = (ev) => {
      const el = ev.target;
      const k = el.dataset.k;
      if (!k) return;
      const v = el.type === 'checkbox' ? el.checked : +el.value;
      if (el.type !== 'checkbox' && !isFinite(v)) return;
      setPath(s, k, v);
      if (k === 'notify' && v && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
      if (k === 'notional') $('notional').value = v;
      if (k === 'holdDays') $('hold').value = v;
      FAS.saveSettings();
      if (k.startsWith('venues.') || k === 'includeInverse') FAS.refresh();
      else changed(true);
    };
    $('resetSettings').onclick = () => {
      const keep = { theme: s.theme };
      FAS.state.settings = FAS.merge(JSON.parse(JSON.stringify(FAS.defaults)), keep);
      FAS.saveSettings();
      location.reload();
    };
  }

  function toggleSettings(open) {
    $('settings').hidden = !open;
    $('settingsBtn').setAttribute('aria-expanded', String(open));
  }
})();
