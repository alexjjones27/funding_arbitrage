// Captures a full snapshot (venue data plus history and books for the shortlist) for the
// offline build: NODE_USE_ENV_PROXY=1 node tools/capture.js out.json [enrichN]
const fs = require('fs');
const load = require('../tests/load.js');
const FAS = load(['util.js', 'api.js', 'venues.js', 'engine.js']);
const E = FAS.engine;

(async () => {
  const out = process.argv[2] || 'snapshot.json';
  const N = +(process.argv[3] || 60);
  const s = FAS.merge(JSON.parse(JSON.stringify(FAS.defaults)), {});
  const snap = {};
  await Promise.all(FAS.venueOrder.map(async (id) => {
    try {
      const r = await FAS.venues[id].snapshot(s);
      snap[id] = Object.assign(r, { t: Date.now(), err: null, mode: 'live' });
    } catch (e) {
      snap[id] = { perps: [], spots: [], mode: 'down', err: e.message, t: Date.now() };
    }
  }));
  const pred = snap.hyperliquid && snap.hyperliquid.predicted;
  for (const v of ['binance', 'bybit']) {
    if (snap[v].mode !== 'live' && pred) Object.assign(snap[v], { perps: FAS.rateOnlyFrom(pred, v), mode: 'rate-only' });
  }
  const all = (k) => FAS.venueOrder.flatMap((v) => snap[v][k] || []);
  const perps = all('perps');
  const bases = new Set(perps.map((m) => m.base));
  for (const v of FAS.venueOrder) snap[v].spots = (snap[v].spots || []).filter((x) => bases.has(x.base));
  const borrow = {};
  for (const v of FAS.venueOrder) if (snap[v].borrow) borrow[v] = snap[v].borrow;
  const hist = {}, books = {};
  const fails = (o) => o.liq.some((x) => x.oiOk === false || x.volOk === false || x.spreadOk === false || x.slipOk === false) || o.maxSlipBps === Infinity;

  for (let pass = 0; pass < 2; pass++) {
    const opps = E.build({ perps, spots: all('spots'), borrow, hist, books, settings: s });
    const shown = (o) => !fails(o) && o.netApr > 0;
    const usable = opps.filter((o) => !o.flags.some((f) => f.id === 'rateonly'));
    // Shortlist per structure so each tab has enriched rows.
    const pick = [];
    for (const st of ['perp', 'carry', 'reverse']) {
      pick.push(...usable.filter((o) => o.structure === st).sort((a, b) => (shown(b) - shown(a)) || (b.score - a.score)).slice(0, st === 'perp' ? N : Math.round(N / 3)));
    }
    const jobs = [];
    for (const o of pick) for (const leg of [o.long, o.short]) {
      const m = leg.m, k = E.key(m), ad = FAS.venues[m.venue];
      if (leg.kind === 'perp' && !hist[k]) { hist[k] = { rows: [], t: 0 }; jobs.push(ad.history(m, Date.now() - 30 * FAS.DAY).then((rows) => { hist[k] = { rows, t: Date.now() }; })); }
      if (!books[k]) { books[k] = null; const fn = leg.kind === 'perp' ? ad.book : ad.spotBook; jobs.push(fn.call(ad, m).then((b) => { b.t = Date.now(); books[k] = b; })); }
      if (ad.enrich && m.oiUsd === null) jobs.push(ad.enrich(m));
    }
    const res = await Promise.allSettled(jobs);
    console.error(`pass ${pass}: ${jobs.length} jobs, ${res.filter((r) => r.status === 'rejected').length} failed`);
  }
  for (const k of Object.keys(books)) if (!books[k]) delete books[k];
  for (const k of Object.keys(hist)) if (!hist[k].t) delete hist[k];
  // Trim books to 300 bps either side of mid: enough for any depth band and realistic sizes.
  for (const b of Object.values(books)) {
    const mid = E.bookMid(b);
    if (!mid) continue;
    b.bids = b.bids.filter((l) => l[0] >= mid * 0.97);
    b.asks = b.asks.filter((l) => l[0] <= mid * 1.03);
  }
  for (const v of FAS.venueOrder) delete snap[v].predicted;
  const data = { t: Date.now(), snap, hist, books };
  fs.writeFileSync(out, JSON.stringify(data));
  console.error(`wrote ${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${Object.keys(hist).length} histories, ${Object.keys(books).length} books`);
})();
