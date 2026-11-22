import type { Strategy } from '../backtest.ts';

/** Benchmark: buy with all cash at the first simulated open and hold (optionally staked). */
export function hodl(name = 'Buy & hold'): Strategy {
  return {
    name,
    onStart: (c) => c.buy(c.p.cash, 'buy and hold'),
    onBar: () => {},
  };
}
