// Walk-forward funding-arbitrage backtest on data from collect.js.
// node tools/backtest/run.js bt-data.json results.json
//
// Every 8h (UTC 00/08/16) the strategy ranks pairs using only data before that moment, exits
// positions whose carry has turned, and fills free slots. Positions hold fixed quantities on
// both legs; P&L is funding actually settled, price P&L of both legs from hourly closes, fees,
// book slippage at size, and transfer/gas costs to fund each venue and rebalance margin.
const fs = require('fs');
const load = require('../../tests/load.js');
const FAS = load(['util.js', 'engine.js']);
const E = FAS.engine;
const HOUR = FAS.HOUR, B8 = 8 * HOUR;

const CFG = {
  capital: 10000,
  leverage: 2,             // per perp leg
  warmupWindows: 15,       // 5 days of history before the first trade
  lookback: 21,            // 7 days of 8h windows for the signal
  holdHorizonWindows: 21,  // horizon the entry must pay back over
  hurdle: 0.0010,          // expected net over the horizon must exceed 10 bps of notional
  minHit: 0.6,             // share of lookback windows with positive carry
  minRecent: 3,            // most recent windows that must all be positive
  rebalanceAt: 0.5,
  resizeAbove: 1.5,        // trim both legs back to target notional when 50% over it        // top up a leg when its equity falls to 50% of initial margin
  maxPerAsset: 1,
  // Transfers: withdrawal fee from the source venue plus deposit gas at the destination.
  withdrawUsd: 1.0,
  depositGas: { okx: 0, bitget: 0, gate: 0, hyperliquid: 0.05, dydx: 0.1 }, // Arbitrum bridge / Noble-CCTP
  usdcVenues: { hyperliquid: true, dydx: true },
  usdcConvertBps: 2,       // USDT <-> USDC conversion on the way in
};
const FEES = FAS.defaults.fees;
const BOUNDS = {};

function interpSlip(leg, usd, side) {
  const pts = (leg.slip || []).filter((p) => isFinite(p[side]) && p[side] !== null);
  if (!pts.length) return Infinity;
  if (usd <= pts[0].usd) return pts[0][side];
  for (let i = 1; i < pts.length; i++) {
    if (usd <= pts[i].usd) {
      const a = pts[i - 1], b = pts[i];
      return a[side] + ((b[side] - a[side]) * (usd - a.usd)) / (b.usd - a.usd);
    }
  }
  // Beyond the largest measured size: scale the last finite point linearly (conservative).
  const last = pts[pts.length - 1];
  return last[side] * (usd / last.usd);
}
const makerFee = (leg) => (leg.kind === 'spot' ? FEES[leg.venue].spotMaker : FEES[leg.venue].perpMaker) / 100;
const fee = (leg) => (leg.kind === 'spot' ? FEES[leg.venue].spotTaker : FEES[leg.venue].perpTaker) / 100;
const transferUsd = (venue, amount) => CFG.withdrawUsd + (CFG.depositGas[venue] || 0) + (CFG.usdcVenues[venue] ? (amount * CFG.usdcConvertBps) / 1e4 : 0);

function prep(data) {
  const legs = data.legs.filter((l) => !l.error && l.candles && l.candles.length > 100 && (l.kind === 'spot' || (l.funding && l.funding.length > 10)));
  for (const l of legs) {
    l.fund = new Map((l.kind === 'perp' ? E.bucketize(l.funding, l.intervalH) : []).map((b) => [b.t, b.v]));
    l.px = l.candles.map((c) => [c[0], c[1] / (l.mult || 1)]); // per unit of underlying
    l.pxAt = new Map(l.px.map((c) => [c[0] + HOUR, c[1]])); // keyed by close time
  }
  return legs;
}
// Both legs' prices at the latest hour (at or before t, up to 6h back) where both venues have a
// candle, so a gap on one venue never marks the two legs at different times.
function pairPx(p, t) {
  for (let h = 0; h <= 6; h++) {
    const k = Math.floor(t / HOUR) * HOUR - h * HOUR;
    const a = p.long.pxAt.get(k), b = p.short.pxAt.get(k);
    if (a !== undefined && b !== undefined) return [a, b];
  }
  return null;
}

