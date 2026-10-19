// Collects a year of settled funding, hourly prices and hourly quote volume, plus today's order
// books, for OKX, Gate, Hyperliquid and dYdX. Older history comes from the venues' bulk archives
// (OKX static funding files, gatedata.org) where the live APIs stop short.
// NODE_USE_ENV_PROXY=1 node tools/backtest/collect_year.js snapshot.json out.json [days] [minVolToday]
const fs = require('fs');
const zlib = require('zlib');
const load = require('../../tests/load.js');
const FAS = load(['util.js', 'api.js', 'venues.js', 'engine.js']);
const E = FAS.engine, http = FAS.http, HOUR = FAS.HOUR, DAY = FAS.DAY;
const VENUES = ['okx', 'gate', 'hyperliquid', 'dydx'];
const SIZES = [1000, 2500, 5000, 10000, 20000, 40000];
const STOCKS = new Set('AAOI BZ CL CRCL CXMT DRAM EWY INTC KORU MSTR MU NBIS NVDA OPENAI QQQ SAMSUNG SKHY SKHYNIX SNDK SNXX SOXL SOXS SPCX TSLA UNITREE XAG XAU XAUT'.split(' '));

// ---------- binary downloads (archives), paced per host, with retries
const lastHit = {};
async function getBin(url, tries = 3) {
  const host = new URL(url).host;
  for (let i = 0; i < tries; i++) {
    const wait = (lastHit[host] || 0) + 80 - Date.now();
    lastHit[host] = Math.max(Date.now(), (lastHit[host] || 0) + 80);
    if (wait > 0) await FAS.sleep(wait);
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await FAS.sleep(1000 * (i + 1));
    }
  }
}
// First file of a zip (local header + raw deflate).
function unzipFirst(buf) {
  if (!buf || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(8), csize = buf.readUInt32LE(18), n = buf.readUInt16LE(26), m = buf.readUInt16LE(28);
  const start = 30 + n + m;
  const data = buf.subarray(start, csize ? start + csize : undefined);
  return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
}
const csvRows = (text) => text.trim().split(/\r?\n/).map((l) => l.split(','));
function months(since) {
  const out = [];
  const d = new Date(since); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  const now = new Date();
  while (d <= now) { out.push([d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0')]); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}
const dedupe = (rows, k = (r) => r.t) => { const s = new Set(); return rows.filter((r) => !s.has(k(r)) && s.add(k(r))).sort((a, b) => k(a) - k(b)); };

// ---------- funding
async function fundingOKX(leg, since) {
  const out = [];
  for (const [y, mo] of months(since)) {
    const buf = await getBin(`https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/${y}${mo}/${leg.id}-fundingrates-${y}-${mo}.zip`);
    const txt = unzipFirst(buf);
    if (txt) for (const r of csvRows(txt).slice(1)) if (r[2]) out.push({ t: +r[2], r: +r[1] });
  }
  out.push(...(await FAS.venues.okx.history(leg, Date.now() - 95 * DAY))); // recent months the archive lacks
  return dedupe(out).filter((x) => x.t >= since);
}
async function fundingGate(leg, since) {
  const out = [];
  for (const [y, mo] of months(since)) {
    const buf = await getBin(`https://download.gatedata.org/futures_usdt/funding_applies/${y}${mo}/${leg.id}-${y}${mo}.csv.gz`);
    if (buf) for (const r of csvRows(zlib.gunzipSync(buf).toString())) if (r[0]) out.push({ t: +r[0] * 1000, r: +r[1] });
  }
  out.push(...(await FAS.venues.gate.history(leg, Date.now() - 60 * DAY)));
  return dedupe(out).filter((x) => x.t >= since);
}
async function fundingHL(leg, since) {
  const out = [];
  let start = since;
  for (let i = 0; i < 30; i++) {
    const r = await http.post('hyperliquid', 'https://api.hyperliquid.xyz/info', { type: 'fundingHistory', coin: leg.id, startTime: start });
    if (!r || !r.length) break;
    out.push(...r.map((x) => ({ t: x.time, r: +x.fundingRate })));
    if (r.length < 500) break;
    start = r[r.length - 1].time + 1;
  }
  return dedupe(out);
}
async function fundingDYDX(leg, since) {
  const out = [];
  let before = '';
  for (let i = 0; i < 15; i++) {
    const r = await http.get('dydx', `https://indexer.dydx.trade/v4/historicalFunding/${leg.id}?limit=1000${before}`);
    const d = (r && r.historicalFunding) || [];
    if (!d.length) break;
    out.push(...d.map((x) => ({ t: Date.parse(x.effectiveAt), r: +x.rate })));
    const oldest = Date.parse(d[d.length - 1].effectiveAt);
    if (oldest <= since) break;
    before = '&effectiveBeforeOrAt=' + new Date(oldest - 1).toISOString();
  }
  return dedupe(out).filter((x) => x.t >= since);
}

// ---------- candles: [openTime, close, quoteVolume, hours]
async function candlesOKX(leg, since) {
  const out = [];
  let after = '';
  for (let i = 0; i < 120; i++) {
    const r = await http.get('okx', `https://www.okx.com/api/v5/market/history-candles?instId=${leg.id}&bar=1H&limit=100${after}`);
    const d = (r && r.data) || [];
    if (!d.length) break;
    out.push(...d.map((c) => ({ t: +c[0], c: +c[4], v: +c[7], h: 1 })));
    const oldest = +d[d.length - 1][0];
    if (oldest <= since) break;
    after = '&after=' + oldest;
  }
  return out;
}
async function candlesGate(leg, since) {
  const spot = leg.kind === 'spot';
  const out = [];
  const ms = months(since);
  for (const [y, mo] of ms.slice(0, -1)) { // archive for completed months
    const buf = await getBin(`https://download.gatedata.org/${spot ? 'spot' : 'futures_usdt'}/candlesticks_1h/${y}${mo}/${leg.id}-${y}${mo}.csv.gz`);
    if (!buf) continue;
    for (const r of csvRows(zlib.gunzipSync(buf).toString())) {
      if (!r[0]) continue;
      const close = +r[2];
      const vq = spot ? +r[1] * close : +r[1] * (leg.ctVal || 1) * close; // spot: base volume; futures: contracts
      out.push({ t: +r[0] * 1000, c: close, v: vq, h: 1 });
    }
  }
  // Current month (and any gap) from the API, which reaches back 180 days.
  const from = Math.max(since, Date.now() - 60 * DAY);
  const span = (spot ? 40 : 80) * DAY;
  for (let f = from; f < Date.now(); f += span) {
    const to = Math.min(Date.now(), f + span);
    const url = spot
      ? `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${leg.id}&interval=1h&from=${Math.floor(f / 1000)}&to=${Math.floor(to / 1000)}`
      : `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${leg.id}&interval=1h&from=${Math.floor(f / 1000)}&to=${Math.floor(to / 1000)}`;
    const d = (await http.get('gate', url)) || [];
    out.push(...d.map((c) => (spot ? { t: +c[0] * 1000, c: +c[2], v: +c[1], h: 1 } : { t: c.t * 1000, c: +c.c, v: +c.sum, h: 1 })));
  }
  return out;
}
async function candlesHL(leg, since) {
  // The API serves the latest 5,000 candles per interval: hourly for ~208 days, 4-hourly before.
  const now = Date.now();
  const hourlyFrom = Math.floor((now - 4990 * HOUR) / HOUR) * HOUR;
  const q = (interval, s, e) => http.post('hyperliquid', 'https://api.hyperliquid.xyz/info', { type: 'candleSnapshot', req: { coin: leg.id, interval, startTime: s, endTime: e } });
  const out = [];
  if (since < hourlyFrom) out.push(...((await q('4h', since, hourlyFrom - 1)) || []).map((c) => ({ t: c.t, c: +c.c, v: +c.v * +c.c, h: 4 })));
  out.push(...((await q('1h', Math.max(since, hourlyFrom), now)) || []).map((c) => ({ t: c.t, c: +c.c, v: +c.v * +c.c, h: 1 })));
  return out;
}
async function candlesDYDX(leg, since) {
  const out = [];
  let to = '';
  for (let i = 0; i < 15; i++) {
    const r = await http.get('dydx', `https://indexer.dydx.trade/v4/candles/perpetualMarkets/${leg.id}?resolution=1HOUR&limit=1000${to}`);
    const d = (r && r.candles) || [];
    if (!d.length) break;
    out.push(...d.map((c) => ({ t: Date.parse(c.startedAt), c: +c.close, v: +c.usdVolume, h: 1 })));
    const oldest = Date.parse(d[d.length - 1].startedAt);
    if (oldest <= since) break;
    to = '&toISO=' + new Date(oldest - 1).toISOString();
  }
  return out;
}
const FUND = { okx: fundingOKX, gate: fundingGate, hyperliquid: fundingHL, dydx: fundingDYDX };
const CANDLES = { okx: candlesOKX, gate: candlesGate, hyperliquid: candlesHL, dydx: candlesDYDX };

(async () => {
  const [snapPath, outPath, daysArg, volArg] = process.argv.slice(2);
  const days = +(daysArg || 372), minVol = +(volArg || 5e5);
  const since = Date.now() - days * DAY;
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const byBase = new Map();
  for (const v of VENUES) for (const m of snap.snap[v].perps) {
    if (m.status !== 'ok' || m.type !== 'linear' || STOCKS.has(m.base) || !(m.volUsd >= minVol)) continue;
    if (!byBase.has(m.base)) byBase.set(m.base, []);
    byBase.get(m.base).push(m);
  }
  const legs = [];
  for (const [base, ms] of byBase) {
    const venues = new Set(ms.map((m) => m.venue));
    for (const m of ms) {
      const sp = (snap.snap[m.venue].spots || []).find((s) => s.base === base && s.quote === 'USDT' && s.volUsd >= minVol);
      if (venues.size < 2 && !sp) continue;
      if (legs.some((l) => l.key === E.key(m))) continue;
      legs.push({ key: E.key(m), kind: 'perp', venue: m.venue, id: m.id, base, mult: m.mult, quote: m.quote, intervalH: m.intervalH, ctVal: m.ctVal, type: m.type, maxLev: m.maxLev, mmr: m.mmr, volToday: m.volUsd });
      if (sp && !legs.some((l) => l.key === E.key(sp))) legs.push({ key: E.key(sp), kind: 'spot', venue: sp.venue, id: sp.id, base, mult: sp.mult, quote: sp.quote, volToday: sp.volUsd });
    }
  }
  console.error(`universe: ${legs.length} legs (${legs.filter((l) => l.kind === 'perp').length} perp, ${legs.filter((l) => l.kind === 'spot').length} spot), ${new Set(legs.map((l) => l.base)).size} assets`);
  let done = 0;
  const t0 = Date.now();
  await Promise.all(legs.map(async (leg) => {
    const ad = FAS.venues[leg.venue];
    try {
      if (leg.kind === 'perp') leg.funding = await FUND[leg.venue](leg, since);
      const cs = dedupe(await CANDLES[leg.venue](leg, since), (c) => c.t).filter((c) => c.t >= since && c.c > 0);
      leg.candles = cs.map((c) => [c.t, c.c, Math.round(c.v), c.h]);
      const bk = await (leg.kind === 'perp' ? ad.book(leg) : ad.spotBook(leg));
      leg.slip = SIZES.map((usd) => ({ usd, buy: E.slipBps(bk, usd, 'buy'), sell: E.slipBps(bk, usd, 'sell') }));
      leg.spreadBps = E.bookSpreadBps(bk);
    } catch (e) {
      leg.error = e.message;
    }
    if (++done % 25 === 0) console.error(`${done}/${legs.length} ${((Date.now() - t0) / 60e3).toFixed(1)} min`);
  }));
  // Retry failures once, slowly.
  for (const leg of legs.filter((l) => l.error)) {
    await FAS.sleep(2000);
    delete leg.error;
    try {
      if (leg.kind === 'perp') leg.funding = await FUND[leg.venue](leg, since);
      leg.candles = dedupe(await CANDLES[leg.venue](leg, since), (c) => c.t).filter((c) => c.t >= since && c.c > 0).map((c) => [c.t, c.c, Math.round(c.v), c.h]);
      const ad = FAS.venues[leg.venue];
      const bk = await (leg.kind === 'perp' ? ad.book(leg) : ad.spotBook(leg));
      leg.slip = SIZES.map((usd) => ({ usd, buy: E.slipBps(bk, usd, 'buy'), sell: E.slipBps(bk, usd, 'sell') }));
      leg.spreadBps = E.bookSpreadBps(bk);
    } catch (e) { leg.error = e.message; }
  }
  const bad = legs.filter((l) => l.error);
  console.error(`errors after retry: ${bad.length}`, bad.slice(0, 8).map((l) => l.key + ' ' + l.error));
  fs.writeFileSync(outPath, JSON.stringify({ t: Date.now(), since, days, venues: VENUES, legs }));
  console.error(`wrote ${outPath} ${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 60e3).toFixed(1)} min`);
})();
