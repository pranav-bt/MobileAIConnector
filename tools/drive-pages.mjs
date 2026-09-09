// Walks every desktop page and screenshots the ones added in the
// "complete the desktop" milestone (Tasks with expanded detail, Resources,
// History, Settings). Checks the console stays clean throughout.
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

await page.click('button:has-text("Tasks")');
await page.waitForSelector('text=Current', { timeout: 8000 });
await page.click('.tcard'); // expand the first task's detail
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/page-tasks.png` });

await page.click('button:has-text("Resources")');
await page.waitForSelector('text=Model mix', { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/page-resources.png` });

await page.click('button:has-text("History")');
await page.waitForSelector('text=History ·', { timeout: 8000 });

await page.click('button:has-text("Settings")');
await page.waitForSelector('text=Hub address', { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/page-settings.png` });

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'all pages rendered, no console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
