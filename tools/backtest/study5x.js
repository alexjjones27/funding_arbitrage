// In-depth backtest of the patient-carry rules at 5x per perp leg, with intra-hour liquidation
// checks, delayed margin transfers, cost and execution stress tests, start-date sensitivity and a
// bootstrap of the year. Runs every test on three set-ups: 5x as designed, 5x with protection
// (only markets allowing 20x or more, and margin topped up at 80% instead of 50%), and 3x with the
// same protection.
// node tools/backtest/study5x.js yr-data-hl.json study5x-results.json [designStartISO]
// node tools/backtest/study5x.js yr-data.json --legs     # list the markets any variant holds
const fs = require('fs');
const { prep, buildPairs, simulate, BOUNDS } = require('./run.js');

const STOCKS = 'AAOI BZ CL CRCL CXMT DRAM EWY INTC KORU MSTR MU NBIS NVDA OPENAI QQQ SAMSUNG SKHY SKHYNIX SNDK SNXX SOXL SOXS SPCX TSLA UNITREE XAG XAU XAUT'.split(' ');
// Tokenized stocks, ETFs and commodities listed since the rules were frozen (the rules meant crypto only).
const STOCKS_NEW = 'AAPL AMD AMZN ANTHROPIC ARM ASTS AVGO AXTI BE BMNR CBRS COHR COIN CRWV DELL GLW GOOGL HOOD IREN LITE META MINIMAX MRVL MSFT MUU MVLL NG ORCL PAXG PLTR QCOM RKLB SPY SQQQ TSM UVXY WDC ZHIPU ZHONGJI'.split(' ');
const MAJORS = 'BTC ETH SOL XRP BNB DOGE ADA LINK LTC BCH TRX AVAX DOT SUI HYPE NEAR TON XLM'.split(' ');
const RULES = { slots: 2, structures: ['perp', 'carry'], costAwareExit: true, minHoldWindows: 9, exclude: STOCKS };
// Realistic base: half maker fills, liquidation checked at each hour's worst price, a margin top-up
// that lands within the hour after it is triggered, legs with gaps marked from the other venue,
// and new positions sized from the account's current value.
const REAL = { edgeHaircut: 0.5, makerShare: 0.5, minVol30: 5e6, slipTimeScale: true, leverage: 5, wicks: true, transferDelayH: 1, fillGaps: true, sizeFromEquity: true };
const DESIGN_START = Date.parse(process.argv[4] || '2026-07-24T16:00:00Z');
const legsMode = process.argv[3] === '--legs';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
BOUNDS.start = data.since; BOUNDS.end = Math.floor(data.t / 36e5) * 36e5;
const legs = prep(data), allPairs = buildPairs(legs);
const any = () => true;
const lev20 = (p) => [p.long, p.short].every((l) => l.kind !== 'perp' || (l.maxLev || 0) >= 20);
const majors = (p) => MAJORS.includes(p.base);
const SETUPS = {
  designed: { label: '5x as designed', filter: any, cfg: {} },
  protected: { label: '5x with protection', filter: lev20, cfg: { rebalanceAt: 0.8 } },
  protected3: { label: '3x with protection', filter: lev20, cfg: { leverage: 3, rebalanceAt: 0.8 } },
};
const run = (setup, o = {}, cfg = {}, filter = setup.filter) => {
  const c = Object.assign({}, REAL, setup.cfg, cfg);
  const ps = allPairs.filter((p) => [p.long, p.short].every((l) => l.kind !== 'perp' || !l.maxLev || l.maxLev >= c.leverage) && filter(p));
  return simulate(legs, ps, Object.assign({}, RULES, o, { cfg: c }));
};

