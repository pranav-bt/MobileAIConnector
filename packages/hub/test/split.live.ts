import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

// LIVE validation of the lead split pass with real agents: a second hub on
// its own port (never the owner's hub on 4517) with a throwaway data dir and
// a throwaway git workspace. Checks: the split check runs on the checks model
// (haiku), the plan is 3-4 parts, the parts run concurrently, the parent's
// progress never regresses, and the integration worker commits a working
// result. Spends usage — run manually:
//   npx tsx test/split.live.ts [workspaceDir]   (from packages/hub)

const PORT = 4609; // smokes/live tests use 4601-4607
const CAP = 4;
const workspace = process.argv[2] ?? join('D:\\AI', `split-live-${Date.now().toString(36)}`);
mkdirSync(workspace, { recursive: true });
if (!existsSync(join(workspace, '.git'))) {
  writeFileSync(join(workspace, 'README.md'), '# split live test\n\nThrowaway workspace for the Agent HQ split-pass live test.\n');
  execSync('git init -q && git add -A && git commit -q -m "init"', { cwd: workspace });
}

const TASK =
  'coding: Build a dependency-free Node.js (ESM, Node 20+) text-analysis toolkit in this repo. It has four ' +
  'independent modules, each in its own directory with its own node:test file: src/wordcount/ (count words, ' +
  'lines and characters of a string), src/frequency/ (top-N most frequent words, case-insensitive, ignoring ' +
  'punctuation), src/readability/ (Flesch reading-ease score with a simple syllable heuristic), and src/format/ ' +
  '(render a results object as an aligned text table or as JSON). Then add cli.js that reads a file path from ' +
  'argv, runs all analyses and prints the table, plus an npm test script that runs every test with node --test. ' +
  'The four modules are independent of each other and can be built at the same time by separate workers.';

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  cwd: workspace,
  dataDir: mkdtempSync(join(tmpdir(), 'agent-hq-split-live-')),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-split-live-claude-')),
  workspaceRoots: [{ key: 'live', path: workspace, label: 'split live test' }],
});

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const problems: string[] = [];
let parentId: string | null = null;
let lastParentPct = -1;
let splitCount = 0;
let haikuAtSplit = 0;
let lastHaikuPct = 0;
const running = new Set<string>();
let maxConcurrentParts = 0;
const pieceTitles = new Map<string, string>();

async function finish(code: number, message: string): Promise<never> {
  clearTimeout(timer);
  console.log(`\n${message} after ${t()}`);
  ws.close();
  await hub.close();
  process.exit(code);
}

const timer = setTimeout(() => void finish(1, 'LIVE SPLIT TIMEOUT'), 30 * 60_000);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

ws.on('open', () => {
  ws.send(encodeCommand({ type: 'hello', client: 'cli', name: 'split-live' }));
  ws.send(encodeCommand({ type: 'team.update', teamId: 'coding', maxConcurrentWorkers: CAP }));
  setTimeout(() => {
    ws.send(encodeCommand({ type: 'task.submit', text: TASK }));
    console.log(`[${t()}] task submitted; workspace ${workspace}`);
  }, 500);
});

ws.on('message', (raw) => {
  const event: HubEvent | null = decodeEvent(raw.toString());
  if (!event) return;
  if (event.type === 'usage.updated') lastHaikuPct = event.usage.modelMixPct.haiku;
  // Cards: approve routine work in the throwaway repo; deny anything that
  // deletes, kills processes (the owner's hub is node too) or leaves the repo.
  if (event.type === 'permission.updated' && event.request.status === 'pending') {
    const risky = /rm\s+-r|rmdir|del\s|Remove-Item|taskkill|Stop-Process|kill\s|git\s+push|shutdown|\breg\s+(add|delete)|\bformat\s+[a-z]:/i.test(
      event.request.command,
    );
    const decision = risky ? 'deny' : 'approve';
    console.log(`[${t()}] card (${decision}): ${event.request.command.slice(0, 100)}`);
    ws.send(encodeCommand({ type: 'permission.respond', requestId: event.request.id, decision, scope: 'once' }));
  }
  if (event.type === 'activity' && /split|integrat|report filed|rejected/.test(event.entry.message)) {
    console.log(`[${t()}] [${event.entry.agentId}] ${event.entry.message.slice(0, 160)}`);
    const match = event.entry.message.match(/^split into (\d+) parallel parts/);
    if (match) {
      splitCount = Number(match[1]);
      haikuAtSplit = lastHaikuPct;
    }
  }
  if (event.type !== 'task.updated' || event.task.teamId !== 'coding') return;
  const task = event.task;
  if (!parentId && task.detail.startsWith('coding: Build a dependency-free')) parentId = task.id;
  if (/^\[(part|scaffold)/.test(task.title)) {
    if (!pieceTitles.has(task.id)) pieceTitles.set(task.id, task.title);
    const wasRunning = running.has(task.id);
    if (['in_flight', 'review', 'awaiting_permission'].includes(task.status)) running.add(task.id);
    else running.delete(task.id);
    if (!wasRunning && running.has(task.id)) console.log(`[${t()}] start ${task.title}`);
    if (wasRunning && !running.has(task.id)) console.log(`[${t()}] ${task.status} ${task.title}: ${(task.synopsis ?? '').slice(0, 140)}`);
    const parts = [...running].filter((id) => pieceTitles.get(id)?.startsWith('[part')).length;
    maxConcurrentParts = Math.max(maxConcurrentParts, parts);
  }
  if (task.id !== parentId) return;
  if (task.progressPct < lastParentPct) problems.push(`parent progress regressed ${lastParentPct}% -> ${task.progressPct}%`);
  lastParentPct = task.progressPct;
  if (task.status === 'failed' || task.status === 'paused') void finish(1, `LIVE SPLIT FAIL: parent ${task.status}: ${task.synopsis}`);
  if (task.status !== 'done') return;

  console.log(`[${t()}] parent done: ${task.synopsis}`);
  if (splitCount < 3) problems.push(`expected a 3-4 way split, got ${splitCount || 'no split'}`);
  if (haikuAtSplit <= 0) problems.push('no haiku usage recorded by the time of the split (split check not on haiku?)');
  if (maxConcurrentParts < Math.min(3, splitCount)) problems.push(`parts did not run concurrently (max ${maxConcurrentParts} at once)`);
  try {
    console.log(execSync('git log --oneline', { cwd: workspace }).toString().trim());
    console.log(execSync('git status --short', { cwd: workspace }).toString().trim() || '(clean tree)');
    const test = execSync('node --test', { cwd: workspace, stdio: 'pipe' }).toString();
    console.log(test.split('\n').filter((line) => /^(# |ℹ )(tests|pass|fail) /.test(line)).join('\n'));
  } catch (error) {
    problems.push(`workspace check failed: ${error instanceof Error ? error.message.slice(0, 300) : error}`);
  }
  void finish(problems.length ? 1 : 0, problems.length ? `LIVE SPLIT ISSUES:\n- ${problems.join('\n- ')}` : `LIVE SPLIT PASS: ${splitCount}-way split, ${maxConcurrentParts} parts at once`);
});
