/* Orchestration: venue snapshots, the enrichment queue (history and books for the shortlist),
 * recompute, and alerts. */
(function () {
  'use strict';
  const FAS = window.FAS;
  const E = FAS.engine;
  const cfg = FAS.config;

  const S = (FAS.state = {
    settings: FAS.merge(JSON.parse(JSON.stringify(FAS.defaults)), FAS.store.get('settings', {})),
    snap: {},          // venue -> { perps, spots, borrow, t, err, mode }
    perps: [], spots: [], borrow: {},
    hist: {},          // leg key -> { rows, t }
    books: {},         // leg key -> book with t
    pending: new Set(),
    opps: [],
    excluded: 0,
    selected: null,
    alerts: FAS.store.get('alerts', []),
    lastAlert: {},
    lastSnap: null,
    busy: false,
  });

  FAS.saveSettings = function () { FAS.store.set('settings', S.settings); };

  async function snapshot() {
    if (S.busy) return;
    S.busy = true;
    FAS.ui.status();
    const s = S.settings;
    const ids = FAS.venueOrder.filter((v) => s.venues[v] !== false);
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await FAS.venues[id].snapshot(s);
        // Keep OI that only enrichment supplies (Binance) across snapshots.
        const prev = S.snap[id] && S.snap[id].perps;
        if (prev && id === 'binance') {
          const oi = new Map(prev.map((m) => [m.id, m.oiUsd]));
          for (const m of r.perps) if (m.oiUsd === null && oi.get(m.id)) m.oiUsd = oi.get(m.id);
        }
        S.snap[id] = Object.assign(r, { t: Date.now(), err: null, mode: 'live' });
      } catch (e) {
        S.snap[id] = Object.assign(S.snap[id] && S.snap[id].mode === 'live' && Date.now() - S.snap[id].t < 5 * 60e3 ? S.snap[id] : { perps: [], spots: [] }, { err: e.message, errAt: Date.now() });
        if (S.snap[id].mode !== 'live') S.snap[id].mode = 'down';
      }
    }));
    // Binance/Bybit unreachable: fall back to rate-only markets from Hyperliquid's predictions.
    const pred = S.snap.hyperliquid && S.snap.hyperliquid.predicted;
    for (const v of ['binance', 'bybit']) {
      const sn = S.snap[v];
      if (s.venues[v] === false || !pred) continue;
      if (!sn || sn.mode !== 'live') {
        S.snap[v] = Object.assign(sn || {}, { perps: FAS.rateOnlyFrom(pred, v), spots: [], mode: 'rate-only', t: Date.now() });
      }
    }
    S.perps = []; S.spots = []; S.borrow = {};
    for (const id of ids) {
      const sn = S.snap[id];
      if (!sn) continue;
      S.perps.push(...(sn.perps || []));
      S.spots.push(...(sn.spots || []));
      if (sn.borrow) S.borrow[id] = sn.borrow;
    }
    S.lastSnap = Date.now();
    S.busy = false;
    recompute();
    enrich();
  }

  function recompute() {
    const s = S.settings;
    const opps = E.build({ perps: S.perps, spots: S.spots, borrow: S.borrow, hist: S.hist, books: S.books, settings: s });
    S.excluded = opps.excluded;
    S.opps = opps;
    S.matrix = E.matrix(S.perps, s);
    checkAlerts();
    FAS.ui.render();
  }
  let rcTimer = null;
  FAS.recompute = function (now) {
    if (now) { clearTimeout(rcTimer); rcTimer = null; recompute(); return; }
    if (rcTimer) return;
    rcTimer = setTimeout(() => { rcTimer = null; recompute(); }, 400);
  };

  // History and books for the top candidates by score, plus the selected row.
  async function enrich() {
    const s = S.settings;
    // Rows a user would see first (liquid, net-positive) take the budget before the rest.
    const usable = (o) => !o.flags.some((f) => f.id === 'rateonly');
    const shown = (o) => !FAS.ui.failsLiquidity(o) && o.netApr > 0;
    const ranked = S.opps.filter(usable).sort((a, b) => (shown(b) - shown(a)) || (b.score - a.score));
    const top = ranked.slice(0, s.enrichN);
    const sel = S.opps.find((o) => o.key === S.selected);
    if (sel) top.unshift(sel);
    const jobs = [];
    const now = Date.now();
    for (const o of top) {
      for (const leg of [o.long, o.short]) {
        const m = leg.m;
        const k = E.key(m);
        const ad = FAS.venues[m.venue];
        if (!ad || m.rateOnly) continue;
        if (leg.kind === 'perp') {
          const h = S.hist[k];
          if ((!h || now - h.t > cfg.historyTtlMs) && !S.pending.has('h:' + k)) jobs.push(['h:' + k, async () => {
            const rows = await ad.history(m, Date.now() - cfg.historyDays * FAS.DAY);
            S.hist[k] = { rows, t: Date.now() };
          }]);
          if (ad.enrich && m.oiUsd === null && !S.pending.has('e:' + k)) jobs.push(['e:' + k, () => ad.enrich(m)]);
        }
        const b = S.books[k];
        if ((!b || now - b.t > cfg.bookTtlMs) && !S.pending.has('b:' + k)) {
          const fn = leg.kind === 'perp' ? ad.book : ad.spotBook;
          if (fn) jobs.push(['b:' + k, async () => {
            const bk = await fn.call(ad, m);
            bk.t = Date.now();
            S.books[k] = bk;
          }]);
        }
      }
    }
    for (const [id, fn] of jobs) {
      S.pending.add(id);
      fn().catch(() => {}).finally(() => {
        S.pending.delete(id);
        FAS.recompute();
      });
    }
    FAS.ui.status();
  }
  FAS.enrich = enrich;

  function checkAlerts() {
    const s = S.settings;
    if (!s.alertsOn) return;
    const now = Date.now();
    let added = false;
    for (const o of S.opps) {
      if (!o.alertable) continue;
      if (now - (S.lastAlert[o.key] || 0) < cfg.alertCooldownMs) continue;
      S.lastAlert[o.key] = now;
      const a = {
        t: now, key: o.key, base: o.base, structure: o.structure,
        long: o.long.m.venue, short: o.short.m.venue,
        netApr: o.netApr, netBps8: o.netBps8, consec: o.persist ? o.persist.consec : null, score: o.score,
      };
      S.alerts.unshift(a);
      added = true;
      if (s.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(`${o.base}: ${FAS.ui.structName(o.structure)} ${FAS.fmt.pct(o.netApr)} net APR`, {
            body: `Long ${o.long.m.venue}, short ${o.short.m.venue}. ${FAS.fmt.bps(o.netBps8)} bps/8h net; all conditions met.`,
            tag: o.key,
          });
        } catch (e) { /* notifications unavailable */ }
      }
    }
    if (added) {
      S.alerts = S.alerts.slice(0, cfg.maxAlerts);
      FAS.store.set('alerts', S.alerts);
    }
  }

  FAS.refresh = snapshot;

  document.addEventListener('DOMContentLoaded', () => {
    FAS.ui.init();
    snapshot();
    setInterval(snapshot, cfg.snapshotMs);
    setInterval(enrich, cfg.enrichCycleMs);
    setInterval(() => FAS.ui.status(), 1000);
  });
})();
