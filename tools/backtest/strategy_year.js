// One-year walk-forward backtest of the patient-carry rules, frozen as designed, with
// point-in-time liquidity and liquidity-scaled slippage.
// node tools/backtest/strategy_year.js yr-data.json year-results.json [designStartISO]
const fs = require('fs');
const { prep, buildPairs, simulate, BOUNDS } = require('./run.js');

const STOCKS = 'AAOI BZ CL CRCL CXMT DRAM EWY INTC KORU MSTR MU NBIS NVDA OPENAI QQQ SAMSUNG SKHY SKHYNIX SNDK SNXX SOXL SOXS SPCX TSLA UNITREE XAG XAU XAUT'.split(' ');
const RULES = { slots: 2, structures: ['perp', 'carry'], costAwareExit: true, minHoldWindows: 9, exclude: STOCKS };
const CFG = { edgeHaircut: 0.5, makerShare: 0.5, minVol30: 5e6, slipTimeScale: true };
// The rules were designed on data from this date on, so everything before it is out-of-sample.
const DESIGN_START = Date.parse(process.argv[4] || '2026-07-24T16:00:00Z');

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
BOUNDS.start = data.since; BOUNDS.end = Math.floor(data.t / 36e5) * 36e5;
const legs = prep(data), pairs = buildPairs(legs);
console.error(`legs ${legs.length}, pairs ${pairs.length}`);

const run = (o = {}, cfg = {}) => simulate(legs, pairs, Object.assign({}, RULES, o, { cfg: Object.assign({}, CFG, cfg) }));
const brief = (r) => ({ pnl: r.stats.pnl, apr: r.stats.aprPct, ret: r.stats.returnPct, dd: r.stats.maxDrawdownPct, trades: r.stats.trades, win: r.stats.winRate, sharpe: r.stats.sharpe, days: r.stats.days, slots: r.stats.avgSlotsUsed, ledger: r.ledger, liq: r.liquidations });

function monthly(equity) {
  const out = [];
  let prevEq = 10000, cur = null;
  for (const [t, v] of equity) {
    const m = new Date(t).toISOString().slice(0, 7);
    if (cur && cur.m !== m) { out.push(cur); prevEq = cur.end; cur = null; }
    if (!cur) cur = { m, start: prevEq, end: v };
    cur.end = v;
  }
  if (cur) out.push(cur);
  return out.map((x) => ({ month: x.m, pnl: +(x.end - x.start).toFixed(2) }));
}

const main = run();
const out = {
  rules: RULES, cfg: CFG, designStart: DESIGN_START, legs: legs.length, pairs: pairs.length, venues: data.venues,
  main: { stats: main.stats, ledger: main.ledger, equity: main.equity.map((e) => [e[0], e[1], e[2]]), trades: main.trades, rebalances: main.rebalances, resizes: main.resizes, liquidations: main.liquidations, grid: main.grid, monthly: monthly(main.equity) },
  tests: [],
};
const T = (group, name, r) => { const b = brief(r); out.tests.push({ group, name, ...b }); console.error(group.padEnd(10), name.padEnd(52), `pnl ${b.pnl} apr ${b.apr}% dd ${b.dd}% trades ${b.trades} win ${b.win}% slots ${b.slots} liq ${b.liq}`); return r; };

T('Period', 'Full year', main);
const pre = T('Period', 'Before the rules were designed (out-of-sample)', run({ to: DESIGN_START }));
T('Period', 'Design period (last 3 months)', run({ from: DESIGN_START }));
// Rank assets by total P&L across all their trades.
const byAsset = {};
for (const t of main.trades) byAsset[t.base] = (byAsset[t.base] || 0) + t.total;
const ranked = Object.entries(byAsset).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
const worst = ranked[ranked.length - 1];
T('Period', `Without the best asset (${ranked[0]})`, run({ exclude: STOCKS.concat([ranked[0]]) }));
T('Period', `Without the two best assets (${ranked.slice(0, 2).join(', ')})`, run({ exclude: STOCKS.concat(ranked.slice(0, 2)) }));
T('Period', `Without the worst asset (${worst})`, run({ exclude: STOCKS.concat([worst]) }));
T('Execution', 'All taker fills', run({}, { makerShare: 0 }));
T('Execution', 'All maker fills', run({}, { makerShare: 1 }));
T('Costs', 'Slippage doubled', run({}, { slipScale: 2 }));
T('Costs', "Slippage from today's books, unscaled", run({}, { slipTimeScale: false }));
T('Costs', 'Fees +50%', run({}, { feeScale: 1.5 }));
T('Costs', 'Transfers $5 each', run({}, { withdrawUsd: 5 }));
T('Universe', 'Liquidity floor $10M a day', run({}, { minVol30: 1e7 }));
T('Universe', 'Liquidity floor $2M a day', run({}, { minVol30: 2e6 }));
T('Rules', '3 slots', run({ slots: 3 }));
T('Rules', 'Perp-perp only', run({ structures: ['perp'] }));
T('Rules', 'Cash-and-carry only', run({ structures: ['carry'] }));
T('Rules', 'Leverage 3x', run({}, { leverage: 3 }));
T('Rules', 'No spread haircut', run({}, { edgeHaircut: 1 }));
// Benchmark: the original screener rules (fast exit, 3 slots, taker) on the same year and data.
T('Benchmark', 'Original base-case rules (fast exit, taker)', simulate(legs, pairs, { slots: 3, structures: ['perp', 'carry'], exclude: STOCKS, cfg: { minVol30: 5e6, slipTimeScale: true } }));
out.preMonthly = monthly(pre.equity);
fs.writeFileSync(process.argv[3], JSON.stringify(out));
