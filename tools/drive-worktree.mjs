// Drives the bots' worktree + Studio picker in a real browser (Edge) against
// a MOCK hub (test/ui-mock-hub.ts --worktree — temp git project, two fake
// Studio windows): the composer's Studio picker lists the open windows and
// sends the pick with the task; the task's work shows under Resources >
// Projects as "Bots' work" with its commit; Merge asks once more, then lands
// it and the section goes. Screenshots each step; fails on page errors.
//   (packages/hub) npx tsx test/ui-mock-hub.ts 4673 --worktree
//   HUB=ws://127.0.0.1:4673 UI=http://localhost:5173 SHOTS_DIR=… node tools/drive-worktree.mjs
import { chromium } from 'playwright-core';

const HUB = process.env.HUB ?? 'ws://127.0.0.1:4673';
const UI = process.env.UI ?? 'http://localhost:5173';
const SHOTS = process.env.SHOTS_DIR ?? '.';
const errors = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript((hub) => localStorage.setItem('hq.hubUrl', hub), HUB);
const page = await context.newPage();
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(UI);
await page.waitForSelector('text=Master office', { timeout: 20000 });

// 1. The Studio picker lists the open windows (refreshed on focus).
const picker = page.getByLabel('Roblox Studio for the next tasks');
await picker.focus();
await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Roblox Studio for the next tasks"] option').length === 3, null, { timeout: 10000 });
const options = await picker.locator('option').allTextContents();
check('the picker lists the open Studios', options.join('|') === 'Studio: none|Studio: Heat|Studio: Pranav2_Workspace', options.join('|'));
await picker.selectOption('Pranav2_Workspace');
await page.locator('.topbar').screenshot({ path: `${SHOTS}/worktree-1-picker.png` });

// 2. A task with the pick: its work lands in the bots' worktree.
await page.fill('.composer input', '@consolproj design: lines-done write-file:logo.svg draw a logo');
await page.keyboard.press('Enter');
await page.click('.navi:has-text("Resources")');
const section = page.locator('div', { hasText: /^Bots' work:/ }).first();
await page.waitForSelector("text=Bots' work:", { timeout: 30000 });
await page.waitForFunction(() => document.body.textContent.includes('1 commit ahead'), null, { timeout: 30000 });
const text = await page.locator('.tcard', { hasText: 'Projects' }).textContent();
check("the project shows the bots' branch", text.includes('agent-hq/main') && text.includes('1 commit ahead') && text.includes('1 file changed'), text.slice(0, 300));
check('the commit is listed', /agent-hq: .*draw a logo/.test(text));
await page.locator('.tcard', { hasText: 'Projects' }).screenshot({ path: `${SHOTS}/worktree-2-bots-work.png` });
void section;

// 3. Merge asks once more, then lands it; the section goes.
const merge = page.getByRole('button', { name: 'Merge', exact: true });
await merge.click();
check('Merge asks once more', (await page.getByRole('button', { name: 'Merge into main?' }).count()) === 1);
await page.getByRole('button', { name: 'Merge into main?' }).click();
await page.waitForFunction(() => !document.body.textContent.includes("Bots' work:"), null, { timeout: 30000 });
check("after merging, the bots' work section is gone", true);
await page.screenshot({ path: `${SHOTS}/worktree-3-merged.png`, fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(checks.every(Boolean) ? 'WORKTREE UI PASS' : 'WORKTREE UI FAIL');
process.exit(checks.every(Boolean) ? 0 : 1);
