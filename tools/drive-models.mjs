// Drives the Settings > Models card against the LIVE hub: renders it, makes
// one custom pick (All workers = Haiku), checks the count + hub state, then
// hits "Reset all to defaults" and confirms it's back to all-default.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto('http://localhost:5173');
await page.waitForSelector('text=Master office', { timeout: 20000 });
await page.click('button:has-text("Settings")');
await page.waitForSelector('text=Reset all to defaults', { timeout: 8000 });
await page.waitForSelector('text=all default', { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/models-default.png` });

// Selects in order: master, checks, all leads, all workers, then per team.
await page.locator('select').nth(3).selectOption('haiku');
await page.waitForSelector('text=1 custom', { timeout: 8000 });
const afterPick = await hubOverrides();
if (afterPick.worker !== 'haiku') throw new Error(`hub did not store the pick: ${JSON.stringify(afterPick)}`);
await page.screenshot({ path: `${SHOTS}/models-custom.png` });

await page.click('button:has-text("Reset all to defaults")');
await page.waitForSelector('text=all default', { timeout: 8000 });
const afterReset = await hubOverrides();
if (afterReset.worker !== undefined) throw new Error(`reset did not clear: ${JSON.stringify(afterReset)}`);

console.log(`selects on the card: ${await page.locator('select').count()}`);
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'models card: rendered, pick stored in hub, reset cleared it, no console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
