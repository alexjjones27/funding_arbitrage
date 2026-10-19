// Tests targeted fixes (cost-aware exit, spread haircut, excluding tokenized stocks, maker fills)
// on the full period, without BTW, and on the unseen walk-forward period.
// node tools/backtest/fixes.js bt-data.json wfo-results.json fix-results.json
const fs = require('fs');
const { prep, buildPairs, simulate, BOUNDS } = require('./run.js');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
BOUNDS.start = data.since; BOUNDS.end = Math.floor(data.t / 36e5) * 36e5;
const legs = prep(data), pairs = buildPairs(legs);
const w = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const oosFrom = w.folds[0].testFrom, oosTo = w.folds[w.folds.length - 1].testTo;
const STOCKS = 'AAOI BZ CL CRCL CXMT DRAM EWY INTC KORU MSTR MU NBIS NVDA OPENAI QQQ SAMSUNG SKHY SKHYNIX SNDK SNXX SOXL SOXS SPCX TSLA UNITREE XAG XAU XAUT'.split(' ');
const base = { slots: 3, structures: ['perp', 'carry'] };
const S = [
  ['A. Base case (taker)', {}, {}],
  ['B. + cost-aware exit, 3-day minimum hold', { costAwareExit: true, minHoldWindows: 9 }, {}],
  ['C. + haircut expected spread by 50%', {}, { edgeHaircut: 0.5 }],
  ['D. + exclude tokenized stocks and commodities', { exclude: STOCKS }, {}],
  ['E. B + C + D (taker)', { costAwareExit: true, minHoldWindows: 9, exclude: STOCKS }, { edgeHaircut: 0.5 }],
  ['F. E + half maker fills', { costAwareExit: true, minHoldWindows: 9, exclude: STOCKS }, { edgeHaircut: 0.5, makerShare: 0.5 }],
  ['G. E + all maker fills', { costAwareExit: true, minHoldWindows: 9, exclude: STOCKS }, { edgeHaircut: 0.5, makerShare: 1 }],
  ['H. E with 2 slots', { costAwareExit: true, minHoldWindows: 9, exclude: STOCKS, slots: 2 }, { edgeHaircut: 0.5 }],
  ['I. E, 2 slots, half maker', { costAwareExit: true, minHoldWindows: 9, exclude: STOCKS, slots: 2 }, { edgeHaircut: 0.5, makerShare: 0.5 }],
];
const out = [];
for (const [name, o, cfg] of S) {
  const row = { name };
  for (const [tag, from, to] of [['full', null, null], ['excl. BTW', null, null], ['unseen', oosFrom, oosTo]]) {
    const opts = Object.assign({}, base, o, { cfg });
    if (from) { opts.from = from; opts.to = to; }
    if (tag === 'excl. BTW') opts.exclude = (opts.exclude || []).concat(['BTW']);
    const r = simulate(legs, pairs, opts);
    row[tag] = { pnl: r.stats.pnl, apr: r.stats.aprPct, dd: r.stats.maxDrawdownPct, trades: r.stats.trades, win: r.stats.winRate, ledger: r.ledger };
  }
  out.push(row);
  const f = (x) => `${x.pnl.toFixed(0).padStart(5)} (${x.apr.toFixed(1).padStart(5)}%) tr${String(x.trades).padStart(3)}`;
  console.log(name.padEnd(48), 'full', f(row.full), '| no BTW', f(row['excl. BTW']), '| unseen', f(row.unseen));
}
fs.writeFileSync(process.argv[4], JSON.stringify(out));