function buildPairs(legs) {
  const byBase = new Map();
  for (const l of legs) { if (!byBase.has(l.base)) byBase.set(l.base, []); byBase.get(l.base).push(l); }
  const pairs = [];
  for (const [base, ls] of byBase) {
    const perps = ls.filter((l) => l.kind === 'perp');
    for (const a of perps) for (const b of perps) {
      if (a.venue !== b.venue) pairs.push({ id: `perp:${a.key}>${b.key}`, structure: 'perp', base, long: a, short: b });
    }
    for (const p of perps) {
      const s = ls.find((l) => l.kind === 'spot' && l.venue === p.venue);
      if (s) pairs.push({ id: `carry:${s.key}>${p.key}`, structure: 'carry', base, long: s, short: p });
    }
  }
  return pairs;
}
// Carry in window t for the pair: short-leg funding received minus long-leg funding paid.
function carryAt(p, t) {
  const fs_ = p.short.kind === 'perp' ? p.short.fund.get(t) : 0;
  const fl = p.long.kind === 'perp' ? p.long.fund.get(t) : 0;
  if (fs_ === undefined || fl === undefined) return undefined;
  return fs_ - fl;
}

function sizing(structure, slotCapital) {
  // Perp-perp: half the slot as margin on each venue. Carry: spot notional plus perp margin.
  return structure === 'perp' ? (slotCapital / 2) * CFG.leverage : slotCapital / (1 + 1 / CFG.leverage);
}
function tradeCost(p, notional) {
  // A maker fill pays the maker fee and no slippage; the rest crosses the book as taker.
  const ms = CFG.makerShare || 0;
  const leg = (l, entrySide) => {
    const exitSide = entrySide === 'buy' ? 'sell' : 'buy';
    const sIn = interpSlip(l, notional, entrySide), sOut = interpSlip(l, notional, exitSide);
    const f = ms * makerFee(l) + (1 - ms) * fee(l);
    return { fees: 2 * f * notional, slip: (1 - ms) * ((sIn + sOut) / 1e4) * notional };
  };
  const a = leg(p.long, 'buy'), b = leg(p.short, 'sell');
  return { fees: a.fees + b.fees, slip: a.slip + b.slip, entryFees: (a.fees + b.fees) / 2, entrySlip: (a.slip + b.slip) / 2 };
}

function signal(p, k, grid, notional) {
  const hist = [];
  for (let j = k - CFG.lookback; j < k; j++) {
    if (j < 0) continue;
    const c = carryAt(p, grid[j]);
    if (c !== undefined) hist.push(c);
  }
  if (hist.length < Math.min(CFG.lookback, 12)) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const hit = hist.filter((x) => x > 0).length / hist.length;
  const recent = hist.slice(-CFG.minRecent);
  const last = hist[hist.length - 1];
  const edge = 0.5 * mean + 0.5 * last; // per 8h, the screener's blend of recent and 7d mean
  const c = tradeCost(p, notional);
  if (!isFinite(c.slip)) return null;
  const venues = p.structure === 'perp' ? [p.long.venue, p.short.venue] : [p.short.venue];
  const transfers = venues.reduce((a, v) => a + transferUsd(v, notional / CFG.leverage), 0);
  const expNet = edge * CFG.holdHorizonWindows - (c.fees + c.slip + transfers) / notional;
  return { mean, hit, last, edge, expNet, recentOk: recent.length === CFG.minRecent && recent.every((x) => x > 0), cost: c, transfers };
}

