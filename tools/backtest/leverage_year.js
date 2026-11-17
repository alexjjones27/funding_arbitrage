// Leverage sweep of the frozen patient-carry rules over the one-year data set, for the full
// strategy, cross-exchange perp-perp only, and same-venue cash-and-carry only.
// node tools/backtest/leverage_year.js yr-data.json leverage-results.json [designStartISO]
//
// Leverage sets notional per dollar of margin on each perp leg. Pairs whose venue caps leverage
// below the tested level are dropped at that level, since the trade could not be opened there.
const fs = require('fs');
const { prep, buildPairs, simulate, BOUNDS } = require('./run.js');

const STOCKS = 'AAOI BZ CL CRCL CXMT DRAM EWY INTC KORU MSTR MU NBIS NVDA OPENAI QQQ SAMSUNG SKHY SKHYNIX SNDK SNXX SOXL SOXS SPCX TSLA UNITREE XAG XAU XAUT'.split(' ');
const RULES = { slots: 2, structures: ['perp', 'carry'], costAwareExit: true, minHoldWindows: 9, exclude: STOCKS };
const CFG = { edgeHaircut: 0.5, makerShare: 0.5, minVol30: 5e6, slipTimeScale: true };
const DESIGN_START = Date.parse(process.argv[4] || '2026-07-24T16:00:00Z');
const LEVERAGE = [1, 1.5, 2, 3, 4, 5, 7, 10];
const STRUCTS = { 'Full strategy (perp-perp + carry)': ['perp', 'carry'], 'Cross-exchange perp-perp only': ['perp'], 'Same-venue cash-and-carry only': ['carry'] };

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
BOUNDS.start = data.since; BOUNDS.end = Math.floor(data.t / 36e5) * 36e5;
const legs = prep(data), pairs = buildPairs(legs);
console.error(`legs ${legs.length}, pairs ${pairs.length}`);
const supports = (p, lev) => [p.long, p.short].every((l) => l.kind !== 'perp' || !l.maxLev || l.maxLev >= lev);

const out = { rules: RULES, cfg: CFG, designStart: DESIGN_START, rows: [] };
for (const [label, structures] of Object.entries(STRUCTS)) {
  for (const lev of LEVERAGE) {
    const ps = pairs.filter((p) => supports(p, lev));
    for (const [period, o] of [['full', {}], ['oos', { to: DESIGN_START }], ['design', { from: DESIGN_START }]]) {
      const r = simulate(legs, ps, Object.assign({}, RULES, { structures }, o, { cfg: Object.assign({}, CFG, { leverage: lev }) }));
      // Gross notional per leg relative to capital, averaged over time while positions are open.
      const notional = r.trades.length ? r.trades.reduce((a, t) => a + t.notional * t.windows, 0) / r.trades.reduce((a, t) => a + t.windows, 0) : 0;
      const row = { structure: label, leverage: lev, period, pairs: ps.length, ...r.stats, ledger: r.ledger, liquidations: r.liquidations, rebalances: r.rebalances, avgNotionalPerSlot: +notional.toFixed(0) };
      out.rows.push(row);
      if (period === 'full' || period === 'oos') console.error(label.slice(0, 30).padEnd(31), `${lev}x`.padEnd(5), period.padEnd(4), `pnl ${row.pnl} apr ${row.aprPct}% dd ${row.maxDrawdownPct}% sharpe ${row.sharpe} trades ${row.trades} liq ${row.liquidations} rebal ${row.rebalances} fund ${row.ledger.funding} costs ${(row.ledger.fees + row.ledger.slippage + row.ledger.transfers).toFixed(0)}`);
    }
  }
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
