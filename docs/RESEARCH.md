# Research results

Generated 2026-11-22 12:28 UTC by `research/run-research.ts` from Binance spot data. All results are simulations after fees and slippage; past results do not guarantee future results.

## 1. Long-term on ETH (daily candles, 3% staking on held ETH)

Data: 3384 daily ETHUSDT candles, 2017-08-17 to 2026-11-21. Start capital $10,000, fee 0.10% per fill, slippage 0.05%.
In-sample = 2018-2022 (used when choosing defaults), out-of-sample = 2023 to now (never used for choices).

### In-sample 2018-04-24 to 2022-12-31

| Strategy | Return | Per year | Worst drop | Sharpe | Trades | Win rate | Profit factor | Fees |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Buy & hold + staking | +113.3% | +17.5% | -90% | 0.66 | 0 | – | – | $10 |
| **My plan** (DCA 1500-1700, sell 4000) | +14.7% | +3.0% | -11% | 0.48 | 1 | 100% | ∞ | $9 |
| Plan + confluence timing | +14.9% | +3.0% | -12% | 0.45 | 1 | 100% | ∞ | $9 |
| Confluence allocator | +646.4% | +53.5% | -58% | 1.00 | 6 | 33% | 5.95 | $497 |

### Out-of-sample 2023-01-01 to now

| Strategy | Return | Per year | Worst drop | Sharpe | Trades | Win rate | Profit factor | Fees |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Buy & hold + staking | +58.1% | +12.5% | -67% | 0.50 | 0 | – | – | $10 |
| **My plan** (DCA 1500-1700, sell 4000) | +161.1% | +28.0% | -15% | 1.43 | 2 | 100% | ∞ | $38 |
| Plan + confluence timing | +149.5% | +26.5% | -19% | 1.22 | 2 | 100% | ∞ | $39 |
| Confluence allocator | +40.7% | +9.2% | -45% | 0.42 | 9 | 22% | 2.68 | $185 |

### Full 2018-04-24 to now

| Strategy | Return | Per year | Worst drop | Sharpe | Trades | Win rate | Profit factor | Fees |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Buy & hold + staking | +237.8% | +15.2% | -90% | 0.59 | 0 | – | – | $10 |
| **My plan** (DCA 1500-1700, sell 4000) | +219.9% | +14.5% | -20% | 0.97 | 3 | 100% | ∞ | $51 |
| Plan + confluence timing | +190.7% | +13.2% | -22% | 0.85 | 3 | 100% | ∞ | $49 |
| Confluence allocator | +949.9% | +31.5% | -58% | 0.78 | 15 | 27% | 4.05 | $1876 |

Cycles of your plan (buy in zone, sell at target):

| Bought from | Sold | Avg buy | Sell | Profit |
|---|---|---:|---:|---:|
| 2021-02-03 | 2021-05-10 | 1584 | 4000 | +153.5% |
| 2022-07-20 | 2024-03-11 | 1600 | 4000 | +157.1% |
| 2025-04-16 | 2025-08-08 | 1590 | 4000 | +153.5% |
| 2026-06-10 | open | 1626 | – | – |

## 2. Long-term on other coins: confluence allocator vs buy & hold (no staking)

| Coin | Period | Allocator return | Allocator worst drop | Hold return | Hold worst drop |
|---|---|---:|---:|---:|---:|
| BTC | 2023 to now (out-of-sample) | +119% | -29% | +263% | -53% |
| BTC | 2018-04-24 to now | +1009% | -59% | +573% | -77% |
| BNB | 2023 to now (out-of-sample) | +73% | -47% | +122% | -59% |
| BNB | 2018-07-14 to now | +4826% | -70% | +4398% | -76% |
| SOL | 2023 to now (out-of-sample) | +249% | -55% | +604% | -76% |
| SOL | 2021-04-18 to now | +1018% | -56% | +182% | -96% |
| XRP | 2023 to now (out-of-sample) | +20% | -68% | +175% | -74% |
| XRP | 2019-01-09 to now | -7% | -89% | +158% | -83% |
| ADA | 2023 to now (out-of-sample) | -37% | -75% | -41% | -88% |
| ADA | 2018-12-23 to now | +719% | -75% | +247% | -95% |
| DOGE | 2023 to now (out-of-sample) | -11% | -76% | -21% | -88% |
| DOGE | 2020-03-11 to now | +1997% | -88% | +2407% | -92% |
| LINK | 2023 to now (out-of-sample) | +4% | -56% | +54% | -75% |
| LINK | 2019-09-23 to now | +226% | -77% | +374% | -90% |

