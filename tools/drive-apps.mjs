// Drives Settings > Apps + the Teams page grant in a real browser (Edge)
// against a MOCK hub (test/ui-mock-hub.ts — temp data; Blender is detected
// from this PC): a bad path is refused with the reason shown, the detected
// Blender is added from its suggestion, its options are edited, it is
// granted to a team on the Teams page (tagged "app"), and removed again.
// Screenshots each step; fails on page errors.
//   HUB=ws://127.0.0.1:4651 UI=http://localhost:5174 SHOTS_DIR=… node tools/drive-apps.mjs
import { chromium } from 'playwright-core';

const HUB = process.env.HUB ?? 'ws://127.0.0.1:4651';
const UI = process.env.UI ?? 'http://localhost:5174';
const SHOTS = process.env.SHOTS_DIR ?? '.';
const errors = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((hub) => localStorage.setItem('hq.hubUrl', hub), HUB);
const page = await context.newPage();
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(UI);
await page.waitForSelector('text=Master office', { timeout: 20000 });

// 1. Settings > Apps: a refusal shows its reason.
await page.click('.navi:has-text("Settings")');
await page.waitForSelector('text=Apps for workers', { timeout: 10000 });
await page.fill('input[aria-label="App name"]', 'Nowhere');
await page.fill('input[aria-label="App program path"]', 'C:\\Nowhere\\nothing.exe');
await page.getByRole('button', { name: 'Add app' }).click();
await page.waitForSelector("text=/couldn't add Nowhere — nothing at/", { timeout: 5000 });
check('a missing program is refused, with the reason under the form', true);

// 2. Add the detected Blender from its suggestion.
const suggestion = page.getByRole('button', { name: /^Add Blender/ });
check('Blender on this PC is suggested', (await suggestion.count()) === 1, (await suggestion.getAttribute('aria-label')) ?? '');
const blenderName = ((await suggestion.getAttribute('aria-label')) ?? 'Add Blender').slice(4);
await suggestion.click();
await page.getByRole('button', { name: `Remove ${blenderName}`, exact: true }).waitFor({ timeout: 5000 });
const card = await page.innerText('.main');
check('added: Blender kind, connection id, no team yet', /Blender · Python, render, scene/.test(card) && /connection "blender"/.test(card) && card.includes('no team yet'));
check('the suggestion is gone', (await page.getByRole('button', { name: /^Add Blender/ }).count()) === 0);

// 3. Edit it: background mode, idle minutes, notes.
await page.getByLabel(`Show ${blenderName}'s window`).click();
await page.waitForFunction((name) => !document.querySelector(`input[aria-label="Show ${name}'s window"]`)?.checked, blenderName, { timeout: 5000 });
await page.fill(`input[aria-label="${blenderName} idle minutes"]`, '5');
await page.press(`input[aria-label="${blenderName} idle minutes"]`, 'Enter');
await page.fill(`input[aria-label="${blenderName} notes"]`, 'Units are metres; export glTF to assets/models');
await page.press(`input[aria-label="${blenderName} notes"]`, 'Enter');
await page.waitForSelector(`text=/${blenderName} updated/`, { timeout: 5000 });
await page.waitForTimeout(500);
check('window off, 5 idle minutes, notes saved', (await page.inputValue(`input[aria-label="${blenderName} idle minutes"]`)) === '5');
await page.locator('text=Apps for workers').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/apps-settings.png` });

// 4. Teams page: grant it to the Design team; it's tagged as an app.
await page.click('.navi:has-text("Teams")');
await page.click('text=Design team');
const row = page.locator('label', { hasText: blenderName });
await row.waitFor({ timeout: 10000 });
check('the app is a connection, tagged "app"', (await row.innerText()).includes('app'));
await row.locator('input[type="checkbox"]').click();
await page.waitForFunction((name) => [...document.querySelectorAll('label')].some((label) => label.textContent.includes(name) && label.querySelector('input')?.checked), blenderName, { timeout: 5000 });
check('granted to the Design team', true);
await row.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/apps-teams.png` });

// 5. Back in Settings: it says who uses it; remove it (the team loses it too).
await page.click('.navi:has-text("Settings")');
await page.waitForSelector('text=used by Design team', { timeout: 5000 });
check('Settings shows which teams use it', true);
await page.getByRole('button', { name: `Remove ${blenderName}`, exact: true }).click();
await page.getByRole('button', { name: /^Add Blender/ }).waitFor({ timeout: 5000 });
check('removed: suggested again', true);
await page.click('.navi:has-text("Teams")');
await page.click('text=Design team');
await page.waitForTimeout(500);
check('the Design team lost the grant', (await page.locator('label', { hasText: blenderName }).count()) === 0);

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
const failed = checks.filter((ok) => !ok).length + errors.length;
console.log(failed ? `DRIVE APPS FAIL (${failed})` : 'DRIVE APPS PASS');
process.exit(failed ? 1 : 0);
