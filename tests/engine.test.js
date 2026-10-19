// Engine tests: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./load.js');
const FAS = load(['util.js', 'api.js', 'venues.js', 'engine.js']);
const E = FAS.engine;
const H = FAS.HOUR;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const settings = (over) => FAS.merge(JSON.parse(JSON.stringify(FAS.defaults)), over || {});

test('normalizes funding to an 8h basis and annualizes', () => {
  close(E.norm8(0.0000125, 1), 0.0001); // Hyperliquid hourly baseline = 1 bp / 8h
  close(E.norm8(0.0001, 4), 0.0002);
  close(E.norm8(0.0001, 8), 0.0001);
  close(E.apr(0.0001), 10.95); // 1 bp per 8h = 10.95% a year
});

test('maps contract multipliers to the underlying', () => {
  assert.deepEqual(FAS.normBase('1000PEPE'), { base: 'PEPE', mult: 1000 });
  assert.deepEqual(FAS.normBase('kPEPE'), { base: 'PEPE', mult: 1000 });
  assert.deepEqual(FAS.normBase('1000000MOG'), { base: 'MOG', mult: 1e6 });
  assert.deepEqual(FAS.normBase('1MBABYDOGE'), { base: 'BABYDOGE', mult: 1e6 });
  assert.deepEqual(FAS.normBase('1INCH'), { base: '1INCH', mult: 1 });
  assert.deepEqual(FAS.normBase('0G'), { base: '0G', mult: 1 });
});

test('buckets hourly and 8h settlements into the same 8h windows', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const hourly = [];
  for (let i = 1; i <= 16; i++) hourly.push({ t: t0 + i * H + 400, r: 0.0000125 }); // small timestamp jitter
  const b1 = E.bucketize(hourly, 1);
  assert.equal(b1.length, 2);
  b1.forEach((b) => close(b.v, 0.0001));
  assert.equal(b1[0].t, t0);

  const eight = [{ t: t0 + 8 * H, r: 0.0003 }, { t: t0 + 16 * H, r: 0.0001 }];
  const b8 = E.bucketize(eight, 8);
  assert.deepEqual(b8.map((x) => x.t), [t0, t0 + 8 * H]);
  close(b8[0].v, 0.0003);

  const spread = E.diffSeries(b8, b1);
  close(spread[0].v, 0.0002);
  close(spread[1].v, 0);
});

test('drops windows with under 6 of 8 hours covered', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const rows = [1, 2, 3].map((i) => ({ t: t0 + i * H, r: 0.00001 }));
  assert.equal(E.bucketize(rows, 1).length, 0);
});

test('handles a venue that moves from 8h to 4h settlements', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const rows = [{ t: t0 + 8 * H, r: 0.0002 }, { t: t0 + 12 * H, r: 0.0001 }, { t: t0 + 16 * H, r: 0.0001 }];
  const b = E.bucketize(rows, 4);
  // The first print's own interval is unknown (no earlier print), so only the later window is kept.
  close(b[b.length - 1].v, 0.0002); // two 4h prints sum to one 8h window
});

test('persistence statistics', () => {
  const s = [-1, 2, 2, 2, 2].map((v, i) => ({ t: i * 8 * H, v: v / 1e4 }));
  const st = E.seriesStats(s, 0.5 / 1e4);
  assert.equal(st.consec, 4);
  assert.equal(st.pct24, 1);
  close(st.pct7d, 0.8);
  close(st.cum7, 7 / 1e4);
});

test('walks the book for slippage and depth', () => {
  const bk = { bids: [[99, 10], [98, 10]], asks: [[101, 10], [102, 10]] }; // mid 100
  close(E.slipBps(bk, 1010, 'buy'), 100); // fills entirely at 101
  const two = E.slipBps(bk, 2030, 'buy'); // 1010 at 101 + 1020 at 102
  const avg = 2030 / (10 + 10);
  close(two, ((avg - 100) / 100) * 1e4);
  assert.equal(E.slipBps(bk, 1e6, 'sell'), Infinity);
  const d = E.depthUsd(bk, 150);
  close(d.bid, 990);
  close(d.ask, 1010);
  assert.equal(d.complete, true);
  const wide = E.depthUsd(bk, 250); // the book ends inside a 250 bp band
  close(wide.bid, 1970);
  assert.equal(wide.complete, false);
});

