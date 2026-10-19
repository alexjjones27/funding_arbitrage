/* Venue adapters. Each one maps a venue's public REST API onto the same market record:
 *
 *   rate        funding rate that accrues into the next settlement (native interval)
 *   predicted   the venue's forward estimate for the following settlement, when published
 *   lastSettled most recent settled rate, when the bulk endpoint carries it
 *   intervalH   hours between settlements; nextTs is the next settlement time
 *   oiUsd, volUsd, bid, ask, mark, index, hi, lo (24h), maxLev, mmr, capRate, status
 *
 * Prices are per venue contract unit (1000PEPE stays 1000PEPE); `mult` converts to the
 * underlying. Books come back as [[price, qty]] in the same units, so price*qty is USD.
 */
(function (root) {
  'use strict';
  const FAS = root.FAS;
  const { HOUR } = FAS;
  const http = FAS.http;
  const num = (x) => (x === null || x === undefined || x === '' ? null : (isFinite(+x) ? +x : null));

  function market(venue, o) {
    return Object.assign({
      venue, id: '', rawBase: '', base: '', mult: 1, quote: 'USDT', type: 'linear', ctVal: 1,
      rate: null, predicted: null, lastSettled: null, nextTs: null, intervalH: 8,
      mark: null, index: null, oiUsd: null, volUsd: null, bid: null, ask: null, hi: null, lo: null,
      maxLev: null, mmr: null, mmrSrc: null, capRate: null, status: 'ok', note: '', rateOnly: false,
    }, o);
  }
  function withBase(o, raw) {
    const nb = FAS.normBase(raw);
    o.rawBase = raw;
    o.base = nb.base;
    o.mult = nb.mult;
    return o;
  }
  function spot(venue, base, quote, id, bid, ask, last, volUsd) {
    const nb = FAS.normBase(base);
    return { venue, kind: 'spot', id, base: nb.base, mult: nb.mult, quote, bid: num(bid), ask: num(ask), last: num(last), volUsd: num(volUsd) };
  }
  const STABLE = { USDT: 1, USDC: 1 };
  const nextHour = () => Math.ceil(Date.now() / HOUR) * HOUR;
  const levels = (arr, px, qty) => (arr || []).map((l) => [num(px(l)), num(qty(l))]).filter((l) => l[0] > 0 && l[1] > 0);

  // Small TTL cache for slow-moving metadata (instrument lists, contract specs).
  const meta = {};
  async function cached(key, ttl, fn) {
    const c = meta[key];
    if (c && Date.now() - c.t < ttl) return c.v;
    const v = await fn();
    meta[key] = { t: Date.now(), v };
    return v;
  }

  // Walk a descending-time paginated endpoint until `since` is covered.
  async function paginate(fetchPage, since, maxPages) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < (maxPages || 10); i++) {
      const rows = await fetchPage(cursor);
      if (!rows.length) break;
      out.push(...rows);
      const oldest = Math.min(...rows.map((r) => r.t));
      if (oldest <= since) break;
      if (cursor !== null && oldest >= cursor) break;
      cursor = oldest;
    }
    const seen = new Set();
    return out.filter((r) => r.t >= since && !seen.has(r.t) && seen.add(r.t)).sort((a, b) => a.t - b.t);
  }

  const V = (FAS.venues = {});

  // ---------------------------------------------------------------- Binance USDⓈ-M
  V.binance = {
    id: 'binance', name: 'Binance', collateral: 'USDT / USDC (USDⓈ-M)',
    info: {
      intervals: '8h default; many alts 4h or 1h (fundingInfo)',
      caps: 'Per-symbol cap/floor (adjusted on stress)',
      limits: '2,400 request weight / min per IP (futures)',
      transfer: 'Internal transfer spot to futures is instant; withdrawals per network, may be suspended per chain',
      adl: 'Insurance fund, then ADL ranked by profit and leverage',
      margin: 'Cross or isolated; multi-asset mode available',
      access: 'Geo-restricted (US and others get HTTP 451). Falls back to rate-only data via Hyperliquid.',
    },
    async snapshot() {
      const F = 'https://fapi.binance.com';
      const [prem, finfo, t24, book, ex] = await Promise.all([
        http.get('binance', F + '/fapi/v1/premiumIndex'),
        http.get('binance', F + '/fapi/v1/fundingInfo'),
        http.get('binance', F + '/fapi/v1/ticker/24hr'),
        http.get('binance', F + '/fapi/v1/ticker/bookTicker'),
        cached('binance:ex', 30 * 60e3, () => http.get('binance', F + '/fapi/v1/exchangeInfo')),
      ]);
      const byS = (arr) => Object.fromEntries((arr || []).map((x) => [x.symbol, x]));
      const fi = byS(finfo), tk = byS(t24), bk = byS(book), pr = byS(prem);
      const perps = [];
      for (const s of ex.symbols || []) {
        if (s.contractType !== 'PERPETUAL' || !STABLE[s.quoteAsset]) continue;
        if (s.status !== 'TRADING') continue;
        const p = pr[s.symbol];
        if (!p) continue;
        const t = tk[s.symbol] || {}, b = bk[s.symbol] || {}, f = fi[s.symbol];
        const m = withBase(market('binance', {
          id: s.symbol, quote: s.quoteAsset,
          rate: num(p.lastFundingRate), nextTs: num(p.nextFundingTime),
          intervalH: f ? num(f.fundingIntervalHours) || 8 : 8,
          capRate: f ? num(f.adjustedFundingRateCap) : null,
          mark: num(p.markPrice), index: num(p.indexPrice),
          volUsd: num(t.quoteVolume), hi: num(t.highPrice), lo: num(t.lowPrice),
          bid: num(b.bidPrice), ask: num(b.askPrice),
        }), s.baseAsset);
        if (s.deliveryDate && s.deliveryDate < 4e12) {
          m.status = 'delisting';
          m.note = 'Delists ' + new Date(s.deliveryDate).toISOString().slice(0, 10);
        }
        perps.push(m);
      }
      let spots = [];
      try {
        const st = await http.get('binance', 'https://api.binance.com/api/v3/ticker/24hr');
        for (const x of st || []) {
          const q = /USDT$|USDC$/.exec(x.symbol);
          if (!q) continue;
          spots.push(spot('binance', x.symbol.slice(0, -4), q[0], x.symbol, x.bidPrice, x.askPrice, x.lastPrice, x.quoteVolume));
        }
      } catch (e) { spots = []; }
      return { perps, spots };
    },
    async enrich(m) { // OI is per-symbol only
      const r = await http.get('binance', 'https://fapi.binance.com/fapi/v1/openInterest?symbol=' + m.id);
      if (num(r.openInterest) !== null && m.mark) m.oiUsd = num(r.openInterest) * m.mark;
    },
    async history(m, since) {
      const r = await http.get('binance', `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${m.id}&startTime=${since}&limit=1000`);
      return (r || []).map((x) => ({ t: +x.fundingTime, r: +x.fundingRate })).sort((a, b) => a.t - b.t);
    },
    async book(m) {
      const r = await http.get('binance', `https://fapi.binance.com/fapi/v1/depth?symbol=${m.id}&limit=500`);
      return { bids: levels(r.bids, (l) => l[0], (l) => l[1]), asks: levels(r.asks, (l) => l[0], (l) => l[1]) };
    },
    async spotBook(s) {
      const r = await http.get('binance', `https://api.binance.com/api/v3/depth?symbol=${s.id}&limit=500`);
      return { bids: levels(r.bids, (l) => l[0], (l) => l[1]), asks: levels(r.asks, (l) => l[0], (l) => l[1]) };
    },
  };

  // ---------------------------------------------------------------- Bybit linear
  V.bybit = {
    id: 'bybit', name: 'Bybit', collateral: 'USDT / USDC (unified account)',
    info: {
      intervals: '8h default; 4h, 2h or 1h on some contracts',
      caps: 'Upper/lower funding limits per contract',
      limits: '600 requests / 5s per IP (public market data)',
      transfer: 'Unified account; withdrawals per network',
      adl: 'Insurance fund per contract group, then ADL',
      margin: 'Cross, isolated or portfolio margin',
      access: 'Geo-restricted (US and others get HTTP 403). Falls back to rate-only data via Hyperliquid.',
    },
    async snapshot() {
      const B = 'https://api.bybit.com/v5/market';
      const [tk, ins] = await Promise.all([
        http.get('bybit', B + '/tickers?category=linear'),
        cached('bybit:ins', 30 * 60e3, async () => {
          const all = [];
          let cursor = '';
          for (let i = 0; i < 5; i++) {
            const r = await http.get('bybit', B + '/instruments-info?category=linear&limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
            all.push(...((r.result && r.result.list) || []));
            cursor = r.result && r.result.nextPageCursor;
            if (!cursor) break;
          }
          return all;
        }),
      ]);
      const byS = Object.fromEntries(ins.map((x) => [x.symbol, x]));
      const perps = [];
      for (const t of (tk.result && tk.result.list) || []) {
        const s = byS[t.symbol];
        if (!s || s.contractType !== 'LinearPerpetual' || s.status !== 'Trading' || !STABLE[s.quoteCoin]) continue;
        const ivl = num(t.fundingIntervalHour) || (num(s.fundingInterval) ? num(s.fundingInterval) / 60 : 8);
        const m = withBase(market('bybit', {
          id: t.symbol, quote: s.quoteCoin,
          rate: num(t.fundingRate), nextTs: num(t.nextFundingTime), intervalH: ivl,
          capRate: num(s.upperFundingRate),
          mark: num(t.markPrice), index: num(t.indexPrice),
          oiUsd: num(t.openInterestValue), volUsd: num(t.turnover24h),
          hi: num(t.highPrice24h), lo: num(t.lowPrice24h),
          bid: num(t.bid1Price), ask: num(t.ask1Price),
          maxLev: s.leverageFilter ? num(s.leverageFilter.maxLeverage) : null,
        }), s.baseCoin);
        if (num(s.deliveryTime) > 0) {
          m.status = 'delisting';
          m.note = 'Delists ' + new Date(+s.deliveryTime).toISOString().slice(0, 10);
        }
        perps.push(m);
      }
      let spots = [];
      try {
        const st = await http.get('bybit', B + '/tickers?category=spot');
        for (const x of (st.result && st.result.list) || []) {
          const q = /USDT$|USDC$/.exec(x.symbol);
          if (q) spots.push(spot('bybit', x.symbol.slice(0, -4), q[0], x.symbol, x.bid1Price, x.ask1Price, x.lastPrice, x.turnover24h));
        }
      } catch (e) { spots = []; }
      return { perps, spots };
    },
    async history(m, since) {
      return paginate(async (cursor) => {
        const end = cursor ? '&endTime=' + (cursor - 1) : '';
        const r = await http.get('bybit', `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${m.id}&limit=200${end}`);
        return ((r.result && r.result.list) || []).map((x) => ({ t: +x.fundingRateTimestamp, r: +x.fundingRate }));
      }, since, 6);
    },
    async book(m) {
      const r = await http.get('bybit', `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${m.id}&limit=500`);
      const d = r.result || {};
      return { bids: levels(d.b, (l) => l[0], (l) => l[1]), asks: levels(d.a, (l) => l[0], (l) => l[1]) };
    },
    async spotBook(s) {
      const r = await http.get('bybit', `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${s.id}&limit=200`);
      const d = r.result || {};
      return { bids: levels(d.b, (l) => l[0], (l) => l[1]), asks: levels(d.a, (l) => l[0], (l) => l[1]) };
    },
  };

  // ---------------------------------------------------------------- OKX swaps
  V.okx = {
    id: 'okx', name: 'OKX', collateral: 'USDT (linear) or the coin (inverse)',
    info: {
      intervals: '8h default; 4h (and some 2h/1h) on many alts',
      caps: 'Max/min funding rate per contract',
      limits: '20 requests / 2s per endpoint per IP (public)',
      transfer: 'Unified trading account; withdrawals per network',
      adl: 'Insurance fund, then ADL',
      margin: 'Cross or isolated; spot/futures/portfolio modes',
      access: 'Browser access OK (CORS). Some regions restricted for trading.',
    },
    async snapshot(settings) {
      const O = 'https://www.okx.com/api/v5';
      const [fr, tk, oi, mp, ins, idxT, idxU, sp, loan] = await Promise.all([
        http.get('okx', O + '/public/funding-rate?instId=ANY'),
        http.get('okx', O + '/market/tickers?instType=SWAP'),
        http.get('okx', O + '/public/open-interest?instType=SWAP'),
        http.get('okx', O + '/public/mark-price?instType=SWAP'),
        cached('okx:ins', 30 * 60e3, () => http.get('okx', O + '/public/instruments?instType=SWAP')),
        http.get('okx', O + '/market/index-tickers?quoteCcy=USDT').catch(() => ({ data: [] })),
        http.get('okx', O + '/market/index-tickers?quoteCcy=USD').catch(() => ({ data: [] })),
        http.get('okx', O + '/market/tickers?instType=SPOT').catch(() => ({ data: [] })),
        cached('okx:loan', 30 * 60e3, () => http.get('okx', O + '/public/interest-rate-loan-quota')).catch(() => ({ data: [] })),
      ]);
      const byI = (r, k) => Object.fromEntries(((r && r.data) || []).map((x) => [x[k || 'instId'], x]));
      const T = byI(tk), OI = byI(oi), MP = byI(mp), I = byI(ins), F = byI(fr);
      const IDX = Object.assign(byI(idxU), byI(idxT));
      const perps = [];
      for (const id of Object.keys(F)) {
        const f = F[id], s = I[id];
        if (!s || s.state !== 'live') continue;
        const parts = id.split('-'); // BTC-USDT-SWAP, BTC-USD-SWAP
        const inverse = s.ctType === 'inverse';
        if (inverse && !settings.includeInverse) continue;
        if (!inverse && !STABLE[parts[1]]) continue;
        const t = T[id] || {};
        const last = num(t.last);
        const nextTs = num(f.fundingTime);
        const prevTs = num(f.prevFundingTime);
        const ix = IDX[parts[0] + '-' + parts[1]];
        const m = withBase(market('okx', {
          id, quote: parts[1], type: inverse ? 'inverse' : 'linear', ctVal: num(s.ctVal) || 1,
          rate: num(f.fundingRate), predicted: num(f.nextFundingRate), lastSettled: num(f.settFundingRate),
          nextTs, intervalH: nextTs && prevTs ? Math.max(1, Math.round((nextTs - prevTs) / HOUR)) : 8,
          capRate: num(f.maxFundingRate),
          mark: MP[id] ? num(MP[id].markPx) : last, index: ix ? num(ix.idxPx) : null,
          oiUsd: OI[id] ? num(OI[id].oiUsd) : null,
          volUsd: num(t.volCcy24h) !== null && last ? num(t.volCcy24h) * last : null, // swaps: volCcy24h is in the base coin
          hi: num(t.high24h), lo: num(t.low24h), bid: num(t.bidPx), ask: num(t.askPx),
          maxLev: num(s.lever),
        }), parts[0]);
        if (s.expTime) { m.status = 'delisting'; m.note = 'Delists ' + new Date(+s.expTime).toISOString().slice(0, 10); }
        perps.push(m);
      }
      const spots = [];
      for (const x of (sp && sp.data) || []) {
        const p = x.instId.split('-');
        if (p.length === 2 && STABLE[p[1]]) spots.push(spot('okx', p[0], p[1], x.instId, x.bidPx, x.askPx, x.last, x.volCcy24h)); // spot: volCcy24h is quote
      }
      const borrow = {};
      const q = loan && loan.data && loan.data[0];
      for (const b of (q && q.basic) || []) borrow[b.ccy] = num(b.rate) * 365 * 100; // daily rate to APR %
      return { perps, spots, borrow };
    },
    async history(m, since) {
      return paginate(async (cursor) => {
        const after = cursor ? '&after=' + cursor : '';
        const r = await http.get('okx', `https://www.okx.com/api/v5/public/funding-rate-history?instId=${m.id}&limit=400${after}`);
        return ((r && r.data) || []).map((x) => ({ t: +x.fundingTime, r: num(x.realizedRate) ?? +x.fundingRate }));
      }, since, 3);
    },
    async book(m) {
      const r = await http.get('okx', `https://www.okx.com/api/v5/market/books?instId=${m.id}&sz=400`);
      const d = (r.data && r.data[0]) || {};
      // Sizes are contracts: linear ctVal is base coin, inverse ctVal is USD.
      const qty = (l) => (m.type === 'inverse' ? (+l[1] * m.ctVal) / +l[0] : +l[1] * m.ctVal);
      return { bids: levels(d.bids, (l) => l[0], qty), asks: levels(d.asks, (l) => l[0], qty) };
    },
    async spotBook(s) {
      const r = await http.get('okx', `https://www.okx.com/api/v5/market/books?instId=${s.id}&sz=400`);
      const d = (r.data && r.data[0]) || {};
      return { bids: levels(d.bids, (l) => l[0], (l) => l[1]), asks: levels(d.asks, (l) => l[0], (l) => l[1]) };
    },
  };

  // ---------------------------------------------------------------- Bitget USDT-M and USDC-M
  V.bitget = {
    id: 'bitget', name: 'Bitget', collateral: 'USDT (USDT-M) or USDC (USDC-M)',
    info: {
      intervals: '8h default; 4h or 1h on volatile contracts',
      caps: 'Min/max funding rate per contract',
      limits: '20 requests / s per IP (market data)',
      transfer: 'Unified or classic account; withdrawals per network',
      adl: 'Risk-protection fund, then ADL',
      margin: 'Cross or isolated',
      access: 'Browser access OK (CORS).',
    },
    async snapshot() {
      const B = 'https://api.bitget.com/api/v2';
      const perps = [];
      for (const pt of ['USDT-FUTURES', 'USDC-FUTURES']) {
        const [tk, cfr, ct] = await Promise.all([
          http.get('bitget', `${B}/mix/market/tickers?productType=${pt}`),
          http.get('bitget', `${B}/mix/market/current-fund-rate?productType=${pt}`),
          cached('bitget:ct:' + pt, 30 * 60e3, () => http.get('bitget', `${B}/mix/market/contracts?productType=${pt}`)),
        ]);
        const C = Object.fromEntries(((ct && ct.data) || []).map((x) => [x.symbol, x]));
        const R = Object.fromEntries(((cfr && cfr.data) || []).map((x) => [x.symbol, x]));
        for (const t of (tk && tk.data) || []) {
          const c = C[t.symbol];
          if (!c || c.symbolType !== 'perpetual' || c.symbolStatus === 'off') continue;
          const f = R[t.symbol] || {};
          const mark = num(t.markPrice);
          const m = withBase(market('bitget', {
            id: t.symbol, quote: c.quoteCoin, productType: pt,
            rate: num(f.fundingRate) ?? num(t.fundingRate), nextTs: num(f.nextUpdate),
            intervalH: num(f.fundingRateInterval) || num(c.fundInterval) || 8,
            capRate: num(f.maxFundingRate),
            mark, index: num(t.indexPrice),
            oiUsd: num(t.holdingAmount) !== null && mark ? num(t.holdingAmount) * mark : null,
            volUsd: num(t.usdtVolume) ?? num(t.quoteVolume),
            hi: num(t.high24h), lo: num(t.low24h), bid: num(t.bidPr), ask: num(t.askPr),
            maxLev: num(c.maxLever),
          }), c.baseCoin);
          if (num(c.offTime) > 0) { m.status = 'delisting'; m.note = 'Delists ' + new Date(+c.offTime).toISOString().slice(0, 16).replace('T', ' '); }
          else if (num(c.limitOpenTime) > 0 || c.symbolStatus === 'limit_open') { m.status = 'restricted'; m.note = 'Opening restricted'; }
          else if (c.symbolStatus !== 'normal') { m.status = 'restricted'; m.note = 'Status ' + c.symbolStatus; }
          perps.push(m);
        }
      }
      let spots = [];
      try {
        const st = await http.get('bitget', B + '/spot/market/tickers');
        for (const x of (st && st.data) || []) {
          const q = /USDT$|USDC$/.exec(x.symbol);
          if (q) spots.push(spot('bitget', x.symbol.slice(0, -4), q[0], x.symbol, x.bidPr, x.askPr, x.lastPr, x.quoteVolume));
        }
      } catch (e) { spots = []; }
      return { perps, spots };
    },
    async history(m, since) {
      const out = [];
      for (let page = 1; page <= 8; page++) {
        const r = await http.get('bitget', `https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${m.id}&productType=${m.productType}&pageSize=100&pageNo=${page}`);
        const rows = ((r && r.data) || []).map((x) => ({ t: +x.fundingTime, r: +x.fundingRate }));
        out.push(...rows);
        if (rows.length < 100 || Math.min(...rows.map((x) => x.t)) <= since) break;
      }
      return out.filter((x) => x.t >= since).sort((a, b) => a.t - b.t);
    },
    async book(m) {
      const r = await http.get('bitget', `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${m.id}&productType=${m.productType}&limit=max`);
      const d = r.data || {};
      return { bids: levels(d.bids, (l) => l[0], (l) => l[1]), asks: levels(d.asks, (l) => l[0], (l) => l[1]) };
    },
    async spotBook(s) {
      const r = await http.get('bitget', `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${s.id}&type=step0&limit=150`);
      const d = r.data || {};
      return { bids: levels(d.bids, (l) => l[0], (l) => l[1]), asks: levels(d.asks, (l) => l[0], (l) => l[1]) };
    },
  };

  // ---------------------------------------------------------------- Gate USDT-M
  V.gate = {
    id: 'gate', name: 'Gate', collateral: 'USDT (USDT-M)',
    info: {
      intervals: '8h default; 4h or 1h on many alts',
      caps: 'funding_rate_limit per contract; cap ratio applied',
      limits: '200 requests / 10s per endpoint per IP (public)',
      transfer: 'Unified or classic account; withdrawals per network',
      adl: 'Insurance fund, then ADL',
      margin: 'Cross or isolated',
      access: 'Browser access OK (CORS).',
    },
    async snapshot() {
      const G = 'https://api.gateio.ws/api/v4';
      const [tk, ct, sp] = await Promise.all([
        http.get('gate', G + '/futures/usdt/tickers'),
        cached('gate:ct', 10 * 60e3, () => http.get('gate', G + '/futures/usdt/contracts')),
        http.get('gate', G + '/spot/tickers').catch(() => []),
      ]);
      const C = Object.fromEntries((ct || []).map((x) => [x.name, x]));
      const perps = [];
      const now = Date.now();
      for (const t of tk || []) {
        const c = C[t.contract];
        if (!c || c.status !== 'trading') continue;
        const ivlH = (num(c.funding_interval) || 28800) / 3600;
        let next = num(c.funding_next_apply) * 1000;
        while (next && next <= now) next += ivlH * HOUR; // contracts are cached; roll forward
        const mark = num(t.mark_price), q = num(t.quanto_multiplier) || num(c.quanto_multiplier) || 1;
        const m = withBase(market('gate', {
          id: t.contract, quote: 'USDT', ctVal: q,
          rate: num(t.funding_rate), predicted: num(t.funding_rate_indicative), nextTs: next, intervalH: ivlH,
          capRate: num(c.funding_rate_limit),
          mark, index: num(t.index_price),
          oiUsd: num(t.total_size) !== null && mark ? num(t.total_size) * q * mark : null,
          volUsd: num(t.volume_24h_quote) ?? num(t.volume_24h_settle),
          hi: num(t.high_24h), lo: num(t.low_24h), bid: num(t.highest_bid), ask: num(t.lowest_ask),
          maxLev: num(c.leverage_max), mmr: num(c.maintenance_rate), mmrSrc: 'venue',
        }), t.contract.split('_')[0]);
        if (c.in_delisting) { m.status = 'delisting'; m.note = 'In delisting'; }
        perps.push(m);
      }
      const spots = [];
      for (const x of sp || []) {
        const p = x.currency_pair.split('_');
        if (p.length === 2 && STABLE[p[1]] && !x.etf_leverage) spots.push(spot('gate', p[0], p[1], x.currency_pair, x.highest_bid, x.lowest_ask, x.last, x.quote_volume));
      }
      return { perps, spots };
    },
    async history(m, since) {
      const r = await http.get('gate', `https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${m.id}&limit=1000&from=${Math.floor(since / 1000)}`);
      return (r || []).map((x) => ({ t: x.t * 1000, r: +x.r })).filter((x) => x.t >= since).sort((a, b) => a.t - b.t);
    },
    async book(m) {
      const r = await http.get('gate', `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${m.id}&limit=100`);
      const qty = (l) => +l.s * m.ctVal; // sizes are contracts
      return { bids: levels(r.bids, (l) => l.p, qty), asks: levels(r.asks, (l) => l.p, qty) };
    },
    async spotBook(s) {
      const r = await http.get('gate', `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${s.id}&limit=100`);
      return { bids: levels(r.bids, (l) => l[0], (l) => l[1]), asks: levels(r.asks, (l) => l[0], (l) => l[1]) };
    },
  };

  // ---------------------------------------------------------------- Hyperliquid (main perp dex)
  const HL = 'https://api.hyperliquid.xyz/info';
  V.hyperliquid = {
    id: 'hyperliquid', name: 'Hyperliquid', collateral: 'USDC',
    info: {
      intervals: '1h (rate shown is the hourly accrual)',
      caps: 'Hourly cap 4%; premium-based with fixed interest component',
      limits: '1,200 weight / min per IP',
      transfer: 'USDC via Arbitrum bridge; withdrawals typically minutes',
      adl: 'HLP vault backstop, then ADL',
      margin: 'Cross or isolated; maintenance = half of initial at max leverage',
      access: 'Browser access OK (CORS). Also the source of Binance/Bybit fallback rates.',
    },
    async snapshot() {
      const [mc, pf] = await Promise.all([
        http.post('hyperliquid', HL, { type: 'metaAndAssetCtxs' }),
        http.post('hyperliquid', HL, { type: 'predictedFundings' }).catch(() => []),
      ]);
      const pred = {}; // coin -> { HlPerp: {...}, BinPerp: {...}, BybitPerp: {...} }
      for (const [coin, list] of pf || []) {
        pred[coin] = {};
        for (const [venue, d] of list || []) if (d) pred[coin][venue] = d;
      }
      const uni = mc[0].universe, ctx = mc[1];
      const perps = [];
      const next = nextHour();
      uni.forEach((u, i) => {
        const c = ctx[i];
        if (!c || u.isDelisted) return;
        const mark = num(c.markPx);
        const p = pred[u.name] && pred[u.name].HlPerp;
        const imp = c.impactPxs || [];
        perps.push(withBase(market('hyperliquid', {
          id: u.name, quote: 'USDC',
          rate: num(c.funding), predicted: p ? num(p.fundingRate) : null,
          nextTs: next, intervalH: 1, capRate: 0.04,
          mark, index: num(c.oraclePx),
          oiUsd: num(c.openInterest) !== null && mark ? num(c.openInterest) * mark : null,
          volUsd: num(c.dayNtlVlm),
          bid: num(imp[0]), ask: num(imp[1]), bidAskIsImpact: true,
          maxLev: num(u.maxLeverage), mmr: u.maxLeverage ? 1 / (2 * u.maxLeverage) : null, mmrSrc: 'venue rule',
        }), u.name));
      });
      return { perps, spots: [], predicted: pred };
    },
    async history(m, since) {
      const out = [];
      let start = since;
      for (let i = 0; i < 4; i++) {
        const r = await http.post('hyperliquid', HL, { type: 'fundingHistory', coin: m.id, startTime: start });
        if (!r || !r.length) break;
        out.push(...r.map((x) => ({ t: x.time, r: +x.fundingRate })));
        if (r.length < 500) break;
        start = r[r.length - 1].time + 1;
      }
      return out;
    },
    async book(m) {
      // l2Book returns 20 levels a side; add a coarser book (3 significant figures) for the wide bands.
      const [fine, coarse] = await Promise.all([
        http.post('hyperliquid', HL, { type: 'l2Book', coin: m.id }),
        http.post('hyperliquid', HL, { type: 'l2Book', coin: m.id, nSigFigs: 3 }).catch(() => null),
      ]);
      const side = (b, i) => levels(b && b.levels && b.levels[i], (l) => l.px, (l) => l.sz);
      return mergeBooks({ bids: side(fine, 0), asks: side(fine, 1) }, coarse ? { bids: side(coarse, 0), asks: side(coarse, 1) } : null);
    },
  };

  // Fine levels near the touch, coarse aggregated levels beyond the fine book's range.
  function mergeBooks(fine, coarse) {
    if (!coarse) return fine;
    const lastBid = fine.bids.length ? fine.bids[fine.bids.length - 1][0] : Infinity;
    const lastAsk = fine.asks.length ? fine.asks[fine.asks.length - 1][0] : 0;
    // The first coarse level past the boundary can also hold size already in the fine book,
    // so drop it: depth is understated slightly rather than double counted.
    const extraBids = coarse.bids.filter((l) => l[0] < lastBid).slice(1);
    const extraAsks = coarse.asks.filter((l) => l[0] > lastAsk).slice(1);
    return { bids: fine.bids.concat(extraBids), asks: fine.asks.concat(extraAsks), merged: true };
  }
  FAS.mergeBooks = mergeBooks;

  // ---------------------------------------------------------------- dYdX v4
  V.dydx = {
    id: 'dydx', name: 'dYdX', collateral: 'USDC',
    info: {
      intervals: '1h',
      caps: 'Premium sampled each minute; 8h-equivalent clamp per market',
      limits: 'Indexer: about 100 requests / 10s per IP',
      transfer: 'USDC via Noble/IBC or CCTP; on-chain, no custodial freeze',
      adl: 'Insurance fund, then deleveraging against offsetting positions',
      margin: 'Cross (isolated markets available)',
      access: 'Browser access OK (CORS). No top-of-book in the bulk feed; spreads come from books.',
    },
    async snapshot() {
      const r = await http.get('dydx', 'https://indexer.dydx.trade/v4/perpetualMarkets');
      const perps = [];
      const next = nextHour();
      for (const k of Object.keys(r.markets || {})) {
        const x = r.markets[k];
        if (x.status !== 'ACTIVE') continue;
        const px = num(x.oraclePrice);
        const imf = num(x.initialMarginFraction);
        perps.push(withBase(market('dydx', {
          id: x.ticker, quote: 'USDC',
          // nextFundingRate is quoted as an 8h rate; dYdX pays 1/8 of it each hour (history is per hour).
          rate: num(x.nextFundingRate) !== null ? num(x.nextFundingRate) / 8 : null, nextTs: next, intervalH: 1,
          mark: px, index: px,
          oiUsd: num(x.openInterest) !== null && px ? num(x.openInterest) * px : null,
          volUsd: num(x.volume24H),
          maxLev: imf ? Math.floor(1 / imf) : null, mmr: num(x.maintenanceMarginFraction), mmrSrc: 'venue',
        }), x.ticker.split('-')[0]));
      }
      return { perps, spots: [] };
    },
    async history(m, since) {
      return paginate(async (cursor) => {
        const before = cursor ? '&effectiveBeforeOrAt=' + new Date(cursor - 1).toISOString() : '';
        const r = await http.get('dydx', `https://indexer.dydx.trade/v4/historicalFunding/${m.id}?limit=1000${before}`);
        return ((r && r.historicalFunding) || []).map((x) => ({ t: Date.parse(x.effectiveAt), r: +x.rate }));
      }, since, 2);
    },
    async book(m) {
      const r = await http.get('dydx', `https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/${m.id}`);
      return { bids: levels(r.bids, (l) => l.price, (l) => l.size), asks: levels(r.asks, (l) => l.price, (l) => l.size) };
    },
  };

  // Rate-only markets for Binance/Bybit from Hyperliquid's predictedFundings, used when the
  // venue itself is unreachable. They carry no OI, volume or book, so liquidity is unverified.
  FAS.rateOnlyFrom = function (pred, venue) {
    const key = venue === 'binance' ? 'BinPerp' : 'BybitPerp';
    const out = [];
    for (const coin of Object.keys(pred || {})) {
      const d = pred[coin][key];
      if (!d) continue;
      out.push(withBase(market(venue, {
        id: FAS.normBase(coin).base + 'USDT', quote: 'USDT',
        rate: num(d.fundingRate), nextTs: num(d.nextFundingTime), intervalH: num(d.fundingIntervalHours) || 8,
        rateOnly: true, note: 'Rate only (via Hyperliquid): no OI, volume or book',
      }), FAS.normBase(coin).base));
    }
    return out;
  };

  FAS.venueOrder = ['binance', 'bybit', 'okx', 'bitget', 'gate', 'hyperliquid', 'dydx'];
})(typeof window !== 'undefined' ? window : globalThis);
