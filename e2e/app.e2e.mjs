// End-to-end tests of the built app (dist/index.html) in Chromium with an iPhone
// viewport. Binance REST and WebSocket traffic is mocked so results are deterministic.
// Run: npm run build && npm run e2e
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright'); // pre-installed globally

const html = readFileSync(new URL('../dist/index.html', import.meta.url));
const ethDaily = JSON.parse(readFileSync(new URL('../tests/fixtures/eth-1d-history.json', import.meta.url))).rows;
const NOW = Date.parse('2026-11-01T06:00:00Z'); // the fixture ends with the 2026-10-31 daily candle
const DAY = 86_400_000;
const IV = { '1m': 60e3, '15m': 900e3, '1h': 3600e3, '1d': DAY };

/** Deterministic synthetic candles for anything except ETH daily (which is real data). */
function synth(symbol, interval, start, end) {
  const ms = IV[interval];
  let seed = [...symbol + interval].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const rows = [];
  const first = Math.floor(start / ms) * ms;
  const t0 = Math.floor((NOW - 400 * DAY) / ms) * ms;
  let p = symbol.startsWith('ETH') ? 2400 : 100;
  for (let t = t0; t + ms <= end + ms; t += ms) {
    const o = p;
    p = p * Math.exp(0.004 * (rnd() - 0.5) * Math.sqrt(ms / 60e3) * 0.3);
    const h = Math.max(o, p) * (1 + 0.001 * rnd());
    const l = Math.min(o, p) * (1 - 0.001 * rnd());
    if (t >= first) rows.push([t, o.toFixed(4), h.toFixed(4), l.toFixed(4), p.toFixed(4), (100 + 50 * rnd()).toFixed(3), t + ms - 1, '0', 10, '0', '0', '0']);
  }
  return rows;
}

function klines(url) {
  const q = new URL(url).searchParams;
  const symbol = q.get('symbol');
  const interval = q.get('interval');
  const start = Number(q.get('startTime') ?? 0);
  const end = Math.min(Number(q.get('endTime') ?? NOW), NOW);
  const limit = Number(q.get('limit') ?? 500);
  let rows;
  if (symbol === 'ETHUSDT' && interval === '1d') {
    rows = ethDaily.filter((r) => r[0] >= start && r[0] <= end).map((r) => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5]), r[0] + DAY - 1, '0', 1, '0', '0', '0']);
    // the forming candle of "today"
    if (end >= Date.UTC(2026, 10, 1)) rows.push([Date.UTC(2026, 10, 1), '2500', '2510', '2490', '2505', '10', Date.UTC(2026, 10, 1) + DAY - 1, '0', 1, '0', '0', '0']);
  } else {
    rows = synth(symbol, interval, start, end);
  }
  return rows.slice(0, limit);
}