function perp(venue, rate, intervalH, extra) {
  return Object.assign({
    venue, id: 'X-' + venue, base: 'X', rawBase: 'X', mult: 1, quote: 'USDT', type: 'linear',
    rate, predicted: null, intervalH, nextTs: Date.now() + 2 * H, mark: 100, index: 100,
    oiUsd: 50e6, volUsd: 100e6, bid: 99.99, ask: 100.01, hi: 102, lo: 98, maxLev: 50, mmr: 0.005,
    status: 'ok', capRate: 0.03,
  }, extra || {});
}

test('perp-perp economics: gross, costs, net, break-even', () => {
  const s = settings({ structures: { perp: true, carry: false, reverse: false }, carryBasis: 'current', holdDays: 10, notional: 10000, makerSharePct: 0 });
  s.fees.okx = { perpTaker: 0.05, perpMaker: 0.02 };
  s.fees.gate = { perpTaker: 0.05, perpMaker: 0.02 };
  const lo = perp('okx', -0.0001, 8);
  const hi = perp('gate', 0.0002, 4); // 4 bp per 8h
  const [o] = E.build({ perps: [lo, hi], spots: [], settings: s });
  assert.equal(o.long.m.venue, 'okx');
  assert.equal(o.short.m.venue, 'gate');
  close(o.gross8, 0.0005); // 4 - (-1) = 5 bp per 8h
  // touch slippage: spread 2 bps -> 1 bp each way; per leg 2*5bp fees + 2*1bp = 12 bp; two legs 24 bp
  close(o.costRt, 0.0024);
  const net = 0.0005 * 30 - 0.0024;
  close(o.netApr, (net / 10) * 365 * 100, 1e-6);
  close(o.beBps8, (0.0024 / 30) * 1e4, 1e-9);
  close(o.pnl7, 10000 * (0.0005 * 21 - 0.0024), 1e-6);
  close(o.capital, 2 * 10000 / 3);
});

test('drops pairs whose prices say they are different tokens', () => {
  const s = settings({ structures: { perp: true, carry: false, reverse: false }, carryBasis: 'current' });
  const a = perp('okx', 0, 8);
  const b = perp('gate', 0.001, 8, { mark: 150, index: 150, bid: 149.9, ask: 150.1 });
  const c = perp('bitget', 0.0005, 8, { mark: 100.1 });
  const out = E.build({ perps: [a, b, c], spots: [], settings: s });
  assert.ok(out.every((o) => o.short.m.venue !== 'gate' && o.long.m.venue !== 'gate'));
  assert.ok(out.excluded > 0);
});

test('compares 1000x contracts per unit of the underlying', () => {
  const s = settings({ structures: { perp: true, carry: false, reverse: false }, carryBasis: 'current' });
  const a = perp('okx', 0, 8, { mark: 0.00001, index: 0.00001, bid: null, ask: null });
  const b = perp('bitget', 0.0005, 8, { id: '1000XUSDT', rawBase: '1000X', mult: 1000, mark: 0.01, index: 0.01, bid: null, ask: null });
  const [o] = E.build({ perps: [a, b], spots: [], settings: s });
  assert.ok(o, 'pair kept');
  close(o.basisBps, 0, 1e-6);
  assert.equal(o.checks.find((c) => c.name === 'Multiplier').level, 'info');
});

