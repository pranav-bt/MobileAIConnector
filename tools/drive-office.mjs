// Drives the Agent HQ office UI in headless Edge: waits for the demo's
// permission request, approves it, submits a task, screenshots both moments.
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
console.log('office rendered');

// The demo raises C-3's hand ~6s in (one-shot per hub run).
await page.waitForSelector('.tcard.awaiting', { timeout: 25000 });
console.log('permission request arrived');
await page.screenshot({ path: `${SHOTS}/office-awaiting.png` });

// VERIFY_ONLY leaves the pending approval untouched for a human to click.
if (!process.env.VERIFY_ONLY) {
  await page.click('button:has-text("Approve")');
  await page.waitForSelector('text=resuming e2e setup', { timeout: 10000 });
  console.log('approve round-trip rendered');

  await page.fill('input[placeholder*="master agent"]', 'Browser smoke: wire up the settings page');
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=Browser smoke: wire up the settings page', { timeout: 10000 });
  console.log('submitted task visible');

  // Give the demo a beat to route it to the coding room, then capture.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/office-after.png` });
}

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
