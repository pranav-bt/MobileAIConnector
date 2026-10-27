// Drives the Teams page's "Team notes" card in a real browser (Edge) against
// a MOCK hub (test/ui-mock-hub.ts — temp data): seeded notes show newest
// first with their dates, × removes one, "Edit as text" opens MEMORY.md and
// a save updates the list. Screenshots each step; fails on page errors.
//   HUB=ws://127.0.0.1:4665 UI=http://localhost:5173 SHOTS_DIR=… node tools/drive-team-notes.mjs
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const HUB = process.env.HUB ?? 'ws://127.0.0.1:4665';
const UI = process.env.UI ?? 'http://localhost:5173';
const SHOTS = process.env.SHOTS_DIR ?? '.';
const errors = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Seed the Design team's notes over the hub's own command.
const seeded = [
  '# Design team — notes',
  'Name the Figma file you exported from.',
  '- 2026-10-20: SVG icons from the generator come out 1px off-grid → snap to whole pixels before export',
  '- 2026-10-24: ImageMagick needs -background none or PNG transparency turns white',
  '- 2026-10-26: Blender -b render came out black with no camera → add a temporary camera and light first',
].join('\n');
await new Promise((resolve, reject) => {
  const ws = new WebSocket(HUB);
  ws.on('error', reject);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', client: 'cli', name: 'drive-team-notes' }));
    ws.send(JSON.stringify({ type: 'team.notes.set', teamId: 'design', markdown: seeded }));
    setTimeout(() => (ws.close(), resolve()), 500);
  });
});

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript((hub) => localStorage.setItem('hq.hubUrl', hub), HUB);
const page = await context.newPage();
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(UI);
await page.waitForSelector('text=Master office', { timeout: 20000 });

// 1. Teams > Design team: the notes, newest first, dated.
await page.click('.navi:has-text("Teams")');
await page.click('text=Design team');
await page.waitForSelector('text=Team notes', { timeout: 10000 });
const card = page.locator('.tcard', { hasText: 'Team notes' });
check('the card counts the notes', (await card.textContent()).includes('3 notes'));
const firstNote = await card.locator('div[style*="overflow-y"] > div').first().textContent();
check('newest first, with its date', firstNote.startsWith('2026-10-26') && firstNote.includes('Blender -b render'), firstNote.slice(0, 60));
await card.screenshot({ path: `${SHOTS}/notes-1-card.png` });

// 2. × removes one.
await card.getByTitle('Remove this note').nth(1).click();
await page.waitForFunction(() => [...document.querySelectorAll('.tcard')].some((el) => el.textContent.includes('Team notes') && el.textContent.includes('2 notes')), null, { timeout: 5000 });
check('× removed the note', !(await card.textContent()).includes('ImageMagick needs'));

// 3. Edit as text: MEMORY.md opens with the file; a saved edit shows in the list.
await card.getByRole('button', { name: 'Edit as text' }).click();
const editor = page.locator('.tcard', { hasText: 'MEMORY.md' });
const text = await editor.locator('textarea').inputValue();
check('the editor holds the file, owner line included', text.includes('Name the Figma file') && text.includes('Blender -b render'));
await editor.locator('textarea').fill(`${text.trimEnd()}\n- 2026-10-26: Export logos at 2x and let the app downscale`);
await editor.getByRole('button', { name: 'Save' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.tcard')].some((el) => el.textContent.includes('Team notes') && el.textContent.includes('3 notes')), null, { timeout: 5000 });
check('the saved edit shows in the list', (await card.textContent()).includes('Export logos at 2x'));
await page.screenshot({ path: `${SHOTS}/notes-2-page.png`, fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(checks.every(Boolean) ? 'TEAM NOTES UI PASS' : 'TEAM NOTES UI FAIL');
process.exit(checks.every(Boolean) ? 0 : 1);
