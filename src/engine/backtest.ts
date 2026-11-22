/**
 * Bar-by-bar spot portfolio simulator (long only, no leverage).
 *
 * Timing rules that prevent look-ahead:
 *  - Strategies decide at a bar's close and can only use data up to that close.
 *  - Market orders fill at the NEXT bar's open (plus slippage).
 *  - Stop and limit orders are checked against a bar's range. If a bar touches both
 *    the stop and a sell limit, the stop is assumed to fill first (conservative).
 *    A bar that opens through a level fills at the open (gap).
 * Fees are charged on every fill; staking yield accrues on held coins per bar.
 */
import type { Series } from './types.ts';

export interface CostModel {
  /** Fee per fill as a fraction of notional (Binance spot default 0.001 = 0.1%). */
  feeRate: number;
  /** Adverse slippage per market/stop fill as a fraction of price. */
  slippage: number;
}

export interface Fill {
  i: number;
  time: number;
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  quote: number;
  fee: number;
  reason: string;
  /** Number of the round trip this fill belongs to (index into `trades`; the open one is trades.length). */
  trade: number;
}

export interface Trade {
  entryTime: number;
  exitTime: number;
  entryIndex: number;
  exitIndex: number;
  /** Average buy price including fees. */
  entryPrice: number;
  /** Average sell price net of fees. */
  exitPrice: number;
  /** Average buy / sell fill prices (what the exchange filled, before fees). */
  avgBuyFill: number;
  avgSellFill: number;
  qtyBought: number;
  cost: number;
  proceeds: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  /** Profit in units of the initial risk, if the strategy declared a stop. */
  r: number | null;
  exitReason: string;
  entryReason: string;
  bars: number;
}

export interface Portfolio {
  cash: number;
  qty: number;
  feesPaid: number;
  stakedQtyEarned: number;
  stakingValueEarned: number;
  contributed: number;
}

interface LimitOrder {
  id: number;
  side: 'buy' | 'sell';
  price: number;
  /** Sell: coin quantity. Buy: quote amount. */
  amount: number;
  reason: string;
}

interface MarketOrder {
  side: 'buy' | 'sell';
  amount: number;
  reason: string;
}

export interface OpenTradeInfo {
  entryIndex: number;
  entryTime: number;
  cost: number;
  qtyBought: number;
  /** Sum of fill price x quantity for buys and sells, for average fill prices. */
  buyNotional: number;
  sellNotional: number;
  proceeds: number;
  fees: number;
  sold: number;
  initialRisk: number | null;
  entryReason: string;
  highSinceEntry: number;
}

export interface Ctx {
  /** Index of the bar being decided on (its close is known). */
  readonly i: number;
  readonly s: Series;
  readonly p: Readonly<Portfolio>;
  readonly costs: CostModel;
  /** Mark-to-market equity at this bar's close (or at the open during onFill). */
  equity(): number;
  trade(): Readonly<OpenTradeInfo> | null;
  stop(): number | null;
  buy(quote: number, reason: string): void;
  sell(qty: number, reason: string): void;
  setStop(price: number | null): void;
  limitSell(qty: number, price: number, reason: string): number;
  limitBuy(quote: number, price: number, reason: string): number;
  cancelLimits(side?: 'buy' | 'sell'): void;
  pendingLimits(): ReadonlyArray<Readonly<LimitOrder>>;
  /** Declare the risk (quote units) of the current position so trades report R multiples. */
  setInitialRisk(quote: number): void;
  addCash(quote: number): void;
  note(text: string): void;
}

export interface Strategy {
  readonly name: string;
  /** Called once before the first simulated bar; orders placed here fill at that bar's open. */
  onStart?(ctx: Ctx): void;
  /** Called after fills at a bar's open; only the open price of bar `ctx.i` may be used. */
  onFill?(ctx: Ctx, fill: Fill): void;
  /** Called at every bar's close. */
  onBar(ctx: Ctx): void;
}

export interface BacktestOptions {
  initialCash: number;
  costs: CostModel;
  /** Annual staking yield on held coins (0.03 = 3%). */
  stakingApr?: number;
  /** First bar to simulate (earlier bars are history for indicators). */
  startIndex?: number;
  /** Exclusive end index. */
  endIndex?: number;
  /** Minimum order size in quote currency (Binance min notional is ~5-10 USDT). */
  minNotional?: number;
}

