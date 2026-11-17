// In-depth backtest of the patient-carry rules at 5x per perp leg, with intra-hour liquidation
// checks, delayed margin transfers, cost and execution stress tests, start-date sensitivity and a
// bootstrap of the year.
// node tools/backtest/study5x.js yr-data.json study5x-results.json [designStartISO]
// node tools/backtest/study5x.js yr-data.json --legs     # list the markets any variant holds
const fs = require('fs');
const { prep, buildPairs, simulate, BOUNDS } = require('./run.js');

const STOCKS = 'AAOI BZ CL CRCL CXMT DRAM EWY INTC KORU MSTR MU NBIS NVDA OPENAI QQQ SAMSUNG SKHY SKHYNIX SNDK SNXX SOXL SOXS SPCX TSLA UNITREE XAG XAU XAUT'.split(' ');
// Tokenized stocks, ETFs and commodities listed since the rules were frozen (the rules meant crypto only).
const STOCKS_NEW = 'AAPL AMD AMZN ANTHROPIC ARM ASTS AVGO AXTI BE BMNR CBRS COHR COIN CRWV DELL GLW GOOGL HOOD IREN LITE META MINIMAX MRVL MSFT MUU MVLL NG ORCL PAXG PLTR QCOM RKLB SPY SQQQ TSM UVXY WDC ZHIPU ZHONGJI'.split(' ');
const RULES = { slots: 2, structures: ['perp', 'carry'], costAwareExit: true, minHoldWindows: 9, exclude: STOCKS };
// Realistic base: 5x, half maker fills, liquidation checked at each hour's worst price, and a
// margin top-up that lands one hour after it is triggered.
const REAL = { edgeHaircut: 0.5, makerShare: 0.5, minVol30: 5e6, slipTimeScale: true, leverage: 5, wicks: true, transferDelayH: 1 };
const DESIGN_START = Date.parse(process.argv[4] || '2026-07-24T16:00:00Z');
const legsMode = process.argv[3] === '--legs';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
BOUNDS.start = data.since; BOUNDS.end = Math.floor(data.t / 36e5) * 36e5;
const legs = prep(data), allPairs = buildPairs(legs);
const pairsFor = (lev) => allPairs.filter((p) => [p.long, p.short].every((l) => l.kind !== 'perp' || !l.maxLev || l.maxLev >= lev));
const run = (o = {}, cfg = {}) => {
  const c = Object.assign({}, REAL, cfg);
  return simulate(legs, pairsFor(c.leverage), Object.assign({}, RULES, o, { cfg: c }));
};

const VARIANTS = [
  // [group, name, rules override, cfg override]
  ['Realism', 'Original assumptions: hourly closes, instant transfers', {}, { wicks: false, transferDelayH: 0 }],
  ['Realism', 'Intra-hour highs and lows, instant transfers', {}, { transferDelayH: 0 }],
  ['Realism', 'Realistic base: intra-hour prices, 1h transfers', {}, {}],
  ['Realism', 'Transfers take 4 hours', {}, { transferDelayH: 4 }],
  ['Realism', 'Transfers take 12 hours (withdrawals paused)', {}, { transferDelayH: 12 }],
  ['Realism', 'Top up earlier (at 70% of margin)', {}, { rebalanceAt: 0.7 }],
  ['Execution', 'All taker fills', {}, { makerShare: 0 }],
  ['Execution', 'All maker fills', {}, { makerShare: 1 }],
  ['Costs', 'Slippage doubled', {}, { slipScale: 2 }],
  ['Costs', 'Slippage tripled', {}, { slipScale: 3 }],
  ['Costs', 'Fees +50%', {}, { feeScale: 1.5 }],
  ['Costs', 'Fee tier 40% cheaper', {}, { feeScale: 0.6 }],
  ['Costs', 'Transfers $5 each', {}, { withdrawUsd: 5 }],
  ['Costs', 'Everything worse: taker, 2x slippage, fees +50%, $5 and 4h transfers', {}, { makerShare: 0, slipScale: 2, feeScale: 1.5, withdrawUsd: 5, transferDelayH: 4 }],
  ['Universe', 'Crypto only (stock list extended to newer listings)', { exclude: STOCKS.concat(STOCKS_NEW) }, {}],
  ['Universe', 'Liquidity floor $10M a day', {}, { minVol30: 1e7 }],
  ['Universe', 'Liquidity floor $2M a day', {}, { minVol30: 2e6 }],
  ['Rules', '3 slots', { slots: 3 }, {}],
  ['Rules', 'Cross-exchange perp-perp only', { structures: ['perp'] }, {}],
  ['Rules', 'Same-exchange cash-and-carry only', { structures: ['carry'] }, {}],
  ['Leverage', '3x', {}, { leverage: 3 }],
  ['Leverage', '4x', {}, { leverage: 4 }],
  ['Leverage', '6x', {}, { leverage: 6 }],
  ['Period', 'Before the rules were designed (out-of-sample)', { to: DESIGN_START }, {}],
  ['Period', 'Design period', { from: DESIGN_START }, {}],
];
// Start-date sensitivity: begin trading on the 1st of each month and run to the end.
const starts = [];
for (let d = new Date(BOUNDS.start + 6 * 864e5); d.getTime() < BOUNDS.end - 60 * 864e5;) {
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  if (d.getTime() < BOUNDS.end - 60 * 864e5) starts.push(d.getTime());
}

