// Walk-forward optimization: pick settings on a trailing training window using only past data,
// trade them on the next unseen window, roll forward. The stitched test windows are the
// out-of-sample result. node tools/backtest/wfo.js bt-data.json wfo-results.json
const fs = require('fs');
const { prep, buildPairs, simulate, CFG, BOUNDS } = require('./run.js');
const DAY = 864e5, HOUR = 36e5;

const TRAIN_DAYS = 28, TEST_DAYS = 14;
const GRID = {
  slots: [2, 3, 5],
  structures: [['perp', 'carry'], ['perp'], ['carry']],
  exitWindows: [3, 6, 12],
  hurdle: [0.001, 0.003, 0.006],
  minHit: [0.5, 0.65, 0.8],
  lookback: [9, 21, 42],
};
const EXEC = { taker: 0, halfMaker: 0.5 };

function combos() {
  const out = [];
  for (const slots of GRID.slots) for (const structures of GRID.structures) for (const exitWindows of GRID.exitWindows)
    for (const hurdle of GRID.hurdle) for (const minHit of GRID.minHit) for (const lookback of GRID.lookback)
      out.push({ slots, structures, exitWindows, hurdle, minHit, lookback });
  return out;
}
const key = (c) => `${c.slots}|${c.structures.join('+')}|${c.exitWindows}|${c.hurdle}|${c.minHit}|${c.lookback}`;
const run = (legs, pairs, c, maker, from, to) => simulate(legs, pairs, {
  slots: c.slots, structures: c.structures, exitWindows: c.exitWindows, from, to,
  cfg: { hurdle: c.hurdle, minHit: c.minHit, lookback: c.lookback, makerShare: maker },
});
const BASE = { slots: 3, structures: ['perp', 'carry'], exitWindows: 3, hurdle: 0.001, minHit: 0.6, lookback: 21 };