let server;
let base;
let browser;
before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  }).listen(0);
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** New page with mocked Binance. `rest` can override the REST handler. */
async function open({ viewport, rest, ws = 'ok', settings } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 1, ...(viewport ? { viewport } : {}) });
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (settings) await page.addInitScript((s) => localStorage.setItem('confluence.settings.v1', JSON.stringify(s)), settings);
  await page.route(/binance\.(vision|com)\/api\/v3\//, async (route) => {
    const url = route.request().url();
    if (rest) {
      const r = await rest(url);
      if (r) return route.fulfill(r);
    }
    if (url.includes('/api/v3/time')) return route.fulfill({ json: { serverTime: await route.request().frame().page().evaluate(() => Date.now()) }, headers: { 'access-control-allow-origin': '*' } });
    if (url.includes('/klines')) return route.fulfill({ json: klines(url), headers: { 'access-control-allow-origin': '*' } });
    if (url.includes('/ticker/24hr')) {
      const syms = JSON.parse(new URL(url).searchParams.get('symbols'));
      return route.fulfill({ json: syms.map((s) => ({ symbol: s, lastPrice: s === 'ETHUSDT' ? '2505' : '100', priceChangePercent: '1.5', highPrice: '0', lowPrice: '0', quoteVolume: '0' })), headers: { 'access-control-allow-origin': '*' } });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  const sockets = [];
  const messages = [];
  await page.routeWebSocket(/binance\.(vision|com)/, (sock) => {
    if (ws === 'fail') {
      sock.close();
      return;
    }
    sockets.push(sock);
    sock.onMessage((m) => messages.push({ at: Date.now(), msg: JSON.parse(String(m)) }));
  });
  await page.goto(base);
  return { ctx, page, errors, sockets, messages };
}

const decision = async (page) => (await page.textContent('.decision')).replace(/\s+/g, ' ');

test('loads ETH long-term from history and shows a decision with every strategy', async () => {
  const { ctx, page, errors } = await open();
  await page.waitForSelector('.decision .pill', { timeout: 60000 });
  const text = await decision(page);
  assert.match(text, /^(BUY|SELL|HOLD|WAIT)/);
  const names = await page.$$eval('.table tbody tr td:first-child', (tds) => tds.map((td) => td.textContent.trim()));
  for (const n of ['My plan', 'Plan + confluence', 'Confluence allocator', 'Buy & hold']) assert.ok(names.some((x) => x.includes(n)), `missing ${n}`);
  // the plan's three historical sells at 4,000 appear in the trade list
  const trades = await page.$$eval('.item .title', (els) => els.map((e) => e.textContent));
  assert.ok(trades.filter((t) => /4,000/.test(t)).length >= 3, `expected 3 sells at 4,000, got ${trades.join(' | ')}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('live candles extend the simulation (history + live combined)', async () => {
  const { ctx, page, sockets, errors } = await open();
  await page.waitForSelector('.decision .pill', { timeout: 60000 });
  await page.waitForTimeout(800);
  assert.ok(sockets.length >= 1, 'app opened a WebSocket');
  const before = await decision(page);
  const send = (k) => sockets[0].send(JSON.stringify({ stream: 'ethusdt@kline_1d', data: { e: 'kline', s: 'ETHUSDT', k } }));
  // ETH collapses into the buy zone on the next daily candle
  const t = Date.UTC(2026, 10, 1);
  send({ t, T: t + DAY - 1, s: 'ETHUSDT', i: '1d', o: '2505', h: '2510', l: '1580', c: '1650', v: '1000', x: true });
  await page.waitForFunction((b) => document.querySelector('.decision')?.textContent.replace(/\s+/g, ' ') !== b, before, { timeout: 30000 });
  const after1 = await decision(page);
  assert.match(after1, /^BUY/, after1);
  assert.match(after1, /buy zone/i);
  // then rallies through the target
  send({ t: t + DAY, T: t + 2 * DAY - 1, s: 'ETHUSDT', i: '1d', o: '1650', h: '4300', l: '1640', c: '4200', v: '1000', x: true });
  await page.waitForFunction((b) => document.querySelector('.decision')?.textContent.replace(/\s+/g, ' ') !== b, after1, { timeout: 30000 });
  const after2 = await decision(page);
  assert.match(after2, /^(SELL|WAIT|HOLD)/, after2);
  assert.doesNotMatch(after2, /^BUY/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('changing the plan in Settings re-runs the simulation', async () => {
  const { ctx, page } = await open();
  await page.waitForSelector('.decision .pill', { timeout: 60000 });
  await page.click('.tab:has-text("Settings")');
  // the fixture's last daily close is 2,255.66: a 2,200-2,300 zone puts price inside it
  await page.fill('#zl', '2200');
  await page.fill('#zh', '2300');
  await page.click('button:has-text("Apply settings")');
  await page.waitForSelector('.banner.info');
  await page.click('.tab:has-text("ETH")');
  await page.waitForFunction(() => /2,200-2,300/.test(document.querySelector('.decision')?.textContent ?? ''), null, { timeout: 30000 });
  assert.match(await decision(page), /^BUY/);
  // and a zone above the price makes the plan wait
  await page.click('.tab:has-text("Settings")');
  await page.fill('#zl', '2400');
  await page.fill('#zh', '2600');
  await page.click('button:has-text("Apply settings")');
  await page.click('.tab:has-text("ETH")');
  await page.waitForFunction(() => /below your buy zone|Holding/.test(document.querySelector('.decision')?.textContent ?? ''), null, { timeout: 30000 });
  assert.doesNotMatch(await decision(page), /^BUY/);
  // invalid input is rejected with a message, settings unchanged
  await page.click('.tab:has-text("Settings")');
  await page.fill('#zl', '3000');
  await page.fill('#zh', '2000');
  await page.click('button:has-text("Apply settings")');
  assert.match(await page.textContent('.errors'), /low price below the high/);
  await ctx.close();
});

test('custom timeframes are validated', async () => {
  const { ctx, page } = await open();
  await page.click('.tab:has-text("Settings")');
  await page.fill('#tfs-swing', '2h, 90m, 1w');
  await page.click('button:has-text("Apply settings")');
  assert.match(await page.textContent('.errors'), /90m cannot be built from 1h/);
  await page.fill('#tfs-swing', '2h, 3h, 5h, 1d, 2d, 1w');
  await page.click('button:has-text("Apply settings")');
  await page.waitForSelector('.banner.info');
  await page.click('.tab:has-text("ETH")');
  await page.click('.seg button:has-text("Swing")');
  await page.waitForSelector('.matrix', { timeout: 60000 });
  const tfs = await page.$$eval('.matrix td.tf', (tds) => tds.map((t) => t.textContent.replace('✱', '').trim()));
  assert.deepEqual(tfs, ['1h', '2h', '3h', '5h', '1d', '2d', '1w']);
  await ctx.close();
});

test('every trading style renders and its edge filter explains itself', async () => {
  const { ctx, page, errors } = await open();
  await page.waitForSelector('.decision .pill', { timeout: 60000 });
  for (const m of ['Swing', 'Day trade', 'Scalp']) {
    await page.click(`.seg button:has-text("${m}")`);
    await page.waitForFunction(() => document.querySelector('.decision .pill') && document.querySelector('.kv'), null, { timeout: 60000 });
    await page.waitForSelector('text=Trade setup and edge check');
    const names = await page.$$eval('.table tbody tr td:first-child', (tds) => tds.map((td) => td.textContent.trim()));
    assert.ok(names.some((n) => n.includes('Confluence trader')), `${m}: ${names}`);
    assert.ok(names.some((n) => n.includes('no edge filter')), `${m}: ${names}`);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('falls back to REST polling when WebSockets cannot connect', async () => {
  const { ctx, page } = await open({ ws: 'fail' });
  await page.waitForSelector('.decision .pill', { timeout: 60000 });
  await page.clock.runFor(20_000);
  await page.waitForFunction(() => /Polling/.test(document.querySelector('[data-testid=feed]')?.textContent ?? ''), null, { timeout: 20000 });
  await ctx.close();
});

test('shows a clear error when Binance is not reachable from the network', async () => {
  const rest = async () => ({ status: 451, body: JSON.stringify({ code: 0, msg: "Service unavailable from a restricted location" }) });
  const { ctx, page } = await open({ rest });
  await page.waitForSelector('.banner.error', { timeout: 60000 });
  assert.match(await page.textContent('.banner.error'), /not available from your network location/);
  assert.ok(await page.isVisible('button:has-text("Try again")'));
  await ctx.close();
});

test('stream subscriptions are batched (Binance allows 5 messages a second)', async () => {
  const { ctx, page, messages } = await open();
  await page.waitForSelector('.decision .pill', { timeout: 60000 });
  await page.click('.tab:has-text("Coins")');
  await page.waitForTimeout(3000);
  const subs = messages.filter((m) => m.msg.method === 'SUBSCRIBE');
  assert.ok(subs.length >= 1);
  const tickers = subs.flatMap((m) => m.msg.params).filter((p) => /@miniticker$/i.test(p));
  assert.ok(tickers.length >= 10, `subscribed ${tickers.length} tickers`);
  for (const m of messages) {
    const inWindow = messages.filter((x) => x.at >= m.at && x.at < m.at + 1000).length;
    assert.ok(inWindow <= 5, `${inWindow} messages within one second`);
  }
  await ctx.close();
});

test('fits small phones without sideways scrolling, in every tab', async () => {
  for (const viewport of [{ width: 320, height: 640 }, { width: 375, height: 667 }]) {
    const { ctx, page } = await open({ viewport });
    await page.waitForSelector('.decision .pill', { timeout: 60000 });
    for (const tab of ['ETH', 'Coins', 'Projection', 'Settings']) {
      await page.click(`.tab:has-text("${tab}")`);
      await page.waitForTimeout(tab === 'Projection' ? 4000 : 800);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(w <= viewport.width, `${tab} at ${viewport.width}px scrolls sideways (${w}px)`);
    }
    await ctx.close();
  }
});

test('projection screen simulates the plan forward', async () => {
  const { ctx, page, errors } = await open();
  await page.click('.tab:has-text("Projection")');
  await page.waitForSelector('.probs', { timeout: 90000 });
  const probs = await page.$$eval('.prob strong', (els) => els.map((e) => parseFloat(e.textContent)));
  assert.equal(probs.length, 5);
  for (let k = 1; k < probs.length; k++) assert.ok(probs[k] >= probs[k - 1], `probabilities must not fall with time: ${probs}`);
  await page.click('.seg button:has-text("No trend")');
  await page.waitForTimeout(3000);
  assert.match(await page.textContent('.card'), /average trend is removed/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