if (legsMode) {
  const keys = new Set();
  const add = (r) => { for (const t of r.trades) { const p = allPairs.find((x) => x.id === t.pair); keys.add(p.long.key); keys.add(p.short.key); } };
  for (const [, , o, c] of VARIANTS) add(run(o, c));
  for (const s of starts) add(run({ from: s }));
  console.log(JSON.stringify([...keys]));
  process.exit(0);
}

const brief = (r) => ({ pnl: r.stats.pnl, apr: r.stats.aprPct, ret: r.stats.returnPct, dd: r.stats.maxDrawdownPct, sharpe: r.stats.sharpe, trades: r.stats.trades, win: r.stats.winRate, days: r.stats.days, liq: r.liquidations, rebal: r.rebalances, ledger: r.ledger, wickMiss: r.wickMiss });
const out = { rules: RULES, cfg: REAL, designStart: DESIGN_START, bounds: [BOUNDS.start, BOUNDS.end], tests: [] };
const T = (group, name, r) => { const b = brief(r); out.tests.push({ group, name, ...b }); console.error(group.padEnd(10), name.slice(0, 60).padEnd(61), `pnl ${b.pnl} apr ${b.apr}% dd ${b.dd}% sh ${b.sharpe} tr ${b.trades} liq ${b.liq} reb ${b.rebal} miss ${b.wickMiss}`); return r; };

let main;
for (const [g, n, o, c] of VARIANTS) { const r = T(g, n, run(o, c)); if (n.startsWith('Realistic base')) main = r; }
// Without the best assets (by total P&L in the realistic run).
const byAsset = {};
for (const t of main.trades) byAsset[t.base] = (byAsset[t.base] || 0) + t.total;
const ranked = Object.entries(byAsset).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
T('Universe', `Without the best asset (${ranked[0]})`, run({ exclude: STOCKS.concat([ranked[0]]) }));
T('Universe', `Without the two best assets (${ranked.slice(0, 2).join(', ')})`, run({ exclude: STOCKS.concat(ranked.slice(0, 2)) }));

out.starts = starts.map((s) => { const r = run({ from: s }); return { from: s, days: r.stats.days, pnl: r.stats.pnl, apr: r.stats.aprPct, dd: r.stats.maxDrawdownPct, trades: r.stats.trades, liq: r.liquidations }; });
for (const s of out.starts) console.error('start', new Date(s.from).toISOString().slice(0, 10), `apr ${s.apr}% dd ${s.dd}% trades ${s.trades} liq ${s.liq}`);

// Daily equity, drawdown and monthly P&L of the realistic run.
const daily = main.equity.filter((e, i) => i % 3 === 2 || i === main.equity.length - 1).map((e) => [e[0], e[1], e[2]]);
let peak = 10000;
out.daily = daily.map(([t, v, n]) => { peak = Math.max(peak, v); return [t, v, +((v / peak - 1) * 100).toFixed(3), n]; });
const months = new Map();
let prev = 10000;
for (const [t, v] of daily) { const m = new Date(t - 1).toISOString().slice(0, 7); if (!months.has(m)) months.set(m, { start: prev }); months.get(m).end = v; prev = v; }
out.monthly = [...months].map(([m, x]) => ({ month: m, pnl: +(x.end - x.start).toFixed(2), pct: +((x.end / x.start - 1) * 100).toFixed(2) }));

// Block bootstrap of daily returns: 5,000 synthetic years from 7-day blocks of the realistic run.
const rets = [];
for (let i = 1; i < daily.length; i++) rets.push(daily[i][1] / daily[i - 1][1] - 1);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const sims = [];
for (let s = 0; s < 5000; s++) {
  let eq = 1, pk = 1, mdd = 0;
  for (let d = 0; d < 365;) { const st = Math.floor(rnd() * (rets.length - 7)); for (let j = 0; j < 7 && d < 365; j++, d++) { eq *= 1 + rets[st + j]; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); } }
  sims.push([eq - 1, mdd]);
}
const pct = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(q * (a.length - 1))]; };
const R = sims.map((x) => x[0] * 100), DD = sims.map((x) => x[1] * 100);
out.bootstrap = { n: sims.length, ret: [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => +pct(R, q).toFixed(2)), dd: [0.05, 0.5, 0.95].map((q) => +pct(DD, q).toFixed(2)), pLoss: +(R.filter((x) => x < 0).length / R.length * 100).toFixed(1), hist: (() => { const h = {}; for (const r of R) { const b = Math.floor(r); h[b] = (h[b] || 0) + 1; } return h; })() };
console.error('bootstrap', JSON.stringify(out.bootstrap.ret), 'dd', JSON.stringify(out.bootstrap.dd), 'P(loss)', out.bootstrap.pLoss);

out.main = { stats: main.stats, ledger: main.ledger, rebalances: main.rebalances, liquidations: main.liquidations, resizes: main.resizes, wickMiss: main.wickMiss,
  trades: main.trades.map((t) => ({ ...t, maxLev: undefined })) };
// P&L by venue pair and by asset.
const by = (f) => { const m = {}; for (const t of main.trades) { const k = f(t); m[k] = m[k] || { pnl: 0, n: 0, funding: 0 }; m[k].pnl += t.total; m[k].n++; m[k].funding += t.funding; } return Object.entries(m).map(([k, v]) => ({ k, pnl: +v.pnl.toFixed(2), n: v.n, funding: +v.funding.toFixed(2) })).sort((a, b) => b.pnl - a.pnl); };
out.byAsset = by((t) => t.base);
out.byVenues = by((t) => t.structure === 'carry' ? `${t.short} spot+perp` : `${t.long} long / ${t.short} short`);
fs.writeFileSync(process.argv[3], JSON.stringify(out));
