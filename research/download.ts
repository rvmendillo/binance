/**
 * Downloads closed Binance spot klines into data/<SYMBOL>-<interval>.json
 * (format: {symbol, interval, rows: [[t,o,h,l,c,v], ...]}). Re-running only
 * fetches what is new. Usage: node research/download.ts [--quick]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BinanceClient, klineToRow, splitClosed } from '../src/data/binance.ts';
import type { KlineRow } from '../src/engine/types.ts';

const DATA_DIR = new URL('../data/', import.meta.url);
mkdirSync(DATA_DIR, { recursive: true });

const D = (s: string) => Date.parse(s + 'T00:00:00Z');
const quick = process.argv.includes('--quick');

const OTHERS = ['BTCUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'];
const jobs: { symbol: string; interval: string; from: number }[] = [
  { symbol: 'ETHUSDT', interval: '1d', from: D('2017-08-01') },
  { symbol: 'ETHUSDT', interval: '1h', from: D('2017-08-01') },
  { symbol: 'ETHUSDT', interval: '15m', from: D(quick ? '2025-06-01' : '2020-01-01') },
  { symbol: 'ETHUSDT', interval: '1m', from: D(quick ? '2026-10-01' : '2025-11-01') },
  ...OTHERS.map((symbol) => ({ symbol, interval: '1d', from: D('2017-01-01') })),
  ...OTHERS.map((symbol) => ({ symbol, interval: '15m', from: D(quick ? '2025-06-01' : '2022-01-01') })),
  ...OTHERS.map((symbol) => ({ symbol, interval: '1m', from: D(quick ? '2026-11-01' : '2026-08-01') })),
];

function load(path: URL): KlineRow[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { rows: KlineRow[] }).rows;
}

async function runJob(client: BinanceClient, job: (typeof jobs)[number]): Promise<string> {
  const path = new URL(`${job.symbol}-${job.interval}.json`, DATA_DIR);
  const rows = load(path);
  const start = rows.length ? rows[rows.length - 1][0] + 1 : job.from;
  const now = await client.serverTime();
  const klines = await client.klinesRange(job.symbol, job.interval, start, now);
  const { closed } = splitClosed(klines, now);
  for (const k of closed) {
    if (rows.length && k.t <= rows[rows.length - 1][0]) continue;
    rows.push(klineToRow(k));
  }
  writeFileSync(path, JSON.stringify({ symbol: job.symbol, interval: job.interval, rows }));
  const first = rows.length ? new Date(rows[0][0]).toISOString().slice(0, 10) : '-';
  const last = rows.length ? new Date(rows[rows.length - 1][0]).toISOString().slice(0, 16) : '-';
  return `${job.symbol} ${job.interval}: ${rows.length} bars (${first} -> ${last}), +${closed.length} new`;
}

/** Daily USD -> PHP reference rates (ECB, via Frankfurter) for the peso results. */
async function downloadFx() {
  const res = await fetch('https://api.frankfurter.dev/v1/2017-08-01..?base=USD&symbols=PHP');
  if (!res.ok) throw new Error(`exchange rates: HTTP ${res.status}`);
  const body = await res.json();
  writeFileSync(new URL('USDPHP.json', DATA_DIR), JSON.stringify(body));
  return `USD/PHP: ${Object.keys((body as { rates: object }).rates).length} days`;
}

async function main() {
  try {
    console.log(await downloadFx());
  } catch (e) {
    console.error('FAILED exchange rates:', e);
    process.exitCode = 1;
  }
  const clients = [new BinanceClient({ minIntervalMs: 60 }), new BinanceClient({ minIntervalMs: 60 })];
  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    clients.map(async (client) => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          console.log(await runJob(client, job), `[${((Date.now() - t0) / 1000).toFixed(0)}s]`);
        } catch (e) {
          console.error(`FAILED ${job.symbol} ${job.interval}:`, e);
          process.exitCode = 1;
        }
      }
    }),
  );
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
