// Drives the Settings > Models card against the LIVE hub: renders it, picks
// Opus 5.5 at Max effort for the master and Haiku for all workers, checks the
// hub stored exactly that (and that Haiku's effort control is disabled),
// then hits "Reset all to defaults" and confirms it's back to all-default.
// Ends in the same state it started (assumes you start at all-default).
import { chromium } from 'playwright-core';

const SHOTS = process.env.SHOTS_DIR ?? '.';
const errors = [];

const hubOverrides = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:4517');
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', client: 'cli', name: 'drive-models' })));
    ws.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data)).event;
      if (event?.type === 'snapshot') {
        ws.close();
        resolve(event.snapshot.info.modelOverrides);
      }
    });
    setTimeout(() => reject(new Error('hub snapshot timeout')), 8000);
  });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto('http://localhost:5173');
await page.waitForSelector('text=Master office', { timeout: 20000 });
await page.click('button:has-text("Settings")');
await page.waitForSelector('text=Reset all to defaults', { timeout: 8000 });
await page.waitForSelector('text=all default', { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/models-default.png`, fullPage: true });

// Select order: master model, master effort, checks model, checks effort,
// all-leads model, all-leads effort, all-workers model, all-workers effort,
// then per team: lead model, lead effort, worker model, worker effort.
const selects = page.locator('select');
await selects.nth(0).selectOption('claude-opus-5-5');
await page.waitForSelector('text=1 custom', { timeout: 8000 });
await selects.nth(1).selectOption('max');
await page.waitForSelector('text=2 custom', { timeout: 8000 });
await selects.nth(6).selectOption('claude-haiku-4-5-20251001');
await page.waitForSelector('text=3 custom', { timeout: 8000 });

const stored = await hubOverrides();
if (stored.master?.model !== 'claude-opus-5-5' || stored.master?.effort !== 'max' || stored.worker?.model !== 'claude-haiku-4-5-20251001') {
  throw new Error(`hub did not store the picks: ${JSON.stringify(stored)}`);
}
if (!(await selects.nth(7).isDisabled())) throw new Error('all-workers effort should be disabled for Haiku');
await page.screenshot({ path: `${SHOTS}/models-custom.png`, fullPage: true });

await page.click('button:has-text("Reset all to defaults")');
await page.waitForSelector('text=all default', { timeout: 8000 });
const afterReset = await hubOverrides();
if (afterReset.master || afterReset.worker) throw new Error(`reset did not clear: ${JSON.stringify(afterReset)}`);

console.log(`selects on the card: ${await selects.count()}`);
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'models card: model + effort picks stored in hub, Haiku effort disabled, reset cleared it, no console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