const VARIANTS = [
  // [group, name, rules override, cfg override]
  ['Realism', 'Original assumptions: hourly closes, instant transfers', {}, { wicks: false, transferDelayH: 0, fillGaps: false, sizeFromEquity: false }],
  ['Realism', 'Intra-hour prices, top-ups land before the spike', {}, { transferDelayH: 0 }],
  ['Realism', 'Realistic base: intra-hour prices, top-ups land within the hour', {}, {}],
  ['Realism', 'Top-ups take 4 hours', {}, { transferDelayH: 4 }],
  ['Realism', 'Top-ups take 12 hours (withdrawals paused)', {}, { transferDelayH: 12 }],
  ['Execution', 'All taker fills', {}, { makerShare: 0 }],
  ['Execution', 'All maker fills', {}, { makerShare: 1 }],
  ['Costs', 'Slippage doubled', {}, { slipScale: 2 }],
  ['Costs', 'Slippage tripled', {}, { slipScale: 3 }],
  ['Costs', 'Fees +50%', {}, { feeScale: 1.5 }],
  ['Costs', 'Fee tier 40% cheaper', {}, { feeScale: 0.6 }],
  ['Costs', 'Transfers $5 each', {}, { withdrawUsd: 5 }],
  ['Costs', 'Everything worse: taker, 2x slippage, fees +50%, $5 and 4h top-ups', {}, { makerShare: 0, slipScale: 2, feeScale: 1.5, withdrawUsd: 5, transferDelayH: 4 }],
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
for (let d = new Date(BOUNDS.start + 6 * 864e5); ;) {
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  if (d.getTime() >= BOUNDS.end - 60 * 864e5) break;
  starts.push(d.getTime());
}
// How each protection does on its own, at 5x (and the same at lower leverage).
const PROTECTION = [
  ['5x as designed', any, {}],
  ['5x, top up at 80%', any, { rebalanceAt: 0.8 }],
  ['5x, top up at 90%', any, { rebalanceAt: 0.9 }],
  ['5x, only markets allowing 20x+', lev20, {}],
  ['5x, majors only', majors, {}],
  ['5x, majors only, top up at 80%', majors, { rebalanceAt: 0.8 }],
  ['5x, 20x+ markets, top up at 80% (protected)', lev20, { rebalanceAt: 0.8 }],
  ['5x, 20x+ markets, top up at 70%', lev20, { rebalanceAt: 0.7 }],
  ['5x, 20x+ markets, top up at 90%', lev20, { rebalanceAt: 0.9 }],
  ['4x, 20x+ markets, top up at 80%', lev20, { leverage: 4, rebalanceAt: 0.8 }],
  ['3x as designed', any, { leverage: 3 }],
  ['2x as designed (today)', any, { leverage: 2 }],
];

if (legsMode) {
  const keys = new Set();
  const add = (r) => { for (const t of r.trades) { const p = allPairs.find((x) => x.id === t.pair); keys.add(p.long.key); keys.add(p.short.key); } };
  for (const s of Object.values(SETUPS)) {
    for (const [, , o, c] of VARIANTS) add(run(s, o, c));
    for (const st of starts) add(run(s, { from: st }));
  }
  for (const [, f, c] of PROTECTION) add(run(SETUPS.designed, {}, c, f));
  console.log(JSON.stringify([...keys]));
  process.exit(0);
}

const brief = (r) => ({ pnl: r.stats.pnl, apr: r.stats.aprPct, ret: r.stats.returnPct, dd: r.stats.maxDrawdownPct, sharpe: r.stats.sharpe, trades: r.stats.trades, win: r.stats.winRate, days: r.stats.days, liq: r.liquidations, rebal: r.rebalances, ledger: r.ledger, wickMiss: r.wickMiss });
const pct = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(q * (a.length - 1))]; };