function simulate(legs, pairs, opts) {
  const saved = Object.assign({}, CFG);
  Object.assign(CFG, opts.cfg || {});
  try { return simulateInner(legs, pairs, opts); } finally { Object.assign(CFG, saved); }
}
function simulateInner(legs, pairs, opts) {
  const K = opts.slots;
  const slotCap = CFG.capital / K;
  const notionalFor = (p) => sizing(p.structure, slotCap);
  const allowed = (p) => opts.structures.includes(p.structure) && !(opts.exclude || []).includes(p.base);
  const universe = pairs.filter(allowed);
  const { start, end } = BOUNDS; // legs listed later simply have no prices before their listing
  // Common 8h grid
  const t0 = Math.ceil(start / B8) * B8;
  const grid = [];
  for (let t = t0; t + B8 <= end; t += B8) grid.push(t);

  const open = [];
  const trades = [];
  const equity = [];
  const ledger = { funding: 0, price: 0, fees: 0, slippage: 0, transfers: 0 };
  let realized = 0, rebalances = 0, liquidations = 0, resizes = 0;
  const firstTrade = CFG.warmupWindows;

  const closePos = (pos, t, reason) => {
    const c = pos.cost;
    const exitFees = c.fees - c.entryFees, exitSlip = c.slip - c.entrySlip;
    pos.pnl.fees -= exitFees; pos.pnl.slippage -= exitSlip;
    ledger.fees -= exitFees; ledger.slippage -= exitSlip;
    const total = pos.pnl.funding + pos.pnl.price + pos.pnl.fees + pos.pnl.slippage + pos.pnl.transfers;
    realized += total;
    trades.push({ pair: pos.p.id, base: pos.p.base, structure: pos.p.structure, long: pos.p.long.venue, short: pos.p.short.venue,
      entry: pos.entryT, exit: t, windows: pos.windows, notional: pos.notional, reason, ...roundPnl(pos.pnl), total: +total.toFixed(2),
      expNetBps: +(pos.expNet * 1e4).toFixed(1), rebalances: pos.rebalances, resizes: pos.resizes || 0 });
  };

  for (let k = firstTrade; k < grid.length; k++) {
    const T = grid[k];
    // 1) exits: carry turned (last 3 windows' mean below zero) or the forward signal no longer pays
    for (let i = open.length - 1; i >= 0 && !opts.forced; i--) {
      const pos = open[i];
      const sig = signal(pos.p, k, grid, pos.notional);
      const recent = [];
      const exitN = opts.exitWindows || 3;
      for (let j = k - exitN; j < k; j++) { const c = carryAt(pos.p, grid[j]); if (c !== undefined) recent.push(c); }
      const recentMean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
      if (!sig || recentMean < 0 || sig.edge <= 0) { closePos(pos, T, !sig ? 'data gap' : recentMean < 0 ? 'carry turned negative' : 'edge gone'); open.splice(i, 1); }
    }
    // 2) entries
    if (open.length < K && k < grid.length - 3 && !(opts.forced && k > firstTrade)) {
      const held = new Set(open.map((o) => o.p.base));
      const cands = [];
      for (const p of universe) {
        if (held.has(p.base)) continue;
        if (!pairPx(p, T)) continue;
        const s = signal(p, k, grid, notionalFor(p));
        if (opts.forced) {
          if (!opts.forced.includes(p.id)) continue;
          const n = notionalFor(p);
          const venues = p.structure === 'perp' ? [p.long.venue, p.short.venue] : [p.short.venue];
          cands.push({ p, s: { cost: tradeCost(p, n), transfers: venues.reduce((a, v) => a + transferUsd(v, n / CFG.leverage), 0), expNet: -opts.forced.indexOf(p.id) } });
          continue;
        }
        if (s && s.recentOk && s.hit >= CFG.minHit && s.expNet > CFG.hurdle) cands.push({ p, s });
      }
      cands.sort((a, b) => b.s.expNet - a.s.expNet);
      for (const { p, s } of cands) {
        if (open.length >= K) break;
        if (open.some((o) => o.p.base === p.base)) continue;
        const notional = notionalFor(p);
        const [pl0, ps0] = pairPx(p, T);
        const qty = notional / ((pl0 + ps0) / 2);
        const pos = { p, entryT: T, notional, qty, cost: s.cost, expNet: s.expNet, windows: 0, rebalances: 0,
          pxL: pl0, pxS: ps0,
          margin: { long: p.long.kind === 'perp' ? notional / CFG.leverage : 0, short: notional / CFG.leverage },
          legPnl: { long: 0, short: 0 },
          pnl: { funding: 0, price: 0, fees: -s.cost.entryFees, slippage: -s.cost.entrySlip, transfers: -s.transfers } };
        ledger.fees -= s.cost.entryFees; ledger.slippage -= s.cost.entrySlip; ledger.transfers -= s.transfers;
        open.push(pos);
      }
    }
    // 3) carry the window: funding at its settlement, prices hour by hour for margin checks
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const p = pos.p;
      let liquidated = false;
      for (let h = 1; h <= 8; h++) {
        const t = T + h * HOUR;
        const pp = pairPx(p, t);
        if (!pp) continue;
        const [pl, ps] = pp;
        const dL = pos.qty * (pl - pos.pxL), dS = -pos.qty * (ps - pos.pxS);
        pos.pxL = pl; pos.pxS = ps;
        pos.pnl.price += dL + dS; ledger.price += dL + dS;
        pos.legPnl.long += dL; pos.legPnl.short += dS;
        // Margin. Carry: one venue, unified account, so spot gains back the short perp directly.
        // Perp-perp: each leg stands alone on its venue; when one runs thin, pool both legs'
        // equity and split it evenly (one transfer), as a trader would.
        // Resize: a fixed-quantity hedge gains leverage as the price rises, so trim both legs
        // back to target notional once they run 50% over it, paying fees and slippage on the trim.
        const nowN = pos.qty * (pl + ps) / 2;
        if (nowN > CFG.resizeAbove * pos.notional) {
          const cut = nowN - pos.notional;
          const c = tradeCost(p, cut);
          pos.qty *= pos.notional / nowN;
          pos.pnl.fees -= c.entryFees; ledger.fees -= c.entryFees;
          pos.pnl.slippage -= c.entrySlip; ledger.slippage -= c.entrySlip;
          const costPer = (c.entryFees + c.entrySlip) / (p.structure === 'perp' ? 2 : 1);
          if (p.structure === 'perp') { pos.margin.long -= costPer; pos.margin.short -= costPer; } else pos.margin.short -= costPer;
          pos.resizes = (pos.resizes || 0) + 1; resizes++;
        }
        const mmrOf = (leg) => leg.mmr || (leg.maxLev ? 1 / (2 * leg.maxLev) : 0.01);
        const eqOf = (side) => pos.margin[side] + pos.legPnl[side] + (p.structure === 'carry' && side === 'short' ? pos.legPnl.long : 0);
        const reqOf = (side) => mmrOf(p[side]) * pos.qty * (side === 'long' ? pl : ps);
        const perpSides = ['long', 'short'].filter((sd) => p[sd].kind === 'perp');
        if (p.structure === 'perp' && perpSides.some((sd) => eqOf(sd) < Math.max(CFG.rebalanceAt * pos.margin[sd], 1.5 * reqOf(sd)))) {
          const total = eqOf('long') + eqOf('short');
          const thin = eqOf('long') < eqOf('short') ? 'long' : 'short';
          const cost = transferUsd(p[thin].venue, Math.abs(eqOf('long') - eqOf('short')) / 2);
          pos.margin.long = pos.margin.short = total / 2;
          pos.legPnl.long = pos.legPnl.short = 0;
          pos.pnl.transfers -= cost; ledger.transfers -= cost;
          pos.rebalances++; rebalances++;
        }
        for (const sd of perpSides) {
          const eq = eqOf(sd);
          if (eq <= reqOf(sd)) {
            // Liquidated: the venue keeps what is left of this leg's margin.
            const lost = Math.max(0, eq);
            pos.pnl.price -= lost; ledger.price -= lost;
            liquidated = true;
            break;
          }
        }
        if (liquidated) break;
      }
      const c = carryAt(p, T);
      if (c !== undefined) {
        const f = c * pos.qty * ((pos.pxL + pos.pxS) / 2);
        pos.pnl.funding += f; ledger.funding += f;
      }
      pos.windows++;
      if (liquidated) {
        liquidations++;
        closePos(pos, T + B8, 'liquidated');
        open.splice(i, 1);
      }
    }
    const unreal = open.reduce((a, o) => a + o.pnl.funding + o.pnl.price + o.pnl.fees + o.pnl.slippage + o.pnl.transfers, 0);
    equity.push([T + B8, +(CFG.capital + realized + unreal).toFixed(2), open.length]);
  }
  const lastT = grid[grid.length - 1] + B8;
  for (const pos of open.splice(0)) closePos(pos, lastT, 'end of test');
  equity.push([lastT, +(CFG.capital + realized).toFixed(2), 0]);
  return { opts, grid: [grid[firstTrade], lastT], equity, trades, ledger: roundPnl(ledger), rebalances, liquidations, resizes, stats: stats(equity, trades, grid[firstTrade], lastT) };
}