(function main() {
  const [inPath, outPath] = process.argv.slice(2);
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  BOUNDS.start = data.since;
  BOUNDS.end = Math.floor(data.t / HOUR) * HOUR;
  const legs = prep(data);
  const pairs = buildPairs(legs);
  const B8 = 8 * HOUR;
  const g0 = Math.ceil(BOUNDS.start / B8) * B8 + CFG.warmupWindows * B8; // first tradable window
  const end = Math.floor(BOUNDS.end / B8) * B8;
  const folds = [];
  for (let ts = g0 + TRAIN_DAYS * DAY; ts < end - 3 * DAY; ts += TEST_DAYS * DAY) {
    folds.push({ trainFrom: ts - TRAIN_DAYS * DAY, trainTo: ts, testFrom: ts, testTo: Math.min(end, ts + TEST_DAYS * DAY) });
  }
  // Absorb a short tail into the last fold.
  const last = folds[folds.length - 1];
  if (end - last.testTo < 7 * DAY) last.testTo = end;
  const C = combos();
  console.error(`${C.length} settings x ${folds.length} folds x ${Object.keys(EXEC).length} execution modes`);

  const out = { trainDays: TRAIN_DAYS, testDays: TEST_DAYS, grid: GRID, combos: C.length, folds: [], exec: {} };
  for (const [mode, maker] of Object.entries(EXEC)) {
    const res = { folds: [], oos: { pnl: 0, trades: 0, ledger: { funding: 0, price: 0, fees: 0, slippage: 0, transfers: 0 } }, base: { pnl: 0 }, top10: { pnl: 0 }, equity: [], baseEquity: [] };
    let eq = 10000, beq = 10000;
    for (const f of folds) {
      const t0 = Date.now();
      const scored = C.map((c) => {
        const r = run(legs, pairs, c, maker, f.trainFrom, f.trainTo);
        return { c, pnl: r.stats.trades >= 3 ? r.stats.pnl : -Infinity, trades: r.stats.trades, sharpe: r.stats.sharpe };
      }).sort((a, b) => b.pnl - a.pnl);
      const best = scored[0];
      // Forward rule: if nothing made money in training, stay in cash for the test window.
      const flat = !(best.pnl > 0);
      const test = flat ? null : run(legs, pairs, best.c, maker, f.testFrom, f.testTo);
      const base = run(legs, pairs, BASE, maker, f.testFrom, f.testTo);
      // Selection noise: how the 10 best training settings did out of sample, on average.
      const top = scored.slice(0, 10).filter((x) => x.pnl > 0);
      const topOos = top.map((x) => run(legs, pairs, x.c, maker, f.testFrom, f.testTo).stats.pnl);
      const topMean = topOos.length ? topOos.reduce((a, b) => a + b, 0) / topOos.length : 0;
      const pnl = test ? test.stats.pnl : 0;
      res.folds.push({ ...f, chosen: flat ? null : best.c, chosenKey: flat ? 'cash' : key(best.c), trainPnl: best.pnl, trainTrades: best.trades,
        testPnl: pnl, testTrades: test ? test.stats.trades : 0, testLedger: test ? test.ledger : null, baseTestPnl: base.stats.pnl, top10TestMean: +topMean.toFixed(2),
        trades: test ? test.trades : [] });
      res.oos.pnl += pnl; res.oos.trades += test ? test.stats.trades : 0;
      if (test) for (const k of Object.keys(res.oos.ledger)) res.oos.ledger[k] += test.ledger[k];
      res.base.pnl += base.stats.pnl; res.top10.pnl += topMean;
      const startEq = eq, startB = beq;
      if (test) for (const e of test.equity) res.equity.push([e[0], +(startEq + e[1] - 10000).toFixed(2)]);
      else res.equity.push([f.testTo, startEq]);
      for (const e of base.equity) res.baseEquity.push([e[0], +(startB + e[1] - 10000).toFixed(2)]);
      eq += pnl; beq += base.stats.pnl;
      console.error(`${mode} fold ${new Date(f.testFrom).toISOString().slice(0, 10)}..${new Date(f.testTo).toISOString().slice(0, 10)}: chosen ${flat ? 'cash' : key(best.c)} train ${best.pnl.toFixed(0)} -> test ${pnl.toFixed(2)} (base ${base.stats.pnl.toFixed(2)}, top10 mean ${topMean.toFixed(2)}) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    // The settings to trade now: optimized on the most recent training window.
    const now = C.map((c) => ({ c, r: run(legs, pairs, c, maker, end - TRAIN_DAYS * DAY, end) }))
      .filter((x) => x.r.stats.trades >= 3).sort((a, b) => b.r.stats.pnl - a.r.stats.pnl);
    res.current = now.slice(0, 5).map((x) => ({ c: x.c, key: key(x.c), pnl: x.r.stats.pnl, trades: x.r.stats.trades, sharpe: x.r.stats.sharpe }));
    // How often each setting value won a fold (stability).
    res.oosDays = (folds[folds.length - 1].testTo - folds[0].testFrom) / DAY;
    res.oos.aprPct = +((res.oos.pnl / 10000) * 365 / res.oosDays * 100).toFixed(1);
    res.base.aprPct = +((res.base.pnl / 10000) * 365 / res.oosDays * 100).toFixed(1);
    res.top10.aprPct = +((res.top10.pnl / 10000) * 365 / res.oosDays * 100).toFixed(1);
    out.exec[mode] = res;
    console.error(`${mode}: OOS ${res.oos.pnl.toFixed(2)} (${res.oos.aprPct}% APR) vs fixed base ${res.base.pnl.toFixed(2)} (${res.base.aprPct}%), top-10 mean ${res.top10.pnl.toFixed(2)}; now: ${res.current.map((x) => x.key + ' ' + x.pnl).join(' ; ')}`);
  }
  out.folds = folds;
  fs.writeFileSync(outPath, JSON.stringify(out));
})();
