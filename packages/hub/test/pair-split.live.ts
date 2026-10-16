// LIVE pair split on a real hub (own port, temp data, its own git project):
// a Claude author (the coding team's worker seat) and a Codex partner agree a
// plan, each builds part of it in parallel, each part is reviewed by the
// other model, the author integrates, and the partner reviews the whole.
//   npx tsx test/pair-split.live.ts      Spends usage on both plans.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { catalogModel, decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type PermissionRequest, type Task } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = 4636;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-pairsplit-live-'));
const projectDir = join(sandbox, 'Splitlive');
mkdirSync(projectDir);
const git = (...args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' });
git('init', '-q');
git('config', 'user.name', 'Agent HQ live test');
git('config', 'user.email', 'live@example.invalid');
writeFileSync(join(projectDir, 'README.md'), '# splitlive\nA tiny Node CLI (CommonJS, no dependencies, Node built-ins only).\n');
writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'splitlive', version: '0.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
git('add', '.');
git('commit', '-qm', 'init');

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-pairsplit-live-claude-')),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const events: HubEvent[] = [];
const waiters: { test: (e: HubEvent) => boolean; resolve: (e: HubEvent) => void }[] = [];
const send = (command: ClientCommand) => ws.send(encodeCommand(command));
ws.on('message', (raw) => {
  const event = decodeEvent(raw.toString());
  if (!event) return;
  events.push(event);
  if (event.type === 'task.updated' && event.task.title.startsWith('[QA]') && ['queued', 'in_flight'].includes(event.task.status)) {
    send({ type: 'task.stop', taskId: event.task.id });
  }
  if (event.type === 'activity' && /plan|split|part|round|second opinion/i.test(event.entry.message) && !event.entry.message.startsWith('mock')) {
    console.log(`      · ${event.entry.message.slice(0, 200)}`);
  }
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 2_400_000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const taskOf = (taskId: string): Task | undefined =>
  ([...events].reverse().find((e) => e.type === 'task.updated' && e.task.id === taskId) as Extract<HubEvent, { type: 'task.updated' }> | undefined)?.task;
const label = (id?: string) => (id ? catalogModel(id)?.label ?? id : '?');

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'pair-split-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Splitlive', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'splitlive');

  const started = Date.now();
  let mark = events.length;
  send({
    type: 'task.submit',
    text:
      '/pair split @splitlive coding team: build a small Node CLI in two independent modules, built in parallel. ' +
      'src/parse.js exports parseArgs(argv) returning { flags, positional } (supports --key=value, --flag, and -abc short flags). ' +
      'src/format.js exports formatTable(rows) returning a string with columns aligned and a header separator line. ' +
      'Each module gets its own tests under test/ (node:test + node:assert). Then cli.js wires them: `node cli.js a b --x=1 -v` prints ' +
      'a table of the positional args and flags. `npm test` must pass. Commit the work.',
  });
  const created = await waitFor('created', (e) => e.type === 'task.updated' && e.task.detail.includes('two independent modules') && !e.task.parentTaskId, 120_000, mark);
  const parentId = created.type === 'task.updated' ? created.task.id : '';
  // Answer any card on the way (pair cards: go with it; others: approve).
  for (;;) {
    const e = await waitFor(
      'finished or asked',
      (ev) =>
        (ev.type === 'task.updated' && ev.task.id === parentId && ['done', 'failed', 'paused'].includes(ev.task.status)) ||
        (ev.type === 'permission.updated' && ev.request.status === 'pending'),
      2_400_000,
      mark,
    );
    if (e.type !== 'permission.updated') break;
    const request: PermissionRequest = e.request;
    console.log(`      card: ${request.summary}`);
    mark = events.length;
    send({ type: 'permission.respond', requestId: request.id, decision: 'approve', scope: 'once', ...(request.options ? { choice: 0 } : {}) });
  }
  const task = taskOf(parentId)!;
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  const plan = task.pair?.plan;
  record('plan agreed by both models', task.pair?.mode === 'split' && !!plan && plan.parts.length >= 2, `${plan?.agreed ? 'agreed' : 'chosen'} in ${plan?.rounds} round(s): ${plan?.parts.map((p) => `${p.title} → ${p.builder}`).join(' · ')}`);
  const parts = (plan?.parts ?? []).map((part) => (part.taskId ? taskOf(part.taskId) : undefined)).filter((part): part is Task => !!part);
  const engines = new Set(parts.map((part) => catalogModel(part.seat?.model ?? '')?.engine));
  record('parts built on both engines', parts.length >= 2 && engines.has('claude') && engines.has('codex'), parts.map((part) => `${part.title}: ${label(part.seat?.model)}`).join(' · '));
  const crossed = parts.every((part) => {
    const builder = catalogModel(part.seat?.model ?? '')?.engine;
    const reviewer = catalogModel(part.pair?.reviewerModel ?? '')?.engine;
    return builder && reviewer && builder !== reviewer && (part.pair?.rounds.length ?? 0) >= 1;
  });
  record(
    'each part reviewed by the other model',
    crossed,
    parts.map((part) => `${part.title}: ${label(part.pair?.reviewerModel)} ${part.pair?.rounds.map((r) => (r.agree ? 'agree' : `blocking(${r.blocking.length})`)).join('→')}`).join(' · '),
  );
  record(
    'whole reviewed by the partner',
    (task.pair?.rounds.length ?? 0) >= 1 && catalogModel(task.pair?.reviewerModel ?? '')?.engine === 'codex',
    `${label(task.pair?.reviewerModel)}: ${task.pair?.rounds.map((r) => (r.agree ? `agree@${r.version}` : `blocking(${r.blocking.length})`)).join(' → ')} — ${task.pair?.state}`,
  );
  let testsPass = false;
  let testOut = '';
  try {
    testOut = execFileSync('npm', ['test'], { cwd: projectDir, encoding: 'utf8', shell: true, timeout: 120_000 });
    testsPass = true;
  } catch (error) {
    testOut = String((error as { stdout?: string }).stdout ?? error);
  }
  let cliOut = '';
  try {
    cliOut = execFileSync('node', ['cli.js', 'a', 'b', '--x=1', '-v'], { cwd: projectDir, encoding: 'utf8', timeout: 30_000 });
  } catch (error) {
    cliOut = `failed: ${String(error).slice(0, 200)}`;
  }
  const commits = git('log', '--oneline').trim().split('\n').length;
  record('the work is real', task.status === 'done' && testsPass && /a/.test(cliOut) && commits > 1, `status ${task.status}; npm test ${testsPass ? 'passes' : 'FAILS'}; ${commits} commits; cli → ${cliOut.trim().split('\n').slice(0, 4).join(' | ')}`);
  if (!testsPass) console.log(testOut.slice(-1500));
  record('tokens counted', task.tokensUsed > 0, `${task.tokensUsed} tokens on the parent (parts roll up) in ${minutes} min`);
  console.log(`      synopsis: ${(task.synopsis ?? '').slice(0, 400)}`);
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `PAIR SPLIT LIVE PASS (${results.length} checks)` : `PAIR SPLIT LIVE FAIL: ${failed.map((f) => f.check).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
