// Full backtest of the selected rule set, with robustness and cost stress tests.
// node tools/backtest/strategy.js bt-data.json wfo-results.json strategy-results.json
const fs = require('fs');
const { prep, buildPairs, simulate, BOUNDS } = require('./run.js');

const STOCKS = 'AAOI BZ CL CRCL CXMT DRAM EWY INTC KORU MSTR MU NBIS NVDA OPENAI QQQ SAMSUNG SKHY SKHYNIX SNDK SNXX SOXL SOXS SPCX TSLA UNITREE XAG XAU XAUT'.split(' ');
const RULES = { slots: 2, structures: ['perp', 'carry'], costAwareExit: true, minHoldWindows: 9, exclude: STOCKS };
const CFG = { edgeHaircut: 0.5, makerShare: 0.5 };

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
BOUNDS.start = data.since; BOUNDS.end = Math.floor(data.t / 36e5) * 36e5;
const legs = prep(data), pairs = buildPairs(legs);
const w = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const unseen = { from: w.folds[0].testFrom, to: w.folds[w.folds.length - 1].testTo };

const run = (o = {}, cfg = {}) => simulate(legs, pairs, Object.assign({}, RULES, o, { cfg: Object.assign({}, CFG, cfg) }));
const brief = (r) => ({ pnl: r.stats.pnl, apr: r.stats.aprPct, dd: r.stats.maxDrawdownPct, trades: r.stats.trades, win: r.stats.winRate, sharpe: r.stats.sharpe, ledger: r.ledger });

const main = run();
const out = { rules: RULES, cfg: CFG, main: { stats: main.stats, ledger: main.ledger, equity: main.equity, trades: main.trades, rebalances: main.rebalances, resizes: main.resizes, liquidations: main.liquidations, grid: main.grid }, tests: [] };
const T = (group, name, r) => { out.tests.push({ group, name, ...brief(r) }); console.log(group.padEnd(12), name.padEnd(46), JSON.stringify(brief(r)).slice(0, 140)); };

T('Period', 'Full period', main);
T('Period', 'Unseen walk-forward period only', run(unseen));
T('Period', 'Without BTW', run({ exclude: STOCKS.concat(['BTW']) }));
T('Period', 'Without ZRO', run({ exclude: STOCKS.concat(['ZRO']) }));
T('Period', 'Without BTW and ZRO', run({ exclude: STOCKS.concat(['BTW', 'ZRO']) }));
T('Execution', 'All taker fills', run({}, { makerShare: 0 }));
T('Execution', 'All maker fills', run({}, { makerShare: 1 }));
T('Costs', 'Slippage doubled', run({}, { slipScale: 2 }));
T('Costs', 'Fees +50%', run({}, { feeScale: 1.5 }));
T('Costs', 'Transfers $5 each', run({}, { withdrawUsd: 5 }));
T('Rules', 'Minimum hold 2 days', run({ minHoldWindows: 6 }));
T('Rules', 'Minimum hold 5 days', run({ minHoldWindows: 15 }));
T('Rules', 'No spread haircut', run({}, { edgeHaircut: 1 }));
T('Rules', 'Haircut 70%', run({}, { edgeHaircut: 0.3 }));
T('Rules', '3 slots', run({ slots: 3 }));
T('Rules', 'Perp-perp only', run({ structures: ['perp'] }));
T('Rules', 'Leverage 3x', run({}, { leverage: 3 }));
fs.writeFileSync(process.argv[4], JSON.stringify(out));
