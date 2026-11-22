# Confluence: ETH strategy simulator for iPhone

An iPhone app (IPA) that simulates trading Ethereum and other coins with Binance market data. It replays the full Binance history, then keeps paper-trading live, candle by candle. ETH gets its own tab. Other coins live in a market scan.

It is a **simulator**. It never places orders and needs **no Binance API key**.

## What you get

| Tab | What it shows |
|---|---|
| **ETH** | Four trading styles: **Long-term** (daily candles), **Swing** (1h), **Day trade** (15m), **Scalp** (1m). Each style shows a decision (BUY / SELL / HOLD / WAIT) with its reasons, a price chart with every simulated buy and sell, the confluence matrix, a backtest of every strategy over the same window, and the trade log. |
| **Coins** | The same engine for BTC, SOL, BNB, XRP, DOGE, ADA, LINK, AVAX, TRX and SUI (editable), with live prices and the current decision per coin. |
| **Projection** | Your plan run forward into 300 simulated futures: the chance ETH reaches your target within 3 months to 3 years, and the range of your portfolio value. Each strategy's earnings rate is also compounded forward, with Monte Carlo ranges. |
| **Settings** | Your plan (zone, buy size and interval, targets, deposits), fees (0.1%, or 0.075% with BNB), slippage, staking yield, risk per trade, edge-filter strictness, custom timeframes per style, and the coin list. |

### Your plan, exactly as you run it
The long-term ETH view simulates **your rules**: buy a fixed amount on a schedule (default $500 a week) only while the daily close is inside **1,500-1,700**, keep the ETH **staked** (default 3% a year), and sell at **4,000+**, then repeat. Your buy zone and target are drawn on the price chart. The plan card shows your simulated holdings, average cost, cash waiting, staking earned and distance to target.

### "Convergence on all timeframes"
For every timeframe in a style, including custom ones Binance does not offer (2m, 10m, 45m, 2d, 5d, 2w, or any you type in), the app runs 15 algorithms in three families:

- **Trend:** EMA 20/50, price vs EMA 200, MACD line, ADX/DMI, Supertrend, Donchian position, regression slope
- **Momentum:** RSI, Money Flow Index, OBV volume flow, rate of change, MACD histogram
- **Stretch / mean reversion:** Bollinger %B, Stochastic RSI, z-score

Each algorithm scores from -1 to +1. Timeframes are combined with higher timeframes weighing more, which gives an overall score, the share of weight that agrees, and a "big picture" score. Only **finished** candles of each timeframe are used, so nothing looks into the future. Tap any timeframe row to see all 15 readings.

### "Make sure the earnings outweigh the loss"
Short-term trades (swing, day, scalp) are only taken when **all** of these hold:
1. The timeframes agree on an uptrend.
2. A pullback or breakout triggers on the base timeframe.
3. A walk-forward model gives a positive expected value **after fees and slippage**.
4. The strategy's own recent setups actually made money after costs, with statistical confidence.

Risk is capped at 1% of equity per trade with an ATR stop, plus a daily loss limit. The app also shows **the same signals without the filter**, so you can see what trading every signal would have cost.

## What the simulations found

Full tables: [docs/RESEARCH.md](docs/RESEARCH.md). Regenerate them with `node research/run-research.ts`. Results are after 0.1% fees and 0.05% slippage per fill, from $10,000.

**Long-term ETH** (2018-2022 was used to choose defaults; 2023 to now was never used for any choice):

| | 2023 to now (out of sample) | Worst drop | Full period since 2018 | Worst drop |
|---|---:|---:|---:|---:|
| **Your plan** (DCA 1500-1700, sell 4000, staked) | **+161%** | **-15%** | +220% | -20% |
| Plan + confluence timing | +150% | -19% | +191% | -22% |
| Confluence allocator (trend across 1d-1M) | +41% | -45% | +950% | -58% |
| Buy & hold + staking | +58% | -67% | +238% | -90% |

- Your plan completed three cycles, all sold at 4,000: May 2021 (+153%), March 2024 (+157%) and August 2025 (+153%). It is buying again now: ETH was 1,686 at the last daily close.
- Letting part of the position run when every timeframe was bullish at 4,000 did worse than your rule of selling everything at the target. ETH reversed soon after reaching 4,000 every time.
- The trend allocator was excellent in 2018-2022 (+53% a year) but weak since 2023 (+9% a year). It cut drawdowns but lagged in a choppy market.

**Day trading and scalping on ETH:** no setting found a reliable edge after fees.

| Style | Every signal traded | With the edge filter | Buy & hold |
|---|---:|---:|---:|
| Scalp, 1m (last 12 months) | -100% | 0% (no trade passed the filter) | -45% |
| Day trade, 15m (2021 to now) | -99.7% | -17% (56 trades) | +132% |
| Swing, 1h (2019 to now) | -6% | -3% (80 trades) | +1,199% |

On 15-minute candles, round-trip costs eat about 0.4R per trade (R = the amount risked). The best walk-forward model ranked setups barely better than a coin flip (AUC 0.52 on 15m, 0.50 on 1h). The filter cannot create an edge that is not there; it keeps losses small by mostly staying out.

