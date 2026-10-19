/* Shared helpers: config, settings, formatting, statistics, symbol mapping, storage. */
(function (root) {
  'use strict';
  const FAS = (root.FAS = root.FAS || {});

  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  FAS.HOUR = HOUR;
  // Wall clock, frozen at the capture time when the page runs from an embedded snapshot.
  FAS.now = () => (root.FAS_SNAPSHOT ? root.FAS_SNAPSHOT.t : Date.now());
  FAS.DAY = DAY;

  FAS.config = {
    snapshotMs: 60e3,          // bulk tickers/funding from every venue
    enrichCycleMs: 20e3,       // history and books for the shortlisted candidates
    historyTtlMs: 20 * 60e3,   // funding history refresh
    bookTtlMs: 2 * 60e3,       // order-book refresh
    historyDays: 30,
    bucketH: 8,                // the common basis: everything is an 8h-equivalent
    alertCooldownMs: 30 * 60e3,
    maxAlerts: 200,
    depthBandsBps: [10, 25, 50, 100],
  };

  // Base-tier fees in percent of notional. Override in Settings for your VIP tier.
  const FEES = {
    binance: { perpTaker: 0.05, perpMaker: 0.02, spotTaker: 0.1, spotMaker: 0.1 },
    bybit: { perpTaker: 0.055, perpMaker: 0.02, spotTaker: 0.1, spotMaker: 0.1 },
    okx: { perpTaker: 0.05, perpMaker: 0.02, spotTaker: 0.1, spotMaker: 0.08 },
    bitget: { perpTaker: 0.06, perpMaker: 0.02, spotTaker: 0.1, spotMaker: 0.1 },
    gate: { perpTaker: 0.075, perpMaker: 0.02, spotTaker: 0.2, spotMaker: 0.2 },
    hyperliquid: { perpTaker: 0.045, perpMaker: 0.015, spotTaker: 0.07, spotMaker: 0.04 },
    dydx: { perpTaker: 0.05, perpMaker: 0.01, spotTaker: null, spotMaker: null },
  };

  FAS.defaults = {
    notional: 10000,           // USD per leg
    holdDays: 7,
    structures: { perp: true, carry: true, reverse: true },
    venues: { binance: true, bybit: true, okx: true, bitget: true, gate: true, hyperliquid: true, dydx: true },
    includeInverse: false,
    allowRateOnly: false,      // legs with a funding rate but no liquidity data (Binance/Bybit via Hyperliquid)
    carryBasis: 'blend',       // current | predicted | mean7 | blend
    bestPairOnly: true,
    // liquidity, applied to each leg on its own
    minOiUsd: 2e6,
    minVolUsd: 5e6,
    maxSpreadBps: 10,
    slipBudgetBps: 8,          // per leg, one way, at the intended notional
    maxSizeOfOiPct: 1,         // your notional as % of leg OI (ADL / crowding proxy)
    // returns
    minNetAprPct: 10,
    minNetBps8h: 1,
    // persistence
    persistN: 3,               // consecutive favorable 8h buckets
    persistThrBps: 0.5,        // per 8h
    // execution and margin
    makerSharePct: 0,          // share of each fill done passively
    leverage: 3,
    riskCeilingPct: 50,        // max stressed margin utilization
    stressSigma: 3,
    basisAlertBps: 50,
    maxPriceDevPct: 2,         // legs priced further apart are treated as different underlyings
    borrowAprPct: 15,          // reverse carry fallback when the venue publishes no rate
    capitalCostAprPct: 0,      // opportunity cost of spot capital in cash-and-carry
    leadMin: 5,                // need at least this long before settlement to get both legs on
    captureWindowH: 8,
    // ranking
    enrichN: 25,
    aprCapPct: 60,
    weights: { apr: 1, persist: 1, liq: 0.5, feas: 0.5, risk: 1 },
    fees: FEES,
    hideIlliquid: true,        // table: drop rows where any leg fails a liquidity filter
    hideNegative: true,        // table: drop rows with negative net APR
    alertableOnly: false,
    alertsOn: true,
    notify: false,
    sortKey: 'score',
    sortDir: -1,
    tab: 'opps',
    structureFilter: 'all',
    search: '',
    theme: null,
  };

  // ---------- formatting ----------
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  FAS.isNum = isNum;
  const DASH = '–';
  FAS.fmt = {
    usd(x) {
      if (!isNum(x)) return DASH;
      const a = Math.abs(x);
      const s = x < 0 ? '-' : '';
      if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
      if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
      if (a >= 1e4) return s + '$' + (a / 1e3).toFixed(0) + 'k';
      if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1) + 'k';
      return s + '$' + a.toFixed(a >= 100 ? 0 : 2);
    },
    pnl(x) {
      if (!isNum(x)) return DASH;
      return (x >= 0 ? '+' : '-') + '$' + Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : 2);
    },
    bps(x, dp) {
      if (!isNum(x)) return DASH;
      return x.toFixed(dp ?? (Math.abs(x) >= 100 ? 0 : 1));
    },
    pct(x, dp) {
      if (!isNum(x)) return DASH;
      return x.toFixed(dp ?? (Math.abs(x) >= 100 ? 0 : 1)) + '%';
    },
    rate(x) { // raw funding rate as a percent
      if (!isNum(x)) return DASH;
      return (x * 100).toFixed(4) + '%';
    },
    num(x, dp) { return isNum(x) ? x.toFixed(dp ?? 2) : DASH; },
    px(x) {
      if (!isNum(x)) return DASH;
      const a = Math.abs(x);
      const dp = a >= 1000 ? 1 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
      return x.toFixed(dp);
    },
    dur(ms) {
      if (!isNum(ms)) return DASH;
      if (ms < 0) return 'due';
      const m = Math.round(ms / 60e3);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      return h + 'h' + String(m % 60).padStart(2, '0');
    },
    time(ts) {
      if (!isNum(ts)) return DASH;
      return new Date(ts).toISOString().slice(11, 16) + 'Z';
    },
    date(ts) {
      if (!isNum(ts)) return DASH;
      return new Date(ts).toISOString().slice(5, 16).replace('T', ' ') + 'Z';
    },
    ago(ts) {
      if (!isNum(ts)) return 'never';
      if (root.FAS_SNAPSHOT) return 'at ' + new Date(ts).toISOString().slice(11, 16) + 'Z';
      const s = Math.round((Date.now() - ts) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      return Math.round(s / 3600) + 'h ago';
    },
  };
  FAS.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- statistics ----------
  const nums = (a) => a.filter(isNum);
  FAS.stats = {
    mean(a) { a = nums(a); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; },
    sum(a) { a = nums(a); return a.reduce((s, x) => s + x, 0); },
    median(a) {
      a = nums(a).sort((x, y) => x - y);
      if (!a.length) return null;
      const m = a.length >> 1;
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    },
    std(a) {
      a = nums(a);
      if (a.length < 2) return null;
      const m = a.reduce((s, x) => s + x, 0) / a.length;
      return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
    },
    mad(a) {
      const m = FAS.stats.median(a);
      if (m === null) return null;
      return FAS.stats.median(nums(a).map((x) => Math.abs(x - m)));
    },
    // Robust z: (x - median) / (1.4826 * MAD). Funding often sits on its floor for long runs,
    // which collapses the MAD, so the scale is floored at half the standard deviation.
    robustZ(x, a) {
      if (!isNum(x)) return null;
      const m = FAS.stats.median(a);
      if (m === null) return null;
      const s = Math.max(1.4826 * FAS.stats.mad(a), 0.5 * (FAS.stats.std(a) || 0));
      if (!(s > 0)) return null;
      return (x - m) / s;
    },
  };
  FAS.clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // ---------- symbol mapping ----------
  // Venues quote small-price tokens in multiples (1000PEPE, kPEPE, 1MBABYDOGE). Funding rates
  // are dimensionless, but prices and sizes must be compared per unit of the underlying.
  FAS.normBase = function (raw) {
    let s = String(raw || '').trim();
    let mult = 1;
    let m = /^k([A-Z][A-Z0-9]*)$/.exec(s); // Hyperliquid kPEPE
    if (m) return { base: m[1], mult: 1000 };
    s = s.toUpperCase();
    m = /^(1000000|100000|10000|1000|100)([A-Z][A-Z0-9]*)$/.exec(s);
    if (m) { mult = Number(m[1]); s = m[2]; }
    m = /^1M([A-Z][A-Z0-9]*)$/.exec(s);
    if (m) { mult = 1e6; s = m[1]; }
    return { base: s, mult };
  };

  // ---------- storage ----------
  FAS.store = {
    get(k, d) {
      try {
        const v = root.localStorage && root.localStorage.getItem('fas:' + k);
        return v ? JSON.parse(v) : d;
      } catch (e) { return d; }
    },
    set(k, v) {
      try { root.localStorage && root.localStorage.setItem('fas:' + k, JSON.stringify(v)); } catch (e) { /* quota or private mode */ }
    },
  };

  // Deep merge of saved settings over defaults, so new defaults appear after upgrades.
  FAS.merge = function merge(base, over) {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(over)) {
      out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
        ? merge(base[k], over[k]) : over[k];
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
