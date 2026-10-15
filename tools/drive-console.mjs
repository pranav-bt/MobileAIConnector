// Drives the Task Console in a real browser (Edge) against a MOCK hub:
// submit a task, open its console from the Tasks page, watch rows stream in,
// send a follow-up from the message box (it continues the same
// conversation), pop the console out into its own window, and screenshot
// each step. Fails on any page error.
//   HUB=ws://127.0.0.1:4651 UI=http://localhost:5174 SHOTS_DIR=… node tools/drive-console.mjs
import { chromium } from 'playwright-core';

const HUB = process.env.HUB ?? 'ws://127.0.0.1:4651';
const UI = process.env.UI ?? 'http://localhost:5174';
const SHOTS = process.env.SHOTS_DIR ?? '.';
const errors = [];

// Submit the task over the hub's own protocol (as any client would).
await new Promise((resolve, reject) => {
  const ws = new WebSocket(HUB);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', client: 'cli', name: 'drive-console' }));
    ws.send(JSON.stringify({ type: 'task.submit', text: '@consolproj coding: console-ui writes-files remember MANGO' }));
    setTimeout(() => (ws.close(), resolve()), 800);
  });
  ws.addEventListener('error', () => reject(new Error(`hub not reachable at ${HUB}`)));
});

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((hub) => localStorage.setItem('hq.hubUrl', hub), HUB);
const page = await context.newPage();
const watchErrors = (target) => {
  target.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  target.on('pageerror', (error) => errors.push(String(error)));
};
watchErrors(page);

await page.goto(UI);
await page.waitForSelector('text=Master office', { timeout: 20000 });
await page.click('button:has-text("Tasks")');
await page.waitForSelector('text=console-ui', { timeout: 15000 });
await page.click('.tcard:has-text("console-ui")');
await page.click('button:has-text("Open console")');
await page.waitForSelector('.console-drawer >> text=Mock worker on it', { timeout: 15000 });
await page.waitForSelector('.console-drawer >> text=review', { timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/console-drawer.png` });

// A follow-up from the message box continues the same conversation.
await page.fill('.console-drawer textarea', 'recall-test what did I ask you to remember?');
await page.keyboard.press('Enter');
await page.waitForSelector('.console-drawer >> text=/remembered: .*MANGO/', { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/console-followup.png` });

// Expand a tool row's output.
await page.click('.console-drawer .mono:has-text("echo mock")');
await page.waitForTimeout(300);

// Pop out into its own window.
const [popup] = await Promise.all([context.waitForEvent('page'), page.click('button:has-text("Pop out")')]);
watchErrors(popup);
await popup.waitForSelector('text=/remembered: .*MANGO/', { timeout: 15000 });
await popup.setViewportSize({ width: 780, height: 920 });
await popup.waitForTimeout(600);
await popup.screenshot({ path: `${SHOTS}/console-popout.png` });
const drawerGone = (await page.$('.console-drawer')) === null;

console.log(`drawer closed after pop-out: ${drawerGone}`);
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'console drove cleanly, no page errors');
await browser.close();
process.exit(errors.length || !drawerGone ? 1 : 0);