**Projection of your plan from today** (1,000 futures built from real ETH history since 2021):

| | 1 year | 2 years | 3 years |
|---|---:|---:|---:|
| Chance ETH touches 4,000 (historical trend) | 30% | 49% | 58% |
| Chance ETH touches 4,000 (no trend) | 24% | 40% | 49% |

## Install on your iPhone

The app is built automatically by GitHub Actions. Download **`Confluence-unsigned.ipa`** from the [**ios-latest** release](../../releases/tag/ios-latest). The release also includes screenshots of that exact build running in the iOS simulator.

iOS only runs apps signed for your device, so sign it with your own Apple ID using one of these:

- **Sideloadly** (Windows or Mac): drop in the IPA, enter your Apple ID, connect the iPhone with a cable, press Start.
- **AltStore**: add the IPA under My Apps.
- **Xcode** on a Mac:
  ```sh
  npm ci && npm run build
  mkdir -p ios/Confluence/www && cp dist/index.html ios/Confluence/www/
  brew install xcodegen && (cd ios && xcodegen generate) && open ios/Confluence.xcodeproj
  ```
  Then choose your team under Signing & Capabilities, select your iPhone, and press Run.

On the iPhone, trust your Apple ID under Settings > General > VPN & Device Management. On iOS 16 or later, turn on Settings > Privacy & Security > Developer Mode. With a free Apple ID, apps must be re-signed every 7 days.

The same app also runs in any browser: `npm run build` produces a single `dist/index.html`. Host it anywhere, open it in Safari, and use Share > Add to Home Screen.

## About your Binance API keys

The app only uses Binance's **public** market data (`data-api.binance.vision` and its WebSocket streams). Public data needs no key. Your keys are not used, not stored and not in this repository. **This repository is public.**

Because your keys were pasted into a chat, treat them as exposed. In Binance, go to Profile > API Management, delete that key pair, and create a new one only if you need it. Give any new key read-only permission and an IP restriction. Never put a key into an app or a chat.

## How it works

```
src/engine/       pure TypeScript, no network: same code in the app, tests and research
  timeframe.ts    custom timeframes with Binance-exact alignment (3d offset, Monday weeks, months)
  aggregate.ts    builds any timeframe from smaller candles; only finished candles are exposed
  indicators.ts   15 indicators, cross-checked against TA-Lib
  features.ts     per-timeframe scores (trend / momentum / stretch)
  confluence.ts   multi-timeframe weighting and agreement
  backtest.ts     spot simulator: next-open fills, stops before targets, gaps, fees, staking
  strategies/     your plan, plan + confluence, allocator, confluence trader, buy & hold
  edge.ts         triple-barrier labels + walk-forward logistic model (no label leakage)
  projection.ts   compounding, block-bootstrap Monte Carlo, synthetic price paths
  simulate.ts     runs a style for a coin and turns the last candle into a decision
src/data/         Binance REST + WebSocket client, IndexedDB candle cache, live feed
src/worker/       runs simulations in a Web Worker
src/ui/           Preact screens, charts (TradingView lightweight-charts)
ios/              SwiftUI shell (WKWebView) + XcodeGen spec + icon
research/         data download and the scripts behind docs/RESEARCH.md
tests/, e2e/      unit, property and browser tests
```

Live paper trading: when a candle closes on Binance's WebSocket, the same simulation is extended by that candle. The live record continues the historical one without a seam. Trades made after you opened the app are tagged LIVE. If the WebSocket is unavailable, the app polls the REST API instead. Candles missed while the phone slept are fetched on wake-up.

## Testing

| Check | What it proves |
|---|---|
| `npm test`: 108 unit and property tests | Indicators match TA-Lib on real ETH data. Custom aggregation reproduces Binance's own 1h/4h/1d/3d/1w/1M candles. Cutting the data at any point never changes earlier decisions (no look-ahead). Cash, coins, fees and P&L reconcile in 200 randomized runs. The Binance client falls back across hosts, respects rate limits and never duplicates candles; the live feed batches subscriptions and recovers from drops. Your plan reproduces its three real sells at 4,000. The trader profits when an edge truly exists and stays out on random walks. Projections behave as expected. |
| `npm run e2e`: 10 browser tests (iPhone viewport, mocked Binance) | Live candles change the decision. Settings re-run the simulation. Custom timeframes are validated. Every style renders. The app falls back to polling. Errors are explained. The WebSocket rate limit is respected. No sideways scrolling at 320 px. |
| GitHub Actions | Runs all of the above, builds the unsigned IPA, and launches it in the iOS simulator with live data. |

```sh
npm ci
npm test                         # unit + property tests
npm run build && npm run e2e     # browser tests (needs Playwright)
node research/download.ts        # ~170 MB of Binance candles into data/
node research/run-research.ts    # regenerates docs/RESEARCH.md
npm run dev                      # local dev server
```

## Limits

- Long only, spot only. No shorting or leverage; in a falling market the short-term styles mostly wait in cash.
- Fills are simulated at the next candle's open (plus slippage) or at stop/limit prices. Real fills, outages and staking unlock delays can differ.
- Past results and simulated futures are not predictions. This is not financial advice.
