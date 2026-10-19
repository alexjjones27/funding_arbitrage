/* SVG charts: the trade's 8h funding spread (bars) with each leg's 8h-equivalent funding (lines). */
(function () {
  'use strict';
  const FAS = window.FAS;

  FAS.charts = {
    // spread: [{t, v}] signed so positive earns; legs: [{label, cls, series: [{t, v}]}]
    funding(el, spread, legs, thrBps) {
      const W = el.clientWidth || 520, H = 190;
      const pad = { l: 40, r: 8, t: 10, b: 22 };
      const all = [...(spread || []), ...legs.flatMap((l) => l.series)];
      if (!all.length) { el.innerHTML = '<p class="empty">Funding history loads for shortlisted rows.</p>'; return; }
      const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t)) + 8 * FAS.HOUR;
      const vals = all.map((p) => p.v * 1e4);
      let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
      // Clip extreme prints so one spike does not flatten the chart; clipped bars get a cap mark.
      const sorted = vals.slice().sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      const span = Math.max(q(0.98) - q(0.02), 1e-6);
      lo = Math.max(lo, q(0.02) - span * 0.5);
      hi = Math.min(hi, q(0.98) + span * 0.5);
      if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
      const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
      const y = (v) => pad.t + ((hi - Math.max(lo, Math.min(hi, v))) / (hi - lo)) * (H - pad.t - pad.b);
      const parts = [];
      // grid and axis labels
      const ticks = niceTicks(lo, hi, 4);
      for (const tv of ticks) {
        parts.push(`<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(tv)}" y2="${y(tv)}"/>`);
        parts.push(`<text class="tick" x="${pad.l - 4}" y="${y(tv) + 3}" text-anchor="end">${fmtTick(tv)}</text>`);
      }
      parts.push(`<line class="zero" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>`);
      if (thrBps) parts.push(`<line class="thr" x1="${pad.l}" x2="${W - pad.r}" y1="${y(thrBps)}" y2="${y(thrBps)}"/>`);
      for (let d = Math.ceil(t0 / (7 * FAS.DAY)) * 7 * FAS.DAY; d < t1; d += 7 * FAS.DAY) {
        parts.push(`<text class="tick" x="${x(d)}" y="${H - 6}" text-anchor="middle">${new Date(d).toISOString().slice(5, 10)}</text>`);
      }
      // spread bars
      const bw = Math.max(1, ((W - pad.l - pad.r) * 8 * FAS.HOUR) / (t1 - t0) - 1);
      for (const p of spread || []) {
        const v = p.v * 1e4;
        const y0 = y(0), y1 = y(v);
        const cls = v >= 0 ? 'bar pos' : 'bar neg';
        const clipped = v > hi || v < lo;
        parts.push(`<rect class="${cls}${clipped ? ' clip' : ''}" x="${x(p.t)}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(0.5, Math.abs(y1 - y0))}"><title>${FAS.fmt.date(p.t)} to +8h: ${v.toFixed(2)} bps net funding${clipped ? ' (clipped)' : ''}</title></rect>`);
      }
      // leg lines
      for (const l of legs) {
        if (!l.series.length) continue;
        const d = l.series.map((p, i) => `${i ? 'L' : 'M'}${(x(p.t) + bw / 2).toFixed(1)},${y(p.v * 1e4).toFixed(1)}`).join('');
        parts.push(`<path class="line ${l.cls}" d="${d}"><title>${FAS.esc(l.label)}</title></path>`);
      }
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Funding history, bps per 8h">${parts.join('')}</svg>`;
    },
  };

  function niceTicks(lo, hi, n) {
    const raw = (hi - lo) / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function fmtTick(v) { return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1); }
})();
