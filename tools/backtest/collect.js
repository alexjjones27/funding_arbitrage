// Collects 3 months of funding and hourly prices, plus current order books, for every liquid leg.
// NODE_USE_ENV_PROXY=1 node tools/backtest/collect.js snapshot.json out.json [days]
const fs = require('fs');
const load = require('../../tests/load.js');
const FAS = load(['util.js', 'api.js', 'venues.js', 'engine.js']);
const E = FAS.engine;
const http = FAS.http;
const HOUR = FAS.HOUR, DAY = FAS.DAY;

const VENUES = ['okx', 'bitget', 'gate', 'hyperliquid', 'dydx'];
const MIN_OI = 2e6, MIN_VOL = 5e6;
const SIZES = [1000, 2500, 5000, 10000, 20000, 40000];

// Hourly closes, ascending [[t, close]], for a perp or spot leg.
async function candles(leg, since) {
  const out = [];
  const now = Date.now();
  const v = leg.venue, id = leg.id, spot = leg.kind === 'spot';
  if (v === 'okx') {
    let after = '';
    for (let i = 0; i < 30; i++) {
      const r = await http.get('okx', `https://www.okx.com/api/v5/market/history-candles?instId=${id}&bar=1H&limit=100${after}`);
      const d = (r && r.data) || [];
      if (!d.length) break;
      out.push(...d.map((c) => [+c[0], +c[4]]));
      const oldest = +d[d.length - 1][0];
      if (oldest <= since) break;
      after = '&after=' + oldest;
    }
  } else if (v === 'bitget') {
    let end = now;
    for (let i = 0; i < 15; i++) {
      const url = spot
        ? `https://api.bitget.com/api/v2/spot/market/history-candles?symbol=${id}&granularity=1h&endTime=${end}&limit=200`
        : `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${id}&productType=${leg.productType}&granularity=1H&endTime=${end}&limit=200`;
      const d = ((await http.get('bitget', url)) || {}).data || [];
      if (!d.length) break;
      out.push(...d.map((c) => [+c[0], +c[4]]));
      const oldest = Math.min(...d.map((c) => +c[0]));
      if (oldest <= since) break;
      end = oldest - 1;
    }
  } else if (v === 'gate') {
    const span = (spot ? 40 : 80) * DAY;
    for (let from = since; from < now; from += span) {
      const to = Math.min(now, from + span);
      const url = spot
        ? `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${id}&interval=1h&from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}`
        : `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${id}&interval=1h&from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}`;
      const d = (await http.get('gate', url)) || [];
      out.push(...d.map((c) => (spot ? [+c[0] * 1000, +c[2]] : [c.t * 1000, +c.c])));
    }
  } else if (v === 'hyperliquid') {
    const d = await http.post('hyperliquid', 'https://api.hyperliquid.xyz/info', { type: 'candleSnapshot', req: { coin: id, interval: '1h', startTime: since, endTime: now } });
    out.push(...(d || []).map((c) => [c.t, +c.c]));
  } else if (v === 'dydx') {
    let to = '';
    for (let i = 0; i < 4; i++) {
      const r = await http.get('dydx', `https://indexer.dydx.trade/v4/candles/perpetualMarkets/${id}?resolution=1HOUR&limit=1000${to}`);
      const d = (r && r.candles) || [];
      if (!d.length) break;
      out.push(...d.map((c) => [Date.parse(c.startedAt), +c.close]));
      const oldest = Date.parse(d[d.length - 1].startedAt);
      if (oldest <= since) break;
      to = '&toISO=' + new Date(oldest - 1).toISOString();
    }
  }
  const seen = new Set();
  return out.filter((c) => c[0] >= since && c[1] > 0 && !seen.has(c[0]) && seen.add(c[0])).sort((a, b) => a[0] - b[0]);
}

(async () => {
  const [snapPath, outPath, daysArg] = process.argv.slice(2);
  const days = +(daysArg || 92);
  const since = Date.now() - days * DAY;
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  // Universe: today's liquid linear perps on 2+ venues, and liquid same-venue spot for carry.
  const byBase = new Map();
  for (const v of VENUES) for (const m of snap.snap[v].perps) {
    if (m.status !== 'ok' || m.type !== 'linear' || !(m.oiUsd >= MIN_OI) || !(m.volUsd >= MIN_VOL)) continue;
    if (!byBase.has(m.base)) byBase.set(m.base, []);
    byBase.get(m.base).push(m);
  }
  const legs = [];
  for (const [base, ms] of byBase) {
    const venues = new Set(ms.map((m) => m.venue));
    const spots = new Map();
    for (const v of VENUES) for (const s of snap.snap[v].spots || []) if (s.base === base && s.volUsd >= MIN_VOL && s.quote === 'USDT') spots.set(v, s);
    for (const m of ms) {
      const sp = spots.get(m.venue);
      if (venues.size < 2 && !sp) continue;
      if (legs.some((l) => l.key === E.key(m))) continue;
      legs.push({ key: E.key(m), kind: 'perp', venue: m.venue, id: m.id, base, mult: m.mult, quote: m.quote, intervalH: m.intervalH, productType: m.productType, ctVal: m.ctVal, type: m.type, maxLev: m.maxLev, mmr: m.mmr, oiUsd: m.oiUsd, volUsd: m.volUsd });
      if (sp && !legs.some((l) => l.key === E.key(sp))) legs.push({ key: E.key(sp), kind: 'spot', venue: sp.venue, id: sp.id, base, mult: sp.mult, quote: sp.quote, volUsd: sp.volUsd });
    }
  }
  console.error(`universe: ${legs.length} legs (${legs.filter((l) => l.kind === 'perp').length} perp, ${legs.filter((l) => l.kind === 'spot').length} spot) over ${new Set(legs.map((l) => l.base)).size} assets`);

  let done = 0;
  await Promise.all(legs.map(async (leg) => {
    const ad = FAS.venues[leg.venue];
    try {
      if (leg.kind === 'perp') leg.funding = await ad.history(leg, since);
      leg.candles = await candles(leg, since);
      const bk = await (leg.kind === 'perp' ? ad.book(leg) : ad.spotBook(leg));
      // Slippage per side at several sizes from today's book (no historical books are public).
      leg.slip = SIZES.map((usd) => ({ usd, buy: E.slipBps(bk, usd, 'buy'), sell: E.slipBps(bk, usd, 'sell') }));
      leg.spreadBps = E.bookSpreadBps(bk);
    } catch (e) {
      leg.error = e.message;
    }
    if (++done % 25 === 0) console.error(`${done}/${legs.length}`);
  }));
  const bad = legs.filter((l) => l.error);
  console.error(`errors: ${bad.length}`, bad.slice(0, 5).map((l) => l.key + ' ' + l.error));
  fs.writeFileSync(outPath, JSON.stringify({ t: Date.now(), since, days, legs }));
  console.error(`wrote ${outPath} ${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB`);
})();
