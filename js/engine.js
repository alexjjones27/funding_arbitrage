/* Screening engine: normalization, history bucketing, persistence, execution costs, margin,
 * comparability, scoring and alert conditions. Pure functions of the data, so it also runs
 * under Node for the tests.
 *
 * Units: funding values are fractions of notional. "8h" values are per 8 hours, so a 1h venue's
 * rate is multiplied by 8 and a 4h venue's by 2. bps = fraction * 1e4.
 */
(function (root) {
  'use strict';
  const FAS = root.FAS;
  const { HOUR, DAY, stats, clamp, isNum } = FAS;
  const E = (FAS.engine = {});
  const B8 = 8 * HOUR;

  E.norm8 = (rate, intervalH) => (isNum(rate) && intervalH > 0 ? (rate * 8) / intervalH : null);
  E.apr = (rate8) => (isNum(rate8) ? rate8 * 3 * 365 * 100 : null); // % per year from an 8h value
  E.key = (m) => m.venue + (m.kind === 'spot' ? ':spot:' : ':') + m.id;
  E.mid = (m) => (isNum(m.bid) && isNum(m.ask) && m.bid > 0 && m.ask >= m.bid ? (m.bid + m.ask) / 2 : (m.mark || m.last || null));
  E.unitPx = (m) => { const p = m.mark ?? E.mid(m); return isNum(p) ? p / (m.mult || 1) : null; };

  // ------------------------------------------------------------ history to 8h buckets
  // Settlement prints are assigned to the 8h UTC window they pay for (a print at 08:00 pays
  // for 00:00-08:00). Each print covers the hours since the previous print, so a venue that
  // switched from 8h to 4h mid-window, or a 1h venue, sums correctly. Windows with less than
  // 6 of 8 hours covered (the window in progress, gaps) are dropped.
  E.bucketize = function (rows, intervalH) {
    const map = new Map();
    let prevT = null;
    for (const p of rows || []) {
      const t = Math.round(p.t / 60e3) * 60e3;
      let ivl = intervalH || 8;
      if (prevT !== null) {
        const d = (t - prevT) / HOUR;
        if (d >= 0.9 && d <= 8.5) ivl = Math.round(d);
      }
      prevT = t;
      const k = Math.floor((t - 1) / B8) * B8;
      const b = map.get(k) || { sum: 0, hours: 0 };
      b.sum += p.r;
      b.hours += ivl;
      map.set(k, b);
    }
    const out = [];
    for (const [t, b] of map) if (b.hours >= 6) out.push({ t, v: (b.sum * 8) / Math.min(8, b.hours) });
    return out.sort((a, b) => a.t - b.t);
  };

  // Join two bucket series on time: a - b, only where both venues have the window.
  E.diffSeries = function (a, b) {
    const mb = new Map(b.map((x) => [x.t, x.v]));
    return a.filter((x) => mb.has(x.t)).map((x) => ({ t: x.t, v: x.v - mb.get(x.t) }));
  };
  E.negate = (s) => s.map((x) => ({ t: x.t, v: -x.v }));

  // Persistence of a signed 8h series where positive means the trade earns.
  E.seriesStats = function (series, thr) {
    if (!series || series.length < 3) return null;
    const v = series.map((x) => x.v);
    const tail = (k) => v.slice(-k);
    const frac = (k) => { const t = tail(k); return t.filter((x) => x > thr).length / t.length; };
    let consec = 0;
    for (let i = v.length - 1; i >= 0 && v[i] > thr; i--) consec++;
    let consecNeg = 0;
    for (let i = v.length - 1; i >= 0 && v[i] <= thr; i--) consecNeg++;
    const last = v[v.length - 1];
    const mean30 = stats.mean(tail(90));
    const std30 = stats.std(tail(90));
    return {
      n: v.length, last, consec, consecNeg,
      pct24: frac(3), pct48: frac(6), pct7d: frac(21),
      mean7: stats.mean(tail(21)), mean14: stats.mean(tail(42)), mean30,
      med7: stats.median(tail(21)), med30: stats.median(tail(90)),
      std7: stats.std(tail(21)), std30,
      cv: isNum(std30) && mean30 ? std30 / Math.abs(mean30) : null,
      z: stats.robustZ(last, v.slice(-91, -1)),
      cum7: stats.sum(tail(21)), cum30: stats.sum(tail(90)),
    };
  };

  // Per-leg funding history summary in its own terms.
  E.legStats = function (rows, m, now) {
    if (!rows || !rows.length) return null;
    now = now || FAS.now();
    const within = (d) => rows.filter((x) => x.t >= now - d * DAY);
    const m8 = (arr) => stats.mean(arr.map((x) => E.norm8(x.r, m.intervalH)));
    const series = E.bucketize(rows, m.intervalH);
    return {
      n: rows.length,
      last3: m8(rows.slice(-3)),
      mean7: m8(within(7)), mean14: m8(within(14)), mean30: m8(within(30)),
      cum1: stats.sum(within(1).map((x) => x.r)),
      cum7: stats.sum(within(7).map((x) => x.r)), cum30: stats.sum(within(30).map((x) => x.r)),
      series,
      positiveShare7: (() => { const w = within(7); return w.length ? w.filter((x) => x.r > 0).length / w.length : null; })(),
    };
  };

  // ------------------------------------------------------------ order books
  E.bookMid = (bk) => (bk && bk.bids.length && bk.asks.length ? (bk.bids[0][0] + bk.asks[0][0]) / 2 : null);
  E.bookSpreadBps = (bk) => {
    const mid = E.bookMid(bk);
    return mid ? ((bk.asks[0][0] - bk.bids[0][0]) / mid) * 1e4 : null;
  };
  // Average-price slippage versus mid for a market order of `usd` notional. side 'buy' lifts asks.
  E.slipBps = function (bk, usd, side) {
    const mid = E.bookMid(bk);
    if (!mid || !(usd > 0)) return null;
    const lv = side === 'buy' ? bk.asks : bk.bids;
    let rem = usd, qty = 0, cost = 0;
    for (const [px, q] of lv) {
      const take = Math.min(rem, px * q);
      cost += take;
      qty += take / px;
      rem -= take;
      if (rem <= 1e-9) break;
    }
    if (rem > 1e-6) return Infinity; // book shallower than the order
    const avg = cost / qty;
    return (side === 'buy' ? (avg - mid) / mid : (mid - avg) / mid) * 1e4;
  };
  // USD resting within `bps` of mid on each side; `complete` is false when the book stops short.
  E.depthUsd = function (bk, bps) {
    const mid = E.bookMid(bk);
    if (!mid) return null;
    const lo = mid * (1 - bps / 1e4), hi = mid * (1 + bps / 1e4);
    let bid = 0, ask = 0;
    for (const [px, q] of bk.bids) if (px >= lo) bid += px * q;
    for (const [px, q] of bk.asks) if (px <= hi) ask += px * q;
    const lastBid = bk.bids[bk.bids.length - 1][0], lastAsk = bk.asks[bk.asks.length - 1][0];
    return { bid, ask, min: Math.min(bid, ask), complete: lastBid <= lo && lastAsk >= hi };
  };

  // Parkinson daily volatility from the 24h high/low, the widest across the venues listing it.
  E.parkinson = function (legs) {
    let best = null;
    for (const m of legs) {
      if (!(m.hi > 0 && m.lo > 0 && m.hi >= m.lo)) continue;
      const s = Math.log(m.hi / m.lo) / Math.sqrt(4 * Math.log(2));
      if (best === null || s > best) best = s;
    }
    return best;
  };

  // ------------------------------------------------------------ per-leg pieces
  E.legRate8 = function (m, ls, basis) {
    const cur = E.norm8(m.rate, m.intervalH);
    const pred = isNum(m.predicted) ? E.norm8(m.predicted, m.intervalH) : null;
    const mean7 = ls && isNum(ls.mean7) ? ls.mean7 : null;
    if (basis === 'current') return cur;
    if (basis === 'predicted') return pred ?? cur;
    if (basis === 'mean7') return mean7 ?? cur;
    return mean7 !== null ? 0.5 * (pred ?? cur) + 0.5 * mean7 : (pred ?? cur);
  };

  // One leg's execution cost. `entrySide` is 'buy' for a long leg.
  function legCost(leg, s, books) {
    const m = leg.m;
    const f = (s.fees[m.venue] || {});
    const taker = (leg.kind === 'spot' ? f.spotTaker : f.perpTaker) ?? 0.1;
    const maker = (leg.kind === 'spot' ? f.spotMaker : f.perpMaker) ?? taker;
    const ms = clamp((s.makerSharePct || 0) / 100, 0, 1);
    const feeOne = (ms * maker + (1 - ms) * taker) / 100;
    const bk = books[E.key(m)] || null;
    const entrySide = leg.side === 'long' ? 'buy' : 'sell';
    const exitSide = leg.side === 'long' ? 'sell' : 'buy';
    let slipIn = null, slipOut = null, src = 'book', spreadBps = null;
    if (bk && bk.bids.length && bk.asks.length) {
      slipIn = E.slipBps(bk, s.notional, entrySide);
      slipOut = E.slipBps(bk, s.notional, exitSide);
      spreadBps = E.bookSpreadBps(bk);
    } else {
      const mid = E.mid(m);
      if (isNum(m.bid) && isNum(m.ask) && mid && !m.bidAskIsImpact) {
        spreadBps = ((m.ask - m.bid) / mid) * 1e4;
        slipIn = slipOut = spreadBps / 2;
        src = 'touch';
      } else {
        slipIn = slipOut = s.slipBudgetBps;
        src = 'assumed';
      }
    }
    const slipFrac = isFinite(slipIn) && isFinite(slipOut) ? ((1 - ms) * (slipIn + slipOut)) / 1e4 : Infinity;
    const depth = bk ? FAS.config.depthBandsBps.map((b) => ({ bps: b, ...E.depthUsd(bk, b) })) : null;
    return { feeOne, slipIn, slipOut, slipSrc: src, spreadBps, rt: 2 * feeOne + slipFrac, depth };
  }

  function legMargin(m, s, sigmaD) {
    const L = Math.max(1, Math.min(s.leverage, m.maxLev || Infinity));
    let mmr = m.mmr, src = m.mmrSrc || 'venue';
    if (!isNum(mmr)) {
      mmr = m.maxLev ? 1 / (2 * m.maxLev) : 0.005;
      src = 'estimate';
    }
    const liqDist = 1 / L - mmr;
    const move = isNum(sigmaD) ? s.stressSigma * sigmaD : null;
    let util = null;
    if (move !== null) {
      const equity = 1 / L - move;
      util = equity > 0 ? (mmr * (1 + move)) / equity : Infinity;
    }
    return { L, capped: L < s.leverage, mmr, mmrSrc: src, liqDist, liqSigma: isNum(sigmaD) && sigmaD > 0 ? liqDist / sigmaD : null, stressUtil: util };
  }

  // ------------------------------------------------------------ opportunities
  E.build = function (ctx) {
    const s = ctx.settings;
    const now = ctx.now || FAS.now();
    const hist = ctx.hist || {};
    const books = ctx.books || {};
    const thr = s.persistThrBps / 1e4;
    const venuesOn = (v) => s.venues[v] !== false;

    const legStatsCache = {};
    const ls = (m) => {
      const k = E.key(m);
      if (!(k in legStatsCache)) legStatsCache[k] = hist[k] ? E.legStats(hist[k].rows, m, now) : null;
      return legStatsCache[k];
    };

    const groups = new Map();
    for (const m of ctx.perps || []) {
      if (!venuesOn(m.venue) || !isNum(m.rate)) continue;
      if (m.rateOnly && !s.allowRateOnly) continue;
      if (!groups.has(m.base)) groups.set(m.base, []);
      groups.get(m.base).push(m);
    }
    const spotsBy = new Map();
    for (const x of ctx.spots || []) {
      if (!venuesOn(x.venue) || !(x.bid > 0 && x.ask > 0)) continue;
      if (!spotsBy.has(x.base)) spotsBy.set(x.base, []);
      spotsBy.get(x.base).push(x);
    }

    const out = [];
    let excluded = 0;
    let est, sigmaD; // per asset group, read by evaluate()
    for (const [base, legs] of groups) {
      const pxs = legs.map(E.unitPx).filter(isNum);
      const ref = stats.median(pxs);
      for (const m of legs) {
        const p = E.unitPx(m);
        m._dev = ref && isNum(p) ? Math.abs(p / ref - 1) * 100 : null;
      }
      const priceOk = (m) => m._dev === null || m._dev <= s.maxPriceDevPct;
      sigmaD = E.parkinson(legs);
      est = new Map(legs.map((m) => [m, E.legRate8(m, ls(m), s.carryBasis)]));

      const cands = [];
      if (s.structures.perp) {
        for (const lo of legs) for (const hi of legs) {
          if (lo === hi || lo.venue === hi.venue) continue;
          if (!(est.get(hi) > est.get(lo))) continue;
          if (!priceOk(lo) || !priceOk(hi)) { excluded++; continue; }
          cands.push(evaluate({ structure: 'perp', base, long: { kind: 'perp', side: 'long', m: lo }, short: { kind: 'perp', side: 'short', m: hi } }));
        }
      }
      const spotFor = (m) => {
        const list = (spotsBy.get(base) || []).filter((x) => {
          const p = E.mid(x) / (x.mult || 1);
          return !ref || Math.abs(p / ref - 1) * 100 <= s.maxPriceDevPct;
        });
        if (!list.length) return null;
        const same = list.filter((x) => x.venue === m.venue).sort((a, b) => (b.volUsd || 0) - (a.volUsd || 0));
        if (same.length) return same[0];
        return list.sort((a, b) => (b.volUsd || 0) - (a.volUsd || 0))[0];
      };
      for (const m of legs) {
        if (!priceOk(m) || m.type === 'inverse') continue;
        const r = est.get(m);
        if (s.structures.carry && r > 0) {
          const sp = spotFor(m);
          if (sp) cands.push(evaluate({ structure: 'carry', base, long: { kind: 'spot', side: 'long', m: sp }, short: { kind: 'perp', side: 'short', m } }));
        }
        if (s.structures.reverse && r < 0) {
          const sp = spotFor(m);
          if (sp) cands.push(evaluate({ structure: 'reverse', base, long: { kind: 'perp', side: 'long', m }, short: { kind: 'spot', side: 'short', m: sp } }));
        }
      }
      if (s.bestPairOnly) {
        const best = {};
        for (const o of cands) if (!best[o.structure] || o.netApr > best[o.structure].netApr) best[o.structure] = o;
        out.push(...Object.values(best));
      } else out.push(...cands);
    }
    out.excluded = excluded;
    return out;

    function evaluate(o) {
      const L = o.long, S = o.short;
      const perpLegs = [L, S].filter((x) => x.kind === 'perp');
      const allLegs = [L, S];
      o.key = o.structure + ':' + E.key(L.m) + '>' + E.key(S.m);

      // Funding: the trade earns short-leg funding and pays long-leg funding.
      const r8 = (leg, which) => {
        if (leg.kind !== 'perp') return 0;
        const m = leg.m;
        if (which === 'cur') return E.norm8(m.rate, m.intervalH);
        if (which === 'pred') return isNum(m.predicted) ? E.norm8(m.predicted, m.intervalH) : E.norm8(m.rate, m.intervalH);
        return est.get(m);
      };
      const spread = (w) => r8(S, w) - r8(L, w);
      o.gross8 = spread('est');
      o.grossCur8 = spread('cur');
      o.grossPred8 = spread('pred');
      o.grossBps8 = o.gross8 * 1e4;
      o.grossApr = E.apr(o.gross8);

      // Costs
      for (const leg of allLegs) leg.cost = legCost(leg, s, books);
      o.costRt = L.cost.rt + S.cost.rt;
      o.costRtBps = o.costRt * 1e4;
      let borrowApr = 0;
      o.borrowSrc = null;
      if (o.structure === 'reverse') {
        const b = ctx.borrow && ctx.borrow[S.m.venue] && ctx.borrow[S.m.venue][o.base];
        borrowApr = isNum(b) ? b : s.borrowAprPct;
        o.borrowSrc = isNum(b) ? S.m.venue + ' published rate' : 'assumed (Settings)';
      }
      const capApr = o.structure === 'carry' ? s.capitalCostAprPct || 0 : 0;
      o.borrowApr = borrowApr;
      const carryDaily = (borrowApr + capApr) / 100 / 365;
      const H = Math.max(1 / 3, s.holdDays);
      const periods = H * 3;
      const netFrac = o.gross8 * periods - o.costRt - carryDaily * H;
      o.netBps8 = (netFrac / periods) * 1e4;
      o.netApr = (netFrac / H) * 365 * 100;
      o.beBps8 = (o.costRt / periods + carryDaily / 3) * 1e4;
      const pnl = (d) => s.notional * (o.gross8 * 3 * d - o.costRt - carryDaily * d);
      o.pnl1 = pnl(1); o.pnl7 = pnl(7); o.pnl30 = pnl(30);
      o.breakEvenDays = o.gross8 * 3 - carryDaily > 0 ? o.costRt / (o.gross8 * 3 - carryDaily) : Infinity;

      // Margin and capital
      for (const leg of perpLegs) leg.margin = legMargin(leg.m, s, sigmaD);
      const lev = s.leverage;
      o.capital = o.structure === 'perp'
        ? s.notional / L.margin.L + s.notional / S.margin.L
        : o.structure === 'carry' ? s.notional + s.notional / S.margin.L
          : s.notional / L.margin.L + s.notional / lev;
      o.rocApr = o.netApr * (s.notional / o.capital);
      o.sigmaD = sigmaD;
      const binding = perpLegs.reduce((a, b) => (a.margin.liqDist <= b.margin.liqDist ? a : b));
      o.liqDistPct = binding.margin.liqDist * 100;
      o.liqSigma = binding.margin.liqSigma;
      o.stressUtil = Math.max(...perpLegs.map((x) => (isNum(x.margin.stressUtil) || x.margin.stressUtil === Infinity ? x.margin.stressUtil : -1)));
      if (o.stressUtil < 0) o.stressUtil = null;

      // Basis between the legs, per unit of underlying. Positive = the short leg is priced higher.
      const pL = E.unitPx(L.m) ?? (E.mid(L.m) / (L.m.mult || 1));
      const pS = E.unitPx(S.m) ?? (E.mid(S.m) / (S.m.mult || 1));
      o.basisBps = isNum(pL) && isNum(pS) ? ((pS - pL) / ((pS + pL) / 2)) * 1e4 : null;

      // Persistence on the trade's own spread series
      const h = (leg) => (leg.kind === 'perp' ? ls(leg.m) : null);
      const hL = h(L), hS = h(S);
      let series = null;
      if (o.structure === 'perp' && hL && hS) series = E.diffSeries(hS.series, hL.series);
      else if (o.structure === 'carry' && hS) series = hS.series;
      else if (o.structure === 'reverse' && hL) series = E.negate(hL.series);
      o.series = series;
      o.persist = series ? E.seriesStats(series, thr) : null;
      o.histLoaded = o.structure === 'perp' ? !!(hL && hS) : !!(hL || hS);

      // Liquidity, per leg on its own
      o.liq = allLegs.map((leg) => {
        const m = leg.m;
        const c = leg.cost;
        const r = { leg: leg.side, kind: leg.kind, oiUsd: leg.kind === 'perp' ? m.oiUsd : null, volUsd: m.volUsd, spreadBps: c.spreadBps, slipIn: c.slipIn, slipSrc: c.slipSrc };
        r.oiOk = leg.kind === 'spot' ? true : isNum(m.oiUsd) ? m.oiUsd >= s.minOiUsd : null;
        r.volOk = isNum(m.volUsd) ? m.volUsd >= s.minVolUsd : null;
        r.spreadOk = isNum(c.spreadBps) ? c.spreadBps <= s.maxSpreadBps : null;
        r.slipOk = c.slipSrc === 'book' ? c.slipIn <= s.slipBudgetBps : null;
        r.sizeOfOi = leg.kind === 'perp' && m.oiUsd > 0 ? (s.notional / m.oiUsd) * 100 : null;
        return r;
      });
      const weak = Math.min(...o.liq.map((x) => Math.min(x.kind === 'perp' && isNum(x.oiUsd) ? x.oiUsd : Infinity, isNum(x.volUsd) ? x.volUsd : 0)));
      o.weakLiqUsd = isFinite(weak) ? weak : 0;
      o.minOiUsd = Math.min(...perpLegs.map((x) => (isNum(x.m.oiUsd) ? x.m.oiUsd : Infinity)));
      if (!isFinite(o.minOiUsd)) o.minOiUsd = null;
      o.minVolUsd = Math.min(...allLegs.map((x) => (isNum(x.m.volUsd) ? x.m.volUsd : Infinity)));
      if (!isFinite(o.minVolUsd)) o.minVolUsd = null;
      o.maxSlipBps = Math.max(...allLegs.map((x) => (isNum(x.cost.slipIn) || x.cost.slipIn === Infinity ? x.cost.slipIn : 0)));
      o.booksLoaded = allLegs.every((x) => x.cost.slipSrc === 'book');
      o.depth25 = Math.min(...allLegs.map((x) => (x.cost.depth ? x.cost.depth[1].min : Infinity)));
      if (!isFinite(o.depth25)) o.depth25 = null;

      // Settlement timing: the next payment this trade collects or pays.
      const nexts = perpLegs.map((x) => x.m.nextTs).filter(isNum);
      o.nextSettle = nexts.length ? Math.min(...nexts) : null;
      o.toSettleMs = o.nextSettle ? o.nextSettle - now : null;

      o.checks = comparability(o, L, S);
      o.flags = flags(o, L, S);
      score(o);
      alertConditions(o);
      return o;
    }

    function comparability(o, L, S) {
      const c = [];
      const add = (name, level, text) => c.push({ name, level, text });
      const lm = L.m, sm = S.m;
      const devs = [lm._dev, sm._dev].filter(isNum);
      const dev = o.structure === 'perp' ? Math.abs(o.basisBps || 0) / 100 : Math.max(0, ...devs);
      add('Underlying', dev > 0.5 ? 'warn' : 'pass', `${lm.rawBase || lm.base} vs ${sm.rawBase || sm.base}; prices ${dev.toFixed(2)}% apart`);
      add('Quote / collateral', lm.quote === sm.quote ? 'pass' : 'warn', lm.quote === sm.quote ? lm.quote + ' both legs' : `${lm.quote} vs ${sm.quote}: stablecoin basis and separate collateral`);
      const inv = [L, S].some((x) => x.m.type === 'inverse');
      add('Contract type', inv ? 'warn' : 'pass', inv ? 'Inverse leg: coin-margined, P&L in the coin, non-linear payoff' : 'Linear both legs');
      add('Multiplier', lm.mult === sm.mult ? 'pass' : 'info', lm.mult === sm.mult ? 'Same contract unit' : `${lm.mult}x vs ${sm.mult}x units: size both legs in the underlying`);
      if (o.structure === 'perp') {
        const pr = (m) => (isNum(m.mark) && isNum(m.index) && m.index ? ((m.mark - m.index) / m.index) * 1e4 : null);
        const a = pr(lm), b = pr(sm);
        add('Index source', isNum(a) && isNum(b) && Math.abs(a - b) > 20 ? 'warn' : 'info',
          `Each venue uses its own index basket. Premium to own index: ${fmtB(a)} vs ${fmtB(b)} bps`);
        add('Funding schedule', lm.intervalH === sm.intervalH ? 'pass' : 'warn',
          lm.intervalH === sm.intervalH ? `Both ${lm.intervalH}h` : `${lm.intervalH}h vs ${sm.intervalH}h: payments do not offset in time`);
        const dt = isNum(lm.nextTs) && isNum(sm.nextTs) ? Math.abs(lm.nextTs - sm.nextTs) : null;
        add('Settlement alignment', dt === null ? 'info' : dt <= 60e3 ? 'pass' : 'info', dt === null ? 'Unknown' : dt <= 60e3 ? 'Next settlements coincide' : `Next settlements ${FAS.fmt.dur(dt)} apart`);
      } else {
        const same = L.m.venue === S.m.venue;
        add('Venue', same ? 'pass' : 'warn', same ? 'Spot and perp on one venue' : `Spot on ${L.kind === 'spot' ? L.m.venue : S.m.venue}, perp on ${L.kind === 'perp' ? L.m.venue : S.m.venue}: transfers between venues`);
      }
      for (const leg of [L, S]) {
        if (leg.kind !== 'perp') continue;
        const m = leg.m;
        const cur = Math.abs(m.rate || 0);
        if (isNum(m.capRate) && m.capRate > 0 && cur >= 0.8 * m.capRate) add('Funding cap', 'warn', `${m.venue} rate at ${(cur / m.capRate * 100).toFixed(0)}% of its cap: clamped, reverts when the premium eases`);
        if (m.status === 'delisting') add('Listing', 'fail', `${m.venue}: ${m.note}`);
        else if (m.status === 'restricted') add('Listing', 'warn', `${m.venue}: ${m.note}`);
        if (m.rateOnly) add('Data', 'warn', `${m.venue}: ${m.note}`);
        if (leg.margin && leg.margin.capped) add('Leverage', 'warn', `${m.venue} max ${m.maxLev}x: leg runs at ${leg.margin.L}x`);
      }
      return c;
    }

    function flags(o, L, S) {
      const f = [];
      if ([L, S].some((x) => x.m.status === 'delisting')) f.push({ id: 'delist', label: 'Delisting', level: 'critical' });
      if ([L, S].some((x) => x.m.status === 'restricted')) f.push({ id: 'restricted', label: 'Restricted', level: 'serious' });
      if ([L, S].some((x) => x.m.rateOnly)) f.push({ id: 'rateonly', label: 'Rate only', level: 'serious' });
      if (o.persist && o.persist.cv !== null && o.persist.cv > 1) f.push({ id: 'vol', label: 'Volatile funding', level: 'warning' });
      if (o.liq.some((x) => x.slipOk === false) || o.maxSlipBps === Infinity) f.push({ id: 'thin', label: 'Thin book', level: 'serious' });
      if (isNum(o.basisBps) && Math.abs(o.basisBps) > s.basisAlertBps) f.push({ id: 'basis', label: 'Wide basis', level: 'serious' });
      if (o.stressUtil === Infinity || (isNum(o.stressUtil) && o.stressUtil * 100 > s.riskCeilingPct)) f.push({ id: 'margin', label: 'Margin stress', level: 'serious' });
      if (o.structure === 'perp' && L.m.intervalH !== S.m.intervalH) f.push({ id: 'sched', label: 'Mixed schedule', level: 'info' });
      if (L.m.quote !== S.m.quote) f.push({ id: 'quote', label: L.m.quote + '/' + S.m.quote, level: 'info' });
      if (o.liq.some((x) => isNum(x.sizeOfOi) && x.sizeOfOi > s.maxSizeOfOiPct)) f.push({ id: 'crowd', label: 'Size vs OI', level: 'warning' });
      if (o.persist && o.persist.consec === 0) f.push({ id: 'spike', label: 'No persistence', level: 'warning' });
      if (o.structure === 'reverse' && o.borrowSrc && o.borrowSrc.startsWith('assumed')) f.push({ id: 'borrow', label: 'Borrow assumed', level: 'info' });
      if (o.grossCur8 > 0 && o.grossPred8 <= 0) f.push({ id: 'flip', label: 'Predicted flip', level: 'warning' });
      return f;
    }

    function score(o) {
      const w = s.weights;
      const p = o.persist;
      const aprS = clamp(o.netApr / s.aprCapPct, -1, 1);
      let persS = 0;
      if (p) {
        const stab = isNum(p.cv) ? clamp(1 - p.cv / 2, 0, 1) : 0;
        persS = 0.5 * p.pct7d + 0.3 * Math.min(1, p.consec / Math.max(1, s.persistN * 3)) + 0.2 * stab;
      }
      const liqS = o.weakLiqUsd > 0 ? clamp(Math.log10(o.weakLiqUsd / s.notional) / 3, 0, 1) : 0;
      const gross = o.gross8 * s.holdDays * 3;
      let feasS = gross > 0 ? clamp(1 - o.costRt / gross, 0, 1) : 0;
      if (o.liq.some((x) => x.slipOk === false)) feasS *= 0.5;
      const pen = {
        vol: o.flags.some((f) => f.id === 'vol') ? 0.25 : 0,
        thin: o.flags.some((f) => f.id === 'thin') ? 0.25 : 0,
        basis: o.flags.some((f) => f.id === 'basis') ? 0.2 : 0,
        delist: o.flags.some((f) => f.id === 'delist') ? 1 : 0,
        restricted: o.flags.some((f) => f.id === 'restricted') ? 0.3 : 0,
        margin: o.flags.some((f) => f.id === 'margin') ? 0.3 : 0,
        sched: o.flags.some((f) => f.id === 'sched') ? 0.1 : 0,
        quote: o.flags.some((f) => f.id === 'quote') ? 0.05 : 0,
        crowd: o.flags.some((f) => f.id === 'crowd') ? 0.2 : 0,
        rateonly: o.flags.some((f) => f.id === 'rateonly') ? 0.3 : 0,
      };
      const penalty = Object.values(pen).reduce((a, b) => a + b, 0);
      const wsum = w.apr + w.persist + w.liq + w.feas || 1;
      o.components = { apr: aprS, persist: persS, liq: liqS, feas: feasS, penalty, pen };
      o.score = (100 * (w.apr * aprS + w.persist * persS + w.liq * liqS + w.feas * feasS - w.risk * penalty)) / wsum;
    }

    function alertConditions(o) {
      const p = o.persist;
      const c = [];
      const add = (id, label, pass, detail) => c.push({ id, label, pass, detail });
      add('net', 'Net carry clears hurdle', o.netBps8 >= s.minNetBps8h || o.netApr >= s.minNetAprPct,
        `${FAS.fmt.bps(o.netBps8)} bps/8h, ${FAS.fmt.pct(o.netApr)} APR net over ${s.holdDays}d`);
      add('persist', `Persists ${s.persistN}+ intervals`, p ? p.consec >= s.persistN : null,
        p ? `${p.consec} consecutive 8h windows above ${s.persistThrBps} bps` : 'history not loaded');
      const oiVol = o.liq.every((x) => x.oiOk !== false && x.volOk !== false) ? (o.liq.every((x) => x.oiOk !== null && x.volOk !== null) ? true : null) : false;
      add('liq', 'OI and volume on both legs', oiVol, `weakest OI ${FAS.fmt.usd(o.minOiUsd)}, volume ${FAS.fmt.usd(o.minVolUsd)}`);
      const slip = o.booksLoaded ? o.liq.every((x) => x.slipOk !== false) : null;
      add('depth', 'Depth fits size within slippage budget', slip, o.booksLoaded ? `worst leg ${FAS.fmt.bps(o.maxSlipBps)} bps at ${FAS.fmt.usd(s.notional)}` : 'books not loaded');
      add('pred', 'Predicted funding still favorable', o.grossPred8 > 0, `${FAS.fmt.bps(o.grossPred8 * 1e4)} bps/8h on next prints`);
      const tm = o.toSettleMs;
      add('settle', 'Next settlement capturable', isNum(tm) ? tm >= s.leadMin * 60e3 && tm <= s.captureWindowH * HOUR : null,
        isNum(tm) ? `next settlement in ${FAS.fmt.dur(tm)}` : 'unknown');
      add('margin', 'Margin utilization under ceiling', o.stressUtil === Infinity ? false : isNum(o.stressUtil) ? o.stressUtil * 100 <= s.riskCeilingPct : null,
        o.stressUtil === Infinity ? `liquidated by a ${s.stressSigma}σ day` : isNum(o.stressUtil) ? `${FAS.fmt.pct(o.stressUtil * 100)} after a ${s.stressSigma}σ day` : 'no volatility estimate');
      add('compare', 'Contracts comparable, listing healthy', !o.checks.some((x) => x.level === 'fail'), o.checks.filter((x) => x.level !== 'pass' && x.level !== 'info').map((x) => x.name).join(', ') || 'all checks pass');
      o.conditions = c;
      o.alertable = c.every((x) => x.pass === true);
      o.conditionsMet = c.filter((x) => x.pass === true).length;
    }
  };

  function fmtB(x) { return isNum(x) ? x.toFixed(1) : '?'; }

  // ------------------------------------------------------------ funding matrix
  E.matrix = function (perps, settings) {
    const rows = new Map();
    for (const m of perps || []) {
      if (settings.venues[m.venue] === false || !isNum(m.rate)) continue;
      if (m.rateOnly && !settings.allowRateOnly && perps.some((x) => x.venue === m.venue && !x.rateOnly)) continue;
      if (!rows.has(m.base)) rows.set(m.base, { base: m.base, cells: {}, oi: 0 });
      const r = rows.get(m.base);
      const cur = r.cells[m.venue];
      if (cur && (cur.m.oiUsd || 0) >= (m.oiUsd || 0)) continue; // one contract per venue: the deepest
      r.cells[m.venue] = { m, r8: E.norm8(m.rate, m.intervalH), apr: E.apr(E.norm8(m.rate, m.intervalH)) };
    }
    const out = [];
    for (const r of rows.values()) {
      const cells = Object.values(r.cells);
      r.n = cells.length;
      r.oi = cells.reduce((a, c) => a + (c.m.oiUsd || 0), 0);
      const v = cells.map((c) => c.r8);
      r.max = Math.max(...v);
      r.min = Math.min(...v);
      r.spread8 = cells.length > 1 ? r.max - r.min : null;
      out.push(r);
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
