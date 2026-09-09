import { chromium } from 'playwright-core';

const dir = process.env.WORK_DIR ?? '.';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.goto(`file://${dir.replaceAll('\\', '/')}/icon.html`);
await page.screenshot({ path: `${dir}/app-icon.png`, omitBackground: true });
await browser.close();
console.log('icon written');
