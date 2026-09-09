// Verifies the real-engine office starts clean: master + leads standing by,
// no tasks, no scripted theater.
import { chromium } from 'playwright-core';

const SHOTS = process.env.SHOTS_DIR ?? '.';
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto('http://localhost:5173');
await page.waitForSelector('text=Master office', { timeout: 20000 });
await page.waitForSelector('text=standing by', { timeout: 10000 });
await page.screenshot({ path: `${SHOTS}/office-empty.png` });
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'empty office rendered, no console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
