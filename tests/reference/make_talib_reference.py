"""Writes TA-Lib outputs for the real ETH 1h fixture so the TypeScript indicators
can be cross-checked against an independent, widely used implementation.
Run: python tests/reference/make_talib_reference.py  (needs `pip install TA-Lib numpy`)"""
import json, math, pathlib
import numpy as np
import talib

root = pathlib.Path(__file__).resolve().parents[1] / "fixtures"
fx = json.loads((root / "eth-1h-2025H1.json").read_text())
rows = np.array(fx["rows"], dtype=float)
o, h, l, c, v = (rows[:, k] for k in range(1, 6))

def arr(x):
    return [None if (isinstance(val, float) and math.isnan(val)) else float(val) for val in x]

macd, macds, macdh = talib.MACD(c, 12, 26, 9)
up, mid, lo = talib.BBANDS(c, 20, 2.0, 2.0, 0)
fastk, fastd = talib.STOCHRSI(c, timeperiod=14, fastk_period=14, fastd_period=3, fastd_matype=0)
out = {
    "sma20": arr(talib.SMA(c, 20)),
    "ema20": arr(talib.EMA(c, 20)),
    "ema50": arr(talib.EMA(c, 50)),
    "ema200": arr(talib.EMA(c, 200)),
    "rsi14": arr(talib.RSI(c, 14)),
    "atr14": arr(talib.ATR(h, l, c, 14)),
    "macd": arr(macd), "macdSignal": arr(macds), "macdHist": arr(macdh),
    "bbUpper": arr(up), "bbMid": arr(mid), "bbLower": arr(lo),
    "stochRsiFastD": arr(fastd),
    "plusDi14": arr(talib.PLUS_DI(h, l, c, 14)),
    "minusDi14": arr(talib.MINUS_DI(h, l, c, 14)),
    "adx14": arr(talib.ADX(h, l, c, 14)),
    "obv": arr(talib.OBV(c, v)),
    "mfi14": arr(talib.MFI(h, l, c, v, 14)),
    "linregSlope20": arr(talib.LINEARREG_SLOPE(c, 20)),
    "stddev20": arr(talib.STDDEV(c, 20, 1.0)),
    "max20": arr(talib.MAX(h, 20)),
    "min20": arr(talib.MIN(l, 20)),
    "trange": arr(talib.TRANGE(h, l, c)),
}
(root / "talib-eth-1h.json").write_text(json.dumps({"talib": talib.__version__, "series": out}))
print("wrote", len(out), "series for", len(c), "bars")
