// Checks the Task Console pop-out INSIDE the Tauri shell: launches a
// separate instance of the debug build with WebView2 remote debugging on a
// local port, opens a finished task's console from History, pops it out,
// and confirms a second native window (label console-*) shows that console.
// Closes the instance afterwards. Needs the hub (4517) + UI (5173) running.
//   SHOTS_DIR=… node tools/drive-tauri-console.mjs
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const EXE = join(process.cwd(), 'packages', 'desktop', 'src-tauri', 'target', 'debug', 'agent-hq-desktop.exe');
const SHOTS = process.env.SHOTS_DIR ?? '.';
const PORT = 9333;
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});
const stop = () => {
  try {
    process.kill(app.pid);
  } catch {
    /* already gone */
  }
};

let failed = '';
try {
  let browser = null;
  for (let attempt = 0; attempt < 40 && !browser; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
  }
  if (!browser) throw new Error('could not attach to the Tauri webview');
  const pages = () => browser.contexts().flatMap((context) => context.pages());
  let main = null;
  for (let attempt = 0; attempt < 40 && !main; attempt++) {
    main = pages().find((page) => page.url().startsWith('http://localhost:5173') && !page.url().includes('console='));
    if (!main) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!main) throw new Error('main window page not found');
  await main.waitForSelector('text=Master office', { timeout: 20000 });
  await main.click('button:has-text("History")');
  await main.waitForSelector('text=History ·', { timeout: 10000 });
  await main.click('.tcard >> nth=0');
  await main.waitForSelector('.console-drawer', { timeout: 10000 });
  await main.click('.console-drawer button:has-text("Pop out")');
  let popped = null;
  for (let attempt = 0; attempt < 30 && !popped; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    popped = pages().find((page) => page.url().includes('console='));
  }
  if (!popped) throw new Error('no console window appeared');
  await popped.waitForSelector('.console', { timeout: 15000 });
  await popped.screenshot({ path: `${SHOTS}/tauri-console-window.png` });
  const drawerClosed = (await main.$('.console-drawer')) === null;
  console.log(`tauri pop-out ok: window ${popped.url().split('?')[1]} · drawer closed ${drawerClosed}`);
  if (!drawerClosed) failed = 'drawer stayed open';
  await browser.close().catch(() => undefined);
} catch (error) {
  failed = error instanceof Error ? error.message : String(error);
} finally {
  stop();
}
console.log(failed ? `TAURI CONSOLE FAIL: ${failed}` : 'TAURI CONSOLE PASS');
process.exit(failed ? 1 : 0);