export interface BacktestResult {
  strategy: string;
  startIndex: number;
  endIndex: number;
  times: number[];
  equity: number[];
  /** Cash flows into the account (contributions) per recorded bar, for return maths. */
  flows: number[];
  /** Coin quantity held at each recorded bar. */
  qty: number[];
  fills: Fill[];
  trades: Trade[];
  openTrade: OpenTradeInfo | null;
  final: Portfolio & { equity: number; price: number };
  notes: { i: number; time: number; text: string }[];
  initialCash: number;
  /** Orders still working after the last bar (stop, limits, market orders for the next open). */
  pending: {
    stop: number | null;
    limits: { side: 'buy' | 'sell'; price: number; amount: number; reason: string }[];
    market: { side: 'buy' | 'sell'; amount: number; reason: string }[];
  };
}

const YEAR_MS = 365 * 86_400_000;
const DUST = 1e-9;

export function runBacktest(s: Series, strategy: Strategy, opts: BacktestOptions): BacktestResult {
  const n = s.t.length;
  const start = Math.max(0, opts.startIndex ?? 0);
  const end = Math.min(n, opts.endIndex ?? n);
  const costs = opts.costs;
  const apr = opts.stakingApr ?? 0;
  const minNotional = opts.minNotional ?? 5;
  const p: Portfolio = { cash: opts.initialCash, qty: 0, feesPaid: 0, stakedQtyEarned: 0, stakingValueEarned: 0, contributed: 0 };
  let market: MarketOrder[] = [];
  let limits: LimitOrder[] = [];
  let stop: number | null = null;
  let limitId = 0;
  // held in an object so TypeScript does not narrow it across the closures below
  const st: { open: OpenTradeInfo | null } = { open: null };
  const fills: Fill[] = [];
  const trades: Trade[] = [];
  const notes: BacktestResult['notes'] = [];
  const times: number[] = [];
  const equity: number[] = [];
  const flows: number[] = [];
  const qtyHist: number[] = [];
  let flowThisBar = 0;
  let markPrice = start < n ? s.o[start] : 0;
  let cur = start;

  const recordBuy = (i: number, price: number, quote: number, reason: string): Fill | null => {
    quote = Math.min(quote, p.cash);
    if (quote < minNotional || !(price > 0)) return null;
    const fee = quote * costs.feeRate;
    const qty = (quote - fee) / price;
    p.cash -= quote;
    if (p.cash < 1e-9) p.cash = 0;
    p.qty += qty;
    p.feesPaid += fee;
    if (!st.open) {
      st.open = { entryIndex: i, entryTime: s.t[i], cost: 0, qtyBought: 0, buyNotional: 0, sellNotional: 0, proceeds: 0, fees: 0, sold: 0, initialRisk: null, entryReason: reason, highSinceEntry: price };
    }
    st.open.cost += quote;
    st.open.qtyBought += qty;
    st.open.buyNotional += price * qty;
    st.open.fees += fee;
    const f: Fill = { i, time: s.t[i], side: 'buy', price, qty, quote, fee, reason, trade: trades.length };
    fills.push(f);
    return f;
  };

  const recordSell = (i: number, price: number, qty: number, reason: string): Fill | null => {
    qty = Math.min(qty, p.qty);
    if (qty <= DUST || !(price > 0)) return null;
    // allow dust exits below min notional when closing the whole position
    if (qty * price < minNotional && qty < p.qty - DUST) return null;
    const gross = qty * price;
    const fee = gross * costs.feeRate;
    p.qty -= qty;
    if (p.qty < DUST) p.qty = 0;
    p.cash += gross - fee;
    p.feesPaid += fee;
    const f: Fill = { i, time: s.t[i], side: 'sell', price, qty, quote: gross - fee, fee, reason, trade: trades.length };
    fills.push(f);
    if (st.open) {
      st.open.proceeds += gross - fee;
      st.open.sold += qty;
      st.open.sellNotional += gross;
      st.open.fees += fee;
      if (p.qty === 0) {
        const pnl = st.open.proceeds - st.open.cost;
        trades.push({
          entryTime: st.open.entryTime,
          exitTime: s.t[i],
          entryIndex: st.open.entryIndex,
          exitIndex: i,
          entryPrice: st.open.cost / st.open.qtyBought,
          exitPrice: st.open.proceeds / st.open.sold,
          avgBuyFill: st.open.buyNotional / st.open.qtyBought,
          avgSellFill: st.open.sellNotional / st.open.sold,
          qtyBought: st.open.qtyBought,
          cost: st.open.cost,
          proceeds: st.open.proceeds,
          pnl,
          pnlPct: pnl / st.open.cost,
          fees: st.open.fees,
          r: st.open.initialRisk ? pnl / st.open.initialRisk : null,
          exitReason: reason,
          entryReason: st.open.entryReason,
          bars: i - st.open.entryIndex,
        });
        st.open = null;
        stop = null;
        limits = limits.filter((o) => o.side === 'buy');
      }
    }
    return f;
  };

  const ctx: Ctx = {
    get i() {
      return cur;
    },
    s,
    p,
    costs,
    equity: () => p.cash + p.qty * markPrice,
    trade: () => st.open,
    stop: () => stop,
    buy: (quote, reason) => {
      if (quote > 0) market.push({ side: 'buy', amount: quote, reason });
    },
    sell: (qty, reason) => {
      if (qty > 0) market.push({ side: 'sell', amount: qty, reason });
    },
    setStop: (price) => {
      stop = price !== null && price > 0 ? price : null;
    },
    limitSell: (qty, price, reason) => {
      limits.push({ id: ++limitId, side: 'sell', price, amount: qty, reason });
      return limitId;
    },
    limitBuy: (quote, price, reason) => {
      limits.push({ id: ++limitId, side: 'buy', price, amount: quote, reason });
      return limitId;
    },
    cancelLimits: (side) => {
      limits = side ? limits.filter((o) => o.side !== side) : [];
    },
    pendingLimits: () => limits,
    setInitialRisk: (quote) => {
      if (st.open) st.open.initialRisk = quote > 0 ? quote : null;
    },
    addCash: (quote) => {
      if (quote > 0) {
        p.cash += quote;
        p.contributed += quote;
        flowThisBar += quote;
      }
    },
    note: (text) => notes.push({ i: cur, time: s.t[cur], text }),
  };

  if (start < end) {
    cur = start;
    strategy.onStart?.(ctx);
  }

  for (let i = start; i < end; i++) {
    cur = i;
    const o = s.o[i];
    const hi = s.h[i];
    const lo = s.l[i];
    markPrice = o;

    // 1) market orders at the open
    const pending = market;
    market = [];
    for (const m of pending) {
      const f = m.side === 'buy' ? recordBuy(i, o * (1 + costs.slippage), m.amount, m.reason) : recordSell(i, o * (1 - costs.slippage), m.amount, m.reason);
      if (f) strategy.onFill?.(ctx, f);
    }

    // 2) intrabar: stop first (conservative), then limits
    if (p.qty > 0 && stop !== null && lo <= stop) {
      const px = o <= stop ? o * (1 - costs.slippage) : stop * (1 - costs.slippage);
      const f = recordSell(i, px, p.qty, 'stop');
      if (f) strategy.onFill?.(ctx, f);
    }
    if (limits.length) {
      const sorted = [...limits].sort((a, b) => (a.side === b.side ? (a.side === 'sell' ? a.price - b.price : b.price - a.price) : 0));
      for (const lim of sorted) {
        if (!limits.some((x) => x.id === lim.id)) continue; // cancelled by an earlier fill
        if (lim.side === 'sell' && p.qty > 0 && hi >= lim.price) {
          const px = Math.max(o, lim.price);
          limits = limits.filter((x) => x.id !== lim.id);
          const f = recordSell(i, px, lim.amount, lim.reason);
          if (f) strategy.onFill?.(ctx, f);
        } else if (lim.side === 'buy' && p.cash >= minNotional && lo <= lim.price) {
          const px = Math.min(o, lim.price);
          limits = limits.filter((x) => x.id !== lim.id);
          const f = recordBuy(i, px, lim.amount, lim.reason);
          if (f) strategy.onFill?.(ctx, f);
        }
      }
    }

    // 3) staking yield on coins held through the bar
    if (apr > 0 && p.qty > 0) {
      const dt = s.end[i] - s.t[i];
      const add = p.qty * apr * (dt / YEAR_MS);
      p.qty += add;
      p.stakedQtyEarned += add;
      p.stakingValueEarned += add * s.c[i];
    }
    if (st.open) st.open.highSinceEntry = Math.max(st.open.highSinceEntry, hi);

    // 4) close: mark to market, let the strategy decide
    markPrice = s.c[i];
    strategy.onBar(ctx);
    times.push(s.t[i]);
    equity.push(p.cash + p.qty * s.c[i]);
    flows.push(flowThisBar);
    qtyHist.push(p.qty);
    flowThisBar = 0;
  }

  const lastPrice = end > start ? s.c[end - 1] : 0;
  return {
    strategy: strategy.name,
    startIndex: start,
    endIndex: end,
    times,
    equity,
    flows,
    qty: qtyHist,
    fills,
    trades,
    openTrade: st.open,
    final: { ...p, equity: p.cash + p.qty * lastPrice, price: lastPrice },
    notes,
    initialCash: opts.initialCash,
    pending: {
      stop,
      limits: limits.map((o) => ({ side: o.side, price: o.price, amount: o.amount, reason: o.reason })),
      market: market.map((m) => ({ ...m })),
    },
  };
}