function roundPnl(o) { const r = {}; for (const k of Object.keys(o)) r[k] = +o[k].toFixed(2); return r; }
function stats(equity, trades, t0, t1) {
  const end = equity[equity.length - 1][1];
  const days = (t1 - t0) / FAS.DAY;
  let peak = CFG.capital, mdd = 0;
  for (const e of equity) { peak = Math.max(peak, e[1]); mdd = Math.min(mdd, e[1] / peak - 1); }
  const daily = [];
  for (let i = 3; i < equity.length; i += 3) daily.push(equity[i][1] / equity[i - 3][1] - 1);
  const m = daily.reduce((a, b) => a + b, 0) / (daily.length || 1);
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, daily.length - 1));
  const util = equity.reduce((a, e) => a + e[2], 0) / equity.length;
  return {
    days: +days.toFixed(1), endEquity: +end.toFixed(2), pnl: +(end - CFG.capital).toFixed(2),
    returnPct: +((end / CFG.capital - 1) * 100).toFixed(2), aprPct: +(((end / CFG.capital - 1) * 365) / days * 100).toFixed(1),
    maxDrawdownPct: +(mdd * 100).toFixed(2), sharpe: sd > 0 ? +((m / sd) * Math.sqrt(365)).toFixed(2) : null,
    trades: trades.length, winRate: trades.length ? +(trades.filter((t) => t.total > 0).length / trades.length * 100).toFixed(0) : null,
    avgHoldDays: trades.length ? +(trades.reduce((a, t) => a + t.windows, 0) / trades.length / 3).toFixed(1) : null,
    avgSlotsUsed: +util.toFixed(2),
  };
}

