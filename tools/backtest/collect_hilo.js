// Adds hourly highs and lows for the given markets to a collect_year.js data file, so the backtest
// can check liquidations against each hour's worst price instead of its close.
// NODE_USE_ENV_PROXY=1 node tools/backtest/collect_hilo.js yr-data.json keys.json out.json
// keys.json is a list of market keys, e.g. the output of `study5x.js yr-data.json --legs`.
const fs = require('fs');
const zlib = require('zlib');
const load = require('../../tests/load.js');
const FAS = load(['util.js', 'api.js', 'venues.js', 'engine.js']);
const http = FAS.http, HOUR = FAS.HOUR, DAY = FAS.DAY;

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
    } catch (e) { if (i === tries - 1) throw e; await FAS.sleep(1000 * (i + 1)); }
  }
}
function months(since) {
  const out = [], d = new Date(since); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  while (d <= new Date()) { out.push([d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0')]); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}
// Each row: [openTime, high, low, hours]
async function okx(leg, since) {
  const out = [];
  let after = '';
  for (let i = 0; i < 120; i++) {
    const r = await http.get('okx', `https://www.okx.com/api/v5/market/history-candles?instId=${leg.id}&bar=1H&limit=100${after}`);
    const d = (r && r.data) || [];
    if (!d.length) break;
    out.push(...d.map((c) => [+c[0], +c[2], +c[3], 1]));
    const oldest = +d[d.length - 1][0];
    if (oldest <= since) break;
    after = '&after=' + oldest;
  }
  return out;
}
async function gate(leg, since) {
  const spot = leg.kind === 'spot', out = [];
  for (const [y, mo] of months(since).slice(0, -1)) {
    const buf = await getBin(`https://download.gatedata.org/${spot ? 'spot' : 'futures_usdt'}/candlesticks_1h/${y}${mo}/${leg.id}-${y}${mo}.csv.gz`);
    if (!buf) continue;
    for (const r of zlib.gunzipSync(buf).toString().trim().split(/\r?\n/).map((l) => l.split(','))) if (r[0]) out.push([+r[0] * 1000, +r[3], +r[4], 1]);
  }
  const from = Math.max(since, Date.now() - 60 * DAY), span = (spot ? 40 : 80) * DAY;
  for (let f = from; f < Date.now(); f += span) {
    const to = Math.min(Date.now(), f + span);
    const url = spot
      ? `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${leg.id}&interval=1h&from=${Math.floor(f / 1000)}&to=${Math.floor(to / 1000)}`
      : `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${leg.id}&interval=1h&from=${Math.floor(f / 1000)}&to=${Math.floor(to / 1000)}`;
    const d = (await http.get('gate', url)) || [];
    out.push(...d.map((c) => (spot ? [+c[0] * 1000, +c[3], +c[4], 1] : [c.t * 1000, +c.h, +c.l, 1])));
  }
  return out;
}
async function hyperliquid(leg, since) {
  // Hourly for the latest ~208 days, 4-hourly before (the 4h range covers each of its hours).
  const now = Date.now(), hourlyFrom = Math.floor((now - 4990 * HOUR) / HOUR) * HOUR;
  const q = (interval, s, e) => http.post('hyperliquid', 'https://api.hyperliquid.xyz/info', { type: 'candleSnapshot', req: { coin: leg.id, interval, startTime: s, endTime: e } });
  const out = [];
  if (since < hourlyFrom) out.push(...((await q('4h', since, hourlyFrom - 1)) || []).map((c) => [c.t, +c.h, +c.l, 4]));
  out.push(...((await q('1h', Math.max(since, hourlyFrom), now)) || []).map((c) => [c.t, +c.h, +c.l, 1]));
  return out;
}
async function dydx(leg, since) {
  const out = [];
  let to = '';
  for (let i = 0; i < 15; i++) {
    const r = await http.get('dydx', `https://indexer.dydx.trade/v4/candles/perpetualMarkets/${leg.id}?resolution=1HOUR&limit=1000${to}`);
    const d = (r && r.candles) || [];
    if (!d.length) break;
    out.push(...d.map((c) => [Date.parse(c.startedAt), +c.high, +c.low, 1]));
    const oldest = Date.parse(d[d.length - 1].startedAt);
    if (oldest <= since) break;
    to = '&toISO=' + new Date(oldest - 1).toISOString();
  }
  return out;
}
const FETCH = { okx, gate, hyperliquid, dydx };

(async () => {
  const [dataPath, keysPath, outPath] = process.argv.slice(2);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  data.hilo = data.hilo || {};
  const todo = data.legs.filter((l) => keys.includes(l.key) && !data.hilo[l.key]);
  console.error(`${todo.length} markets to fetch`);
  let done = 0;
  const one = async (leg) => {
    const rows = await FETCH[leg.venue](leg, data.since);
    const seen = new Set();
    data.hilo[leg.key] = rows.filter((r) => r[1] > 0 && r[2] > 0 && !seen.has(r[0]) && seen.add(r[0])).sort((a, b) => a[0] - b[0]);
  };
  await Promise.all(todo.map(async (leg) => {
    for (let i = 0; i < 4; i++) {
      try { await one(leg); break; } catch (e) { if (i === 3) console.error('failed', leg.key, e.message); else await FAS.sleep(3000 * (i + 1)); }
    }
    if (++done % 10 === 0) console.error(`${done}/${todo.length}`);
  }));
  const missing = keys.filter((k) => !data.hilo[k] || !data.hilo[k].length);
  console.error(`missing: ${missing.length}`, missing.join(' '));
  fs.writeFileSync(outPath, JSON.stringify(data));
})();