## 3. Day trading, swing and scalping on ETH

### Is there a predictable edge after costs? (walk-forward, all bars)

Each sampled bar is a hypothetical long with an ATR stop and a 2x target. A logistic model over all confluence features predicts the outcome, trained only on outcomes known before each test fold. AUC 0.5 = coin flip. "Top 10%" = the 10% of bars the model liked most, after costs.

| Style | Samples | Target hit before stop | Avg outcome before costs | Costs per trade | Model AUC (out-of-sample) | Top 10% after costs |
|---|---:|---:|---:|---:|---:|---:|
| Day trade, 15m (2021+) | 51,616 | 32% | 0.004R | 0.41R | 0.521 | -0.51R |
| Swing, 1h (2019+) | 69,084 | 30% | 0.039R | 0.12R | 0.504 | -0.11R |

### Backtests of the confluence trader (long only, 1% risk per trade)

#### Scalp (1m candles, 2025-11-15 to 2026-11-22)

| Strategy | Return | Per year | Worst drop | Sharpe | Trades | Win rate | Profit factor | Fees |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Buy & hold | -45.2% | -44.5% | -53% | -0.67 | 0 | – | – | $10 |
| Every signal, no edge filter | -100.0% | -99.9% | -100% | -27.04 | 2595 | 17% | 0.22 | $7266 |
| **With edge filter** (default) | +0.0% | +0.0% | +0% | 0.00 | 0 | – | – | $0 |

Setups found: 25,487, traded: 0, skipped for lack of proven edge: 25,487.

#### Day trade (15m candles, 2021-01-01 to 2026-11-22)

| Strategy | Return | Per year | Worst drop | Sharpe | Trades | Win rate | Profit factor | Fees |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Buy & hold | +131.7% | +15.3% | -79% | 0.57 | 0 | – | – | $10 |
| Every signal, no edge filter | -99.7% | -62.8% | -100% | -3.57 | 2559 | 33% | 0.77 | $8316 |
| **With edge filter** (default) | -17.1% | -3.1% | -17% | -0.85 | 56 | 27% | 0.60 | $567 |

Setups found: 11,624, traded: 56, skipped for lack of proven edge: 11,380.

#### Swing (1h candles, 2019-01-01 to 2026-11-22)

| Strategy | Return | Per year | Worst drop | Sharpe | Trades | Win rate | Profit factor | Fees |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Buy & hold | +1198.5% | +38.3% | -79% | 0.81 | 0 | – | – | $10 |
| Every signal, no edge filter | -6.1% | -0.8% | -32% | -0.01 | 536 | 38% | 0.98 | $3543 |
| **With edge filter** (default) | -2.9% | -0.4% | -14% | -0.05 | 80 | 36% | 0.95 | $456 |

Setups found: 4,377, traded: 80, skipped for lack of proven edge: 3,825.

## 4. Projection of your plan from today

ETH last daily close: 1685.63 (2026-11-21). 1,000 synthetic 3-year futures, each built from random 30-day blocks of real ETH days since 2021, with your plan continuing from its simulated state today.

| Scenario | Target within 6 months | 1 year | 2 years | 3 years | Plan value in 3y (10th / 50th / 90th pct) | Today |
|---|---:|---:|---:|---:|---|---:|
| Historical trend kept | 11% | 30% | 49% | 58% | $27430 / $35737 / $45844 | $31993 |
| No trend (volatility only) | 10% | 24% | 40% | 49% | $26420 / $34241 / $44901 | $31993 |