// Hindsight: rank pairs by the funding they actually paid over the test, net of one round trip,
// then simulate holding the top K (with the same margin, resize and liquidation rules).
function hindsightPicks(pairs, K, structures, from, to) {
  const res = [];
  for (const p of pairs.filter((x) => structures.includes(x.structure))) {
    const n = sizing(p.structure, CFG.capital / K);
    const c = tradeCost(p, n);
    let fund = 0, missing = 0;
    for (let t = from; t < to; t += B8) { const v = carryAt(p, t); if (v === undefined) missing++; else fund += v; }
    if (missing > 6 || !isFinite(c.slip) || !pairPx(p, from)) continue;
    res.push({ id: p.id, base: p.base, net: fund * n - c.fees - c.slip });
  }
  res.sort((a, b) => b.net - a.net);
  const picked = [];
  for (const r of res) { if (picked.length >= K) break; if (!picked.some((x) => x.base === r.base)) picked.push(r); }
  return picked.map((r) => r.id);
}

(function main() {
  const [inPath, outPath] = process.argv.slice(2);
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const legs = prep(data);
  BOUNDS.start = data.since;
  BOUNDS.end = Math.floor(data.t / HOUR) * HOUR;
  const pairs = buildPairs(legs);
  console.error(`legs ${legs.length}, pairs ${pairs.length}`);
  const runs = {};
  for (const [name, o] of Object.entries({
    main: { label: 'Base case: 3 slots, perp-perp + carry, taker fills, fast exit', slots: 3, structures: ['perp', 'carry'] },
    noBTW: { label: 'Base case without BTW (the largest winner)', slots: 3, structures: ['perp', 'carry'], exclude: ['BTW'] },
    concentrated: { label: '1 slot (all $10k in the best pair)', slots: 1, structures: ['perp', 'carry'] },
    diversified: { label: '5 slots', slots: 5, structures: ['perp', 'carry'] },
    perpOnly: { label: 'Perp-perp only', slots: 3, structures: ['perp'] },
    carryOnly: { label: 'Cash-and-carry only', slots: 3, structures: ['carry'] },
    slowExit: { label: 'Slow exit (hold until the 2-day mean turns negative)', slots: 3, structures: ['perp', 'carry'], exitWindows: 6 },
    maker50: { label: 'Half of fills as maker orders', slots: 3, structures: ['perp', 'carry'], cfg: { makerShare: 0.5 } },
    highHurdle: { label: 'Stricter entry (expected net > 50 bps over 7 days)', slots: 3, structures: ['perp', 'carry'], cfg: { hurdle: 0.005 } },
    best: { label: 'Slow exit + half maker + stricter entry', slots: 3, structures: ['perp', 'carry'], exitWindows: 6, cfg: { makerShare: 0.5, hurdle: 0.005 } },
  })) {
    runs[name] = simulate(legs, pairs, o);
    const s = runs[name].stats;
    console.error(name.padEnd(13), JSON.stringify(s), JSON.stringify(runs[name].ledger), 'rebal', runs[name].rebalances, 'liq', runs[name].liquidations, 'resize', runs[name].resizes);
  }
  const [from, to] = runs.main.grid;
  for (const K of [1, 3]) {
    const name = 'hindsight' + K;
    runs[name] = simulate(legs, pairs, { label: `Hindsight: the ${K} pair${K > 1 ? 's' : ''} that paid most, held throughout (not achievable)`, slots: K, structures: ['perp', 'carry'], forced: hindsightPicks(pairs, K, ['perp', 'carry'], from, to) });
    console.error(name.padEnd(13), JSON.stringify(runs[name].stats), JSON.stringify(runs[name].ledger), 'rebal', runs[name].rebalances, 'liq', runs[name].liquidations, 'resize', runs[name].resizes, runs[name].opts.forced.join(' | '));
  }
  fs.writeFileSync(outPath, JSON.stringify({ cfg: CFG, fees: FEES, dataT: data.t, legs: legs.length, pairs: pairs.length,
    venues: [...new Set(legs.map((l) => l.venue))], runs }));
})();