test('cash-and-carry prefers same-venue spot; reverse carry charges borrow', () => {
  const s = settings({ structures: { perp: false, carry: true, reverse: true }, carryBasis: 'current', borrowAprPct: 20 });
  const pos = perp('okx', 0.0003, 8);
  const neg = perp('gate', -0.0004, 8);
  const spots = [
    { venue: 'okx', kind: 'spot', id: 'X-USDT', base: 'X', mult: 1, quote: 'USDT', bid: 99.99, ask: 100.01, volUsd: 5e6 },
    { venue: 'gate', kind: 'spot', id: 'X_USDT', base: 'X', mult: 1, quote: 'USDT', bid: 99.99, ask: 100.01, volUsd: 50e6 },
  ];
  const out = E.build({ perps: [pos, neg], spots, settings: s, borrow: { okx: {} } });
  const carry = out.find((o) => o.structure === 'carry');
  const rev = out.find((o) => o.structure === 'reverse');
  assert.equal(carry.long.m.venue, 'okx'); // same venue even though gate spot is deeper
  close(carry.gross8, 0.0003);
  close(rev.gross8, 0.0004);
  assert.equal(rev.borrowApr, 20);
  assert.match(rev.borrowSrc, /assumed/);
  close(rev.beBps8, (rev.costRt / (s.holdDays * 3) + 0.2 / 365 / 3) * 1e4, 1e-9);
});

test('an ideal opportunity meets every alert condition; a delisting one does not', () => {
  const s = settings({ structures: { perp: true, carry: false, reverse: false }, carryBasis: 'current', persistN: 3 });
  const lo = perp('okx', 0, 8);
  const hi = perp('gate', 0.0004, 8);
  const now = Date.now();
  const rows = (r) => Array.from({ length: 30 }, (_, i) => ({ t: Math.floor(now / (8 * H)) * 8 * H - (29 - i) * 8 * H, r }));
  const hist = { [E.key(lo)]: { rows: rows(0) }, [E.key(hi)]: { rows: rows(0.0004) } };
  const book = { bids: [[99.99, 1e4], [99.9, 1e5]], asks: [[100.01, 1e4], [100.1, 1e5]] };
  const books = { [E.key(lo)]: book, [E.key(hi)]: book };
  const [o] = E.build({ perps: [lo, hi], spots: [], settings: s, hist, books, now });
  assert.ok(o.persist.consec >= 3);
  assert.deepEqual(o.conditions.filter((c) => c.pass !== true).map((c) => c.id), []);
  assert.equal(o.alertable, true);

  const bad = perp('gate', 0.0004, 8, { status: 'delisting', note: 'Delists soon' });
  const [o2] = E.build({ perps: [lo, bad], spots: [], settings: s, hist: { [E.key(lo)]: hist[E.key(lo)], [E.key(bad)]: hist[E.key(hi)] }, books: { [E.key(lo)]: book, [E.key(bad)]: book }, now });
  assert.equal(o2.alertable, false);
  assert.ok(o2.flags.some((f) => f.id === 'delist'));
  assert.ok(o2.score < o.score);
});

test('margin: liquidation distance and stressed utilization', () => {
  const s = settings({ structures: { perp: true, carry: false, reverse: false }, carryBasis: 'current', leverage: 10, stressSigma: 3 });
  const lo = perp('okx', 0, 8, { mmr: 0.01 });
  const hi = perp('gate', 0.0004, 8, { mmr: 0.02, hi: 110, lo: 90 });
  const [o] = E.build({ perps: [lo, hi], spots: [], settings: s });
  close(o.liqDistPct, (0.1 - 0.02) * 100); // binding leg has the higher maintenance rate
  const sigma = Math.log(110 / 90) / Math.sqrt(4 * Math.log(2));
  close(o.sigmaD, sigma);
  assert.equal(o.stressUtil, Infinity); // a 3σ day (~30%) is more than a 10x leg can take
  assert.ok(o.flags.some((f) => f.id === 'margin'));
});

test('robust z does not explode when funding sits on its floor', () => {
  const a = Array(80).fill(1).concat([2, 0, 3, 1]);
  const z = FAS.stats.robustZ(1.5, a); // MAD is 0 here; the std floor keeps z finite and modest
  assert.ok(isFinite(z) && Math.abs(z) < 5, String(z));
});

test('rate-only fallback carries the venue interval', () => {
  const pred = { kPEPE: { BinPerp: { fundingRate: '0.0002', nextFundingTime: 1, fundingIntervalHours: 4 } } };
  const [m] = FAS.rateOnlyFrom(pred, 'binance');
  assert.equal(m.base, 'PEPE');
  assert.equal(m.intervalH, 4);
  assert.equal(m.rateOnly, true);
});
