# Funding Arb Screener

A live screener for funding-rate arbitrage. It pulls funding, open interest, volume, books and
funding history from seven venues' public APIs, normalizes every rate to an 8-hour basis, and
ranks trades by **expected net carry after fees, slippage, borrow and the holding period**, not
by the headline rate. Each candidate is then checked for persistence, per-leg liquidity, margin
risk and contract comparability, and an alert fires only when all of those hold at once.

No build step, no API key, no server. Plain HTML, CSS and JavaScript; requests go straight from
your browser to each venue.

## Run it

- **Open `index.html`** in a browser, or
- **Serve the folder**: `python3 -m http.server 8000` and open <http://localhost:8000>, or
- **GitHub Pages**: in the repo's *Settings → Pages*, set *Source* to **GitHub Actions**, then run
  the *Deploy screener to GitHub Pages* workflow (or push). The site appears at
  `https://<owner>.github.io/funding_arbitrage/`.

The first snapshot takes about 5 seconds. Funding history and order books then load for the top
25 rows (and any row you click) over the next minute or so; until a row's book arrives its
slippage is marked `*` (from the touch, or the assumed budget).

**Offline snapshot build** (for hosts that block network requests, such as a claude.ai artifact):
`NODE_USE_ENV_PROXY=1 node tools/capture.js snapshot.json` pulls venue data plus history and books
for the shortlist, then `python3 tools/build-artifact.py snapshot.json screener.html` inlines
everything into one page. It recomputes locally when you change settings but never refreshes.

Tests: `node --test` (Node 18+). They cover normalization, bucketing, persistence, book walking,
the cost and margin arithmetic, comparability and alert logic.

## Venues

| Venue | Data used | Notes |
|---|---|---|
| Binance USDⓈ-M | premiumIndex, fundingInfo, 24h tickers, book tickers, exchangeInfo; per-symbol OI, history, depth; spot | Geo-blocked in the US and elsewhere. When unreachable, its funding rates come from Hyperliquid's `predictedFundings` as **rate-only** legs |
| Bybit linear | tickers, instruments; history, order book; spot | Same geo-blocking and the same rate-only fallback |
| OKX swaps | funding (all instruments), tickers, OI, mark, index, instruments; history, books; spot; margin borrow rates | Coin-margined inverse swaps optional (Settings) |
| Bitget USDT-M and USDC-M | tickers, current funding, contracts; history, merged depth; spot | Delisting and open-restriction times from the contract list |
| Gate USDT-M | tickers, contracts; history, order book; spot | Maintenance rate and delisting flag from the contract list |
| Hyperliquid | metaAndAssetCtxs, predictedFundings; history; l2Book (fine plus coarse levels) | 1h funding, USDC collateral |
| dYdX v4 | perpetual markets; history; order book | 1h funding, USDC collateral; no top of book in the bulk feed |

Rate-only legs have no OI, volume or book, so they are hidden unless *Allow rate-only legs* is on;
they always appear in the funding matrix. KuCoin and MEXC do not send CORS headers, so a browser
cannot read them.

## What is on screen

| Area | Contents |
|---|---|
| Header | Status per venue (live, rate-only, down), snapshot age, pending loads |
| KPI strip | Markets and assets tracked, assets on 2+ venues, top-decile cross-venue spread, rows that are liquid and net-positive, rows meeting every alert condition, best net APR |
| Toolbar | View, structure (perp-perp, cash-and-carry, reverse carry), notional per leg, holding period, carry estimate, best pair per asset, liquidity / net-positive / alertable filters, search |
| Opportunities | One row per trade: both legs with their 8h-equivalent rates, gross bps/8h and APR, round-trip cost, break-even spread, net APR and return on capital, expected P&L for 1, 7 and 30 days, streak, 7d hit rate, z, weakest OI and volume, worst slippage, liquidation distance, basis, time to settlement, alert conditions met, flags, score |
| Detail | Alert checklist, economics, 30-day chart of the trade's net funding per 8h window with each leg, a two-leg table (rates current / predicted / last settled, next settlement, cap, means over last 3 prints and 7/14/30 days, cumulative funding, mark/index/premium, OI, volume, spread, slippage in and out, depth at ±10/25/50/100 bps, fees, leverage, maintenance margin, liquidation distance, stressed utilization, status), persistence statistics, margin and basis, comparability checks, score breakdown |
| Funding matrix | Every asset on 2+ venues, current rate per venue in bps/8h (native interval marked), max-min spread and its APR, total OI |
| Venues & method | Live request counts and errors per venue, plus collateral, funding intervals, caps, margin modes, ADL/insurance, transfer rails, API limits and access notes |
| Alerts | Log of opportunities that met every condition, 30-minute cooldown each, optional browser notifications |

