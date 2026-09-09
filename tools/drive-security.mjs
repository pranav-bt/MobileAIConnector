// Drives the desktop Security page: opens pairing mode, screenshots the QR,
// cancels pairing to leave a clean state.
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
await page.click('button:has-text("Security")');
await page.waitForSelector('text=Paired device', { timeout: 10000 });
await page.click('button:has-text("Pair a device")');
await page.waitForSelector('img[alt="pairing QR"]', { timeout: 10000 });
console.log('pairing QR rendered');
await page.screenshot({ path: `${SHOTS}/security-page.png` });
await page.click('button:has-text("Cancel pairing")');
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
