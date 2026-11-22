/**
 * Builds small, committed test fixtures from real Binance data so the test suite
 * runs offline and deterministically. Requires data/ (see research/download.ts)
 * and network access for the native-candle comparison set.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BinanceClient, klineToRow } from '../src/data/binance.ts';
import type { KlineRow } from '../src/engine/types.ts';

const dataFile = (name: string) => new URL(`../data/${name}`, import.meta.url);
const fixture = (name: string) => new URL(`../tests/fixtures/${name}`, import.meta.url);
const loadRows = (name: string): KlineRow[] => (JSON.parse(readFileSync(dataFile(name), 'utf8')) as { rows: KlineRow[] }).rows;
const save = (name: string, obj: unknown) => writeFileSync(fixture(name), JSON.stringify(obj));
const T = (s: string) => Date.parse(s);

async function main() {
  // 1) ETH 1h, 2025-01-01 .. 2025-06-16 (crash + recovery): indicator reference set.
  const h1 = loadRows('ETHUSDT-1h.json').filter((r) => r[0] >= T('2025-01-01T00:00:00Z') && r[0] < T('2025-06-16T00:00:00Z'));
  save('eth-1h-2025H1.json', { symbol: 'ETHUSDT', interval: '1h', barMs: 3_600_000, rows: h1 });
  console.log('eth-1h-2025H1', h1.length);

  // 2) Full ETH daily history: long-term strategies and the DCA plan.
  const d1 = loadRows('ETHUSDT-1d.json').filter((r) => r[0] < T('2026-11-01T00:00:00Z'));
  save('eth-1d-history.json', { symbol: 'ETHUSDT', interval: '1d', barMs: 86_400_000, rows: d1 });
  console.log('eth-1d-history', d1.length);

  // 3) Native Binance candles to verify custom aggregation reproduces them exactly.
  const client = new BinanceClient();
  const from = T('2025-03-03T00:00:00Z'); // a Monday
  const to = T('2025-05-26T00:00:00Z'); // 12 weeks later, also a Monday
  const get = async (iv: string) =>
    (await client.klinesRange('ETHUSDT', iv, from, to - 1)).filter((k) => k.t >= from && k.closeTime < to).map(klineToRow);
  const native: Record<string, KlineRow[]> = {};
  for (const iv of ['15m', '1h', '4h', '1d', '3d', '1w']) native[iv] = await get(iv);
  const monthly = (await client.klinesRange('ETHUSDT', '1M', T('2024-01-01T00:00:00Z'), T('2025-01-01T00:00:00Z') - 1)).map(klineToRow);
  const daily2024 = loadRows('ETHUSDT-1d.json').filter((r) => r[0] >= T('2024-01-01T00:00:00Z') && r[0] < T('2025-01-01T00:00:00Z'));
  save('eth-native-candles.json', { from, to, native, monthly2024: monthly, daily2024 });
  console.log('native', Object.fromEntries(Object.entries(native).map(([k, v]) => [k, v.length])), 'monthly', monthly.length);
}

main();