## Method

**Normalization.** `rate_8h = rate × 8 / interval_h`, `APR = rate_8h × 3 × 365`. Intervals come
from each venue (OKX from the gap between funding times, Bitget/Gate/Bybit/Binance from their
contract or funding-info fields; Hyperliquid and dYdX are 1h). dYdX quotes its next rate as an 8h
figure, which is divided by 8.

**Which rate drives the estimate** (toolbar): the current accruing rate, the venue's predicted
next rate (Gate, Hyperliquid, OKX when published; otherwise current), the 7-day mean of settled
rates, or by default the average of the next rate and the 7-day mean.

**Structures.**

| Structure | Legs | Gross carry |
|---|---|---|
| Perp-perp | long the lower-funding perp, short the higher, on different venues | short-leg rate − long-leg rate |
| Cash-and-carry | long spot (same venue if listed, else the deepest), short perp | perp rate, when positive |
| Reverse carry | short spot via margin borrow, long perp | −perp rate − borrow, when the rate is negative |

With *Best pair per asset* on, each asset shows its best pair per structure by net APR.

**Net carry.** Costs are a full round trip on both legs: fee = maker share × maker + (1 − maker
share) × taker, plus slippage on the taker share, measured by walking the live book at your
notional (entry and exit sides separately). Then, over a hold of H days (3H funding periods):

```
net        = gross_8h × 3H − round_trip − (borrow + capital cost) × H / 365
net APR    = net / H × 365
break-even = round_trip / 3H + borrow per 8h          (bps per 8h)
P&L(d)     = notional × (gross_8h × 3d − round_trip − borrow × d / 365)
ROC APR    = net APR × notional / capital             (capital = spot + perp margins)
```

Borrow comes from OKX's published margin rates where available, otherwise the Settings value.

**Persistence.** Settled prints are bucketed into 8h UTC windows (a 1h venue's eight prints sum
into one window; a print at 08:00 pays for 00:00-08:00; windows less than 6h covered are
dropped). The long leg is subtracted from the short leg window by window, and on that trade
series the screener reports: streak of windows above the threshold, the share above it over
24h / 48h / 7d, mean and median over 7 / 14 / 30 days, standard deviation and CV, a robust z of
the latest window against the trailing 30 days, and cumulative carry. Each leg also shows its own
means over the last 3 prints and 7 / 14 / 30 days and its cumulative funding.

**Liquidity** is checked per leg, never averaged: minimum OI and 24h volume, maximum quoted
spread, slippage at your notional within the budget, and your size as a share of OI (an ADL and
crowding proxy). Depth is the USD resting within ±10 / 25 / 50 / 100 bps of mid.

**Margin.** Leverage per leg is the Settings value capped at the venue maximum. Maintenance margin
uses the venue's rate (Gate, dYdX, Hyperliquid's rule) or half the initial margin at max leverage.
Liquidation distance = 1/leverage − maintenance rate (isolated, no top-up). Daily σ comes from the
24h range (Parkinson). Stressed utilization = maintenance margin / remaining equity after an N-σ
move against the leg; above the ceiling it is a flag, a penalty and a failed alert condition.