function study(key, setup) {
  const out = { label: setup.label, cfg: Object.assign({}, REAL, setup.cfg), tests: [] };
  const T = (group, name, r) => { const b = brief(r); out.tests.push({ group, name, ...b }); console.error(key.padEnd(9), group.padEnd(9), name.slice(0, 56).padEnd(57), `apr ${b.apr}% dd ${b.dd}% tr ${b.trades} liq ${b.liq} reb ${b.rebal} miss ${b.wickMiss}`); return r; };
  let main;
  for (const [g, n, o, c] of VARIANTS) { const r = T(g, n, run(setup, o, c)); if (n.startsWith('Realistic base')) main = r; }
  const byAsset = {};
  for (const t of main.trades) byAsset[t.base] = (byAsset[t.base] || 0) + t.total;
  const ranked = Object.entries(byAsset).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  T('Universe', `Without the best asset (${ranked[0]})`, run(setup, { exclude: STOCKS.concat([ranked[0]]) }));
  T('Universe', `Without the two best assets (${ranked.slice(0, 2).join(', ')})`, run(setup, { exclude: STOCKS.concat(ranked.slice(0, 2)) }));

  out.starts = starts.map((s) => { const r = run(setup, { from: s }); return { from: s, days: r.stats.days, pnl: r.stats.pnl, apr: r.stats.aprPct, dd: r.stats.maxDrawdownPct, trades: r.stats.trades, liq: r.liquidations }; });

  // Daily equity (with drawdown) and monthly P&L of the realistic run.
  const daily = main.equity.filter((e, i) => i % 3 === 2 || i === main.equity.length - 1).map((e) => [e[0], e[1], e[2]]);
  let peak = 10000;
  out.daily = daily.map(([t, v, n]) => { peak = Math.max(peak, v); return [t, v, +((v / peak - 1) * 100).toFixed(3), n]; });
  const months = new Map();
  let prev = 10000;
  for (const [t, v] of daily) { const m = new Date(t - 1).toISOString().slice(0, 7); if (!months.has(m)) months.set(m, { start: prev }); months.get(m).end = v; prev = v; }
  out.monthly = [...months].map(([m, x]) => ({ month: m, pnl: +(x.end - x.start).toFixed(2), pct: +((x.end / x.start - 1) * 100).toFixed(2) }));

  // Block bootstrap: 5,000 synthetic years built from 7-day blocks of the realistic run's daily returns.
  const rets = [];
  for (let i = 1; i < daily.length; i++) rets.push(daily[i][1] / daily[i - 1][1] - 1);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const R = [], DD = [];
  for (let s = 0; s < 5000; s++) {
    let eq = 1, pk = 1, mdd = 0;
    for (let d = 0; d < 365;) { const st = Math.floor(rnd() * (rets.length - 7)); for (let j = 0; j < 7 && d < 365; j++, d++) { eq *= 1 + rets[st + j]; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); } }
    R.push((eq - 1) * 100); DD.push(mdd * 100);
  }
  out.bootstrap = { n: R.length, ret: [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => +pct(R, q).toFixed(2)), dd: [0.05, 0.5, 0.95].map((q) => +pct(DD, q).toFixed(2)), pLoss: +(R.filter((x) => x < 0).length / R.length * 100).toFixed(1), pDown10: +(R.filter((x) => x < -10).length / R.length * 100).toFixed(1) };
  console.error(key, 'bootstrap', JSON.stringify(out.bootstrap));

  out.main = { stats: main.stats, ledger: main.ledger, rebalances: main.rebalances, liquidations: main.liquidations, resizes: main.resizes, wickMiss: main.wickMiss, trades: main.trades };
  const by = (f) => { const m = {}; for (const t of main.trades) { const k = f(t); m[k] = m[k] || { pnl: 0, n: 0, funding: 0 }; m[k].pnl += t.total; m[k].n++; m[k].funding += t.funding; } return Object.entries(m).map(([k, v]) => ({ k, pnl: +v.pnl.toFixed(2), n: v.n, funding: +v.funding.toFixed(2) })).sort((a, b) => b.pnl - a.pnl); };
  out.byAsset = by((t) => t.base);
  out.byVenues = by((t) => t.structure === 'carry' ? `${t.short} spot + perp` : `${t.long} long / ${t.short} short`);
  out.byReason = by((t) => t.reason);
  return out;
}

const result = { rules: RULES, real: REAL, designStart: DESIGN_START, bounds: [BOUNDS.start, BOUNDS.end], setups: {}, protection: [] };
for (const [k, s] of Object.entries(SETUPS)) result.setups[k] = study(k, s);
for (const [name, f, c] of PROTECTION) {
  const r = run(SETUPS.designed, {}, c, f), pre = run(SETUPS.designed, { to: DESIGN_START }, c, f);
  const row = { name, ...brief(r), oosApr: pre.stats.aprPct, oosLiq: pre.liquidations };
  result.protection.push(row);
  console.error('protect  ', name.padEnd(46), `apr ${row.apr}% dd ${row.dd}% liq ${row.liq} reb ${row.rebal} | oos ${row.oosApr}% liq ${row.oosLiq}`);
}
fs.writeFileSync(process.argv[3], JSON.stringify(result));
