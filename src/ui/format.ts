/** Display formatting. Prices adapt their decimals to their size (BTC vs DOGE vs PEPE). */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return '–';
  const a = Math.abs(p);
  const d = a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
  return p.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}

export function fmtUsd(v: number, compact = false): string {
  if (!Number.isFinite(v)) return '–';
  if (compact && Math.abs(v) >= 100_000) return `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}k`;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });
}

export function fmtPct(x: number, digits = 1, sign = true): string {
  if (!Number.isFinite(x)) return '–';
  const s = (x * 100).toFixed(digits);
  return `${sign && x > 0 ? '+' : ''}${s}%`;
}

export function fmtNum(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '–';
  return x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtQty(q: number): string {
  if (!Number.isFinite(q)) return '–';
  return q.toLocaleString('en-US', { maximumFractionDigits: q >= 100 ? 2 : 4 });
}

export function fmtDate(ms: number, withTime = false): string {
  if (!Number.isFinite(ms)) return '–';
  const d = new Date(ms);
  const s = d.toISOString();
  return withTime ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` : s.slice(0, 10);
}

export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtDays(d: number): string {
  if (!Number.isFinite(d)) return 'never';
  if (d < 60) return `${Math.round(d)} days`;
  if (d < 730) return `${(d / 30.4).toFixed(0)} months`;
  return `${(d / 365).toFixed(1)} years`;
}

export function fmtYears(y: number): string {
  if (!Number.isFinite(y)) return 'not at this rate';
  if (y < 1) return `${Math.round(y * 12)} months`;
  return `${y.toFixed(1)} years`;
}

export const baseSymbol = (s: string) => s.replace(/(USDT|USDC|FDUSD|BUSD)$/, '');

/** Diverging background for a score in [-1, 1] (sell red ... neutral ... buy green). */
export function scoreStyle(v: number): Record<string, string> {
  if (!Number.isFinite(v)) return { background: 'var(--surface-2)', color: 'var(--faint)' };
  const a = Math.min(1, Math.abs(v));
  const pct = Math.round(18 + a * 62);
  const base = v >= 0 ? 'var(--buy)' : 'var(--sell)';
  return {
    background: `color-mix(in srgb, ${base} ${pct}%, var(--surface))`,
    color: a > 0.45 ? '#fff' : 'var(--ink)',
  };
}
