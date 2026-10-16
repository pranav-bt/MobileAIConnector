// Drives pair mode in a real browser (Edge) against a MOCK hub: the Pair
// toggle on the composer sends the next task in pair mode, its console shows
// the pair line (round, author ⇄ reviewer, state) and the reviewer's verdicts
// as verdicts (not raw JSON), the chair answers a question, and Settings >
// Models has the reviewer seat and a per-team "pair" box. Screenshots each
// step; fails on any page error.
//   HUB=ws://127.0.0.1:4651 UI=http://localhost:5174 SHOTS_DIR=… node tools/drive-pair.mjs
import { chromium } from 'playwright-core';

const HUB = process.env.HUB ?? 'ws://127.0.0.1:4651';
const UI = process.env.UI ?? 'http://localhost:5174';
const SHOTS = process.env.SHOTS_DIR ?? '.';
const errors = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
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

// 1. The Pair toggle: on for one task, off again after sending.
await page.fill('.composer input', '@consolproj coding: pair-disagree-once ui pair check');
await page.click('.pair-toggle');
check('toggle turns on', (await page.getAttribute('.pair-toggle', 'aria-pressed')) === 'true');
await page.screenshot({ path: `${SHOTS}/pair-toggle.png`, clip: { x: 0, y: 0, width: 1440, height: 70 } });
await page.press('.composer input', 'Enter');
await page.waitForTimeout(300);
check('toggle is one-shot', (await page.getAttribute('.pair-toggle', 'aria-pressed')) === 'false');

// 2. Its console: pair line, verdicts rendered, agreement after round 2.
await page.click('button:has-text("Tasks")');
await page.waitForSelector('.tcard:has-text("pair-disagree-once"):not(:has-text("[QA]"))', { timeout: 15000 });
await page.click('.tcard:has-text("pair-disagree-once"):not(:has-text("[QA]"))');
await page.click('button:has-text("Open console")');
await page.waitForSelector('.console-drawer >> text=/Pair · round 2\\/3/', { timeout: 20000 });
await page.waitForSelector('.console-drawer >> text=agreed', { timeout: 20000 });
await page.waitForSelector('.console-drawer >> text=/with the second opinion/', { timeout: 20000 }); // the lead's review row
await page.waitForTimeout(600);
const drawer = await page.innerText('.console-drawer');
check('pair line', /Pair · round 2\/3 · .+ ⇄ GPT-6\.1-Sol · agreed on [0-9a-f]{8}/.test(drawer), drawer.match(/Pair · [^\n]+/)?.[0] ?? '(none)');
check('verdicts shown as verdicts', drawer.includes('✗ Not yet') && drawer.includes('✓ Agrees') && !drawer.includes('"agree"'));
check('blocking issue listed', drawer.includes('the loader has no tests yet'));
await page.screenshot({ path: `${SHOTS}/pair-console.png` });

// 3. The chair answers a question (placeholder says so).
const placeholder = await page.getAttribute('.console-drawer textarea', 'placeholder');
check('chair placeholder', /Ask the chair/.test(placeholder ?? ''), placeholder ?? '');
await page.fill('.console-drawer textarea', 'did you both check it?');
await page.keyboard.press('Enter');
await page.waitForSelector('.console-drawer >> text=Mock chair: both models looked at it', { timeout: 20000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/pair-chair.png` });
check('chair answered', true);

// 4. Pair · split: the button's second click; the console shows the agreed
// plan (who builds what), the planner's reply as a plan, and links to parts.
await page.click('.console-drawer button:has-text("Close")');
await page.fill('.composer input', '@consolproj coding: pairsplit-basic ui split check');
await page.click('.pair-toggle');
await page.click('.pair-toggle');
check('second click = split', (await page.getAttribute('.pair-toggle', 'data-mode')) === 'split' && (await page.innerText('.pair-toggle')) === 'Pair · split');
await page.press('.composer input', 'Enter');
await page.waitForSelector('.tcard:has-text("pairsplit-basic"):not(:has-text("[QA]")):not(:has-text("[part"))', { timeout: 15000 });
await page.click('.tcard:has-text("pairsplit-basic"):not(:has-text("[QA]")):not(:has-text("[part"))');
await page.click('button:has-text("Open console")');
await page.waitForSelector('.console-drawer >> text=/plan agreed in 1 round/', { timeout: 30000 });
await page.waitForSelector('.console-drawer >> text=/with the second opinion/', { timeout: 30000 });
await page.waitForTimeout(600);
const splitText = await page.innerText('.console-drawer');
check('split pair line', /Pair · split · round 1\/3 · Sonnet 5 ⇄ GPT-6\.1-Sol/.test(splitText), splitText.match(/Pair · split[^\n]*/)?.[0] ?? '(none)');
check('plan line names the builders', /Module A — Sonnet 5 · Module B — GPT-6\.1-Sol/.test(splitText));
check('planner reply shown as a plan', splitText.includes('Proposed split — 2 parts') && splitText.includes('partner builds'));
const partLinks = await page.locator('.console-drawer >> text=open ›').count();
check('links to the parts', partLinks >= 2, `${partLinks} links`);
await page.screenshot({ path: `${SHOTS}/pair-split-console.png` });

// 5. Settings > Models: reviewer seat + per-team pair box (round-trips via the hub).
await page.click('.console-drawer button:has-text("Close")');
await page.click('button:has-text("Settings")');
await page.waitForSelector('text=All pair reviewers', { timeout: 10000 });
const box = page.locator('input[aria-label^="Cod"][aria-label$=": pair by default"]');
await box.click();
await page.waitForFunction(() => document.querySelector('input[aria-label$=": pair by default"]')?.checked === true, null, { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(800);
check('pair-by-default persists through the hub', await box.isChecked());
await page.locator('text=Pair mode per team').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/pair-models.png`, fullPage: true });
await box.click();
await page.waitForFunction(() => document.querySelector('input[aria-label$=": pair by default"]')?.checked === false, null, { timeout: 5000 }).catch(() => {});
check('pair-by-default clears', !(await box.isChecked()));
await page.waitForTimeout(500);

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
const failed = checks.filter((c) => !c.ok).length + errors.length;
console.log(failed ? 'PAIR UI FAIL' : 'PAIR UI PASS');
process.exit(failed ? 1 : 0);
