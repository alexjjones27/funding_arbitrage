/* Transport: one paced request queue per venue, with timeouts, one retry, and health tracking. */
(function (root) {
  'use strict';
  const FAS = root.FAS;

  // Minimum spacing between requests per venue, well inside each venue's published public limits.
  const SPACING = { binance: 150, bybit: 150, okx: 150, bitget: 120, gate: 250, hyperliquid: 300, dydx: 200 };
  const TIMEOUT_MS = 15000;

  const health = (FAS.health = {});
  const queues = {};

  function h(venue) {
    return (health[venue] = health[venue] || { ok: 0, err: 0, lastOk: null, lastErr: null, blocked: false, requests: [] });
  }

  FAS.http = {
    // Requests made in the last minute, for the venue panel.
    perMinute(venue) {
      const r = h(venue).requests;
      const cut = Date.now() - 60e3;
      while (r.length && r[0] < cut) r.shift();
      return r.length;
    },
    get(venue, url) { return enqueue(venue, url, null); },
    post(venue, url, body) { return enqueue(venue, url, body); },
  };

  function enqueue(venue, url, body) {
    const q = (queues[venue] = queues[venue] || { last: 0, chain: Promise.resolve() });
    const run = q.chain.then(async () => {
      const wait = q.last + (SPACING[venue] || 200) - Date.now();
      if (wait > 0) await sleep(wait);
      q.last = Date.now();
      return attempt(venue, url, body, 0);
    });
    q.chain = run.catch(() => {});
    return run;
  }

  async function attempt(venue, url, body, n) {
    const st = h(venue);
    st.requests.push(Date.now());
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const opts = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'GET' };
      if (ctl) opts.signal = ctl.signal;
      const res = await fetch(url, opts);
      if (res.status === 451 || res.status === 403) {
        st.blocked = true;
        throw httpError(venue, res.status, 'blocked from this location (HTTP ' + res.status + ')');
      }
      if ((res.status === 429 || res.status >= 500) && n < 1) {
        await sleep(res.status === 429 ? 3000 : 1000);
        return attempt(venue, url, body, n + 1);
      }
      if (!res.ok) throw httpError(venue, res.status, 'HTTP ' + res.status);
      const json = await res.json();
      st.ok++;
      st.lastOk = Date.now();
      st.blocked = false;
      return json;
    } catch (e) {
      st.err++;
      st.lastErr = { t: Date.now(), msg: e.name === 'AbortError' ? 'timeout' : (e.message || String(e)) };
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function httpError(venue, status, msg) {
    const e = new Error(venue + ': ' + msg);
    e.status = status;
    return e;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  FAS.sleep = sleep;
})(typeof window !== 'undefined' ? window : globalThis);
