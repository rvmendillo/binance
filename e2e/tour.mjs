// Visual tour against LIVE Binance data: node e2e/tour.mjs <outdir>
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const out = process.argv[2] ?? 'e2e/out';
mkdirSync(out, { recursive: true });
const html = readFileSync(new URL('../dist/index.html', import.meta.url));
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 1, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('.decision .pill', { timeout: 90000 });
  const modes = scheme === 'light' ? ['Swing', 'Day trade', 'Scalp'] : ['Day trade'];
  for (const m of modes) {
    const t0 = Date.now();
    await page.click(`.seg button:has-text("${m}")`);
    await page.waitForFunction(() => document.querySelector('.decision .pill') && !document.querySelector('.progress'), null, { timeout: 120000 });
    await page.waitForTimeout(800);
    console.log(scheme, m, 'ready in', Date.now() - t0, 'ms |', (await page.textContent('.decision')).slice(0, 160).replace(/\s+/g, ' '));
    await page.screenshot({ path: `${out}/${scheme}-eth-${m.replace(' ', '')}.png`, fullPage: true });
  }
  if (scheme === 'light') {
    await page.click('.tab:has-text("Coins")');
    await page.waitForTimeout(25000);
    await page.screenshot({ path: `${out}/${scheme}-coins.png`, fullPage: true });
    console.log('coins rows:', await page.$$eval('.coin', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ')));
    await page.click('.coin >> nth=0');
    await page.waitForSelector('.decision .pill', { timeout: 90000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${scheme}-coin-detail.png`, fullPage: true });
    await page.click('.tab:has-text("Projection")');
    await page.waitForSelector('.probs', { timeout: 120000 });
    await page.waitForTimeout(1500);
    console.log('projection:', (await page.textContent('.probs')).replace(/\s+/g, ' '));
    await page.screenshot({ path: `${out}/${scheme}-projection.png`, fullPage: true });
    await page.click('.tab:has-text("Settings")');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${scheme}-settings.png`, fullPage: true });
  }
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(scheme, 'scrollWidth', w, 'errors:', errors.length ? errors.join(' | ') : 'none');
  await ctx.close();
}
await browser.close();
server.close();
