// Drives "one window per ask" + folder access in a real browser (Edge)
// against a MOCK hub: Settings > Hub edits the folders every worker may
// read / write; an ask that goes to QA, gets fixed in the same conversation
// and is re-checked shows as ONE card (steps folded in) and ONE console
// (the QA steps' rows in it). Screenshots each step; fails on page errors.
//   HUB=ws://127.0.0.1:4651 UI=http://localhost:5174 SHOTS_DIR=… node tools/drive-one-window.mjs
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const grantDir = join(tmpdir(), 'agent-hq-ui-grant');
mkdirSync(grantDir, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((hub) => localStorage.setItem('hq.hubUrl', hub), HUB);
const page = await context.newPage();
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(UI);
await page.waitForSelector('text=Master office', { timeout: 20000 });

// 1. Settings > Hub: folder access.
await page.click('.navi:has-text("Settings")');
await page.waitForSelector('text=Folder access for workers', { timeout: 10000 });
const defaultRow = await page.locator('select[aria-label^="Access for "]').count();
check('the scratch folder is open by default', defaultRow >= 1 && (await page.innerText('.main')).includes('\\Temp\\claude'));
await page.fill('input[aria-label="Folder to open to workers"]', grantDir);
await page.getByRole('button', { name: 'Add folder' }).click();
const added = page.getByLabel(`Access for ${grantDir}`, { exact: true });
await added.waitFor({ timeout: 5000 });
check('a folder was added (read & write)', (await added.inputValue()) === 'write');
await added.selectOption('read');
await page.waitForFunction((dir) => [...document.querySelectorAll('select')].find((el) => el.getAttribute('aria-label') === `Access for ${dir}`)?.value === 'read', grantDir, { timeout: 5000 });
check('its access changed to read only', (await added.inputValue()) === 'read');
await page.locator('text=Folder access for workers').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/folder-access.png` });
await page.getByRole('button', { name: `Remove ${grantDir}`, exact: true }).click();
await page.waitForFunction((dir) => ![...document.querySelectorAll('select')].some((el) => el.getAttribute('aria-label') === `Access for ${dir}`), grantDir, { timeout: 5000 });
check('removed again', (await added.count()) === 0);

// 2. An ask that goes through QA, a fix round in the same conversation, and a re-check.
await page.fill('.composer input', '@consolproj coding: remediate-me ui fold check');
await page.press('.composer input', 'Enter');
await page.click('.navi:has-text("Tasks")');
await page.waitForFunction(
  () => [...document.querySelectorAll('.today .tcard')].some((card) => card.textContent.includes('ui fold check') && /QA check ✓ · QA check ✓/.test(card.textContent)),
  null,
  { timeout: 40000 },
);
const todayCards = await page.$$eval('.today .tcard', (cards) => cards.map((card) => card.textContent ?? ''));
const askCards = todayCards.filter((text) => text.includes('ui fold check'));
check('one card for the ask on the right (no QA / fix cards)', askCards.length === 1 && !todayCards.some((text) => /\[QA\]|\[fix/.test(text)), askCards[0]?.replace(/\s+/g, ' ').slice(0, 120));
await page.locator('.today').screenshot({ path: `${SHOTS}/today-one-card.png` });
const taskRows = await page.$$eval('.main .tcard', (cards) => cards.map((card) => card.textContent ?? ''));
check('one row on the Tasks page', taskRows.filter((text) => text.includes('ui fold check')).length === 1 && !taskRows.some((text) => text.includes('[QA]')));

// 3. Its console: the QA steps' rows are in it, marked with the step.
await page.click('.today .tcard:has-text("ui fold check")');
await page.waitForSelector('.console-drawer >> text=/QA found issues — back to the .* worker in this same conversation/', { timeout: 20000 });
await page.waitForTimeout(800);
const drawer = await page.innerText('.console-drawer');
check('fix round in the same console', /fix round 1/.test(drawer));
check('QA rows marked with their step', /QA & Testing · QA check — Worker/.test(drawer) || /QA check — Worker/.test(drawer), drawer.match(/[^\n]*QA check — [^\n]*/)?.[0] ?? '(none)');
check('the fix came from the same worker', /fixed-after-qa/.test(drawer));
await page.screenshot({ path: `${SHOTS}/one-window-console.png` });

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
const failed = checks.filter((ok) => !ok).length + errors.length;
console.log(failed ? 'ONE WINDOW UI FAIL' : 'ONE WINDOW UI PASS');
process.exit(failed ? 1 : 0);