**Basis.** Price of the short leg minus the long leg per unit of underlying. Positive means the
entry captures convergence; beyond the warning level it is flagged, since a widening cross-venue
basis drains one margin account while the hedge profit sits on the other.

**Comparability.** Legs whose per-unit prices (after 1000x / k / 1M multipliers) differ by more
than the tolerance are treated as different tokens and dropped. Each pair is also checked for
quote and collateral, contract type (inverse), multiplier, index premium difference, funding
schedule and settlement alignment, funding caps (rate pinned near the cap), delisting or
restricted status, and leverage limits.

**Score.**

```
Score = 100 × (w1·APR + w2·persistence + w3·liquidity + w4·feasibility − w5·penalties) / (w1+w2+w3+w4)
```

- APR: net APR / cap, clipped to [−1, 1]
- persistence: 0.5 × 7d hit rate + 0.3 × streak (vs 3 × required) + 0.2 × stability (1 − CV/2)
- liquidity: log10(weakest leg OI or volume / notional) / 3, clipped to [0, 1]
- feasibility: share of gross carry left after round-trip costs, halved if a leg breaks the slippage budget
- penalties: volatile funding 0.25, thin book 0.25, wide basis 0.2, delisting 1, restricted 0.3,
  margin stress 0.3, mixed schedule 0.1, quote mismatch 0.05, crowding 0.2, rate-only 0.3

**Alert conditions** (all must pass): net spread above the bps/8h hurdle or the APR hurdle;
streak of at least N favorable windows; OI and volume above minimums on both legs; slippage at
size within budget on both legs (books loaded); predicted next funding still favorable; next
settlement more than the lead time away and within the capture window; stressed margin under the
ceiling; no failed comparability check.

## Limits

- Public data only. Your fee tier, margin mode, withdrawal status per chain, API latency and
  borrow availability need your own accounts: set fees and borrow in Settings, and treat the
  venue notes as a checklist.
- Binance and Bybit maintenance tiers and Binance OI for non-shortlisted rows are not fetched;
  maintenance margin falls back to the estimate.
- Volatility is a one-day range estimate; liquidation figures assume isolated margin with no
  top-up, which overstates risk for cross or unified accounts.
- Hyperliquid's book is 20 levels a side; coarser levels extend it, so wide-band depth on
  Hyperliquid is approximate.
- History and books load for the shortlist only; other rows rank on current rates and the touch.
- Reverse carry assumes the spot short is available; the screener cannot see borrow inventory.

## Files

```
index.html         page shell
css/styles.css     theme tokens (light and dark) and layout
js/util.js         config, default settings and fees, formatting, statistics, symbol mapping, storage
js/api.js          paced per-venue request queues with timeouts and health tracking
js/venues.js       the seven venue adapters and the rate-only fallback
js/engine.js       normalization, bucketing, persistence, costs, margin, comparability, score, alerts
js/charts.js       funding history chart
js/ui.js           rendering and settings
js/main.js         snapshot loop, enrichment queue, alerts
tests/             node:test suite for the engine
```

Not trading advice. Funding flips, venues fail, and a hedged position can still be liquidated on
one side.

## Backtest

`tools/backtest/` runs a walk-forward test of the screener's rules on historical funding and
hourly prices, charging fees, order-book slippage, transfers and gas:

```
NODE_USE_ENV_PROXY=1 node tools/capture.js snapshot.json          # current markets and books
NODE_USE_ENV_PROXY=1 node tools/backtest/collect.js snapshot.json bt-data.json 92
node tools/backtest/run.js bt-data.json bt-results.json
```

`run.js` prints each scenario (base rules, variants, hindsight) and writes the results;
`report.template.html` renders them as a page.

`node tools/backtest/wfo.js bt-data.json wfo-results.json` runs a walk-forward optimization:
every 14 days it scores 729 setting combinations on the prior 28 days only, trades the best on
the next 14 unseen days (or stays in cash if nothing made money), and reports the stitched
out-of-sample result next to the fixed base case.
