// LIVE pair debate on a real hub (own port, temp data, its own git project):
//   1. text — a Claude author and a Codex partner each draft a checklist,
//      critique each other's and converge; the owner steers mid-debate;
//      the accepted draft is the report;
//   2. code — they debate how to fix a real bug, converge on an approach,
//      the author implements it, the partner reviews it in its debate
//      conversation, and the tests pass.
//   npx tsx test/pair-debate.live.ts      Spends usage on both plans.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { catalogModel, decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type PermissionRequest, type Task } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = 4638;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-debate-live-'));
const projectDir = join(sandbox, 'Debatelive');
mkdirSync(projectDir);
const git = (...args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' });
git('init', '-q');
git('config', 'user.name', 'Agent HQ live test');
git('config', 'user.email', 'live@example.invalid');
writeFileSync(
  join(projectDir, 'stats.js'),
  '// Returns the median of a list of numbers.\nfunction median(numbers) {\n  numbers.sort();\n  return numbers[Math.floor(numbers.length / 2)];\n}\nmodule.exports = { median };\n',
);
writeFileSync(join(projectDir, 'README.md'), '# debatelive\nA tiny stats module (CommonJS, no dependencies).\n');
git('add', '.');
git('commit', '-qm', 'init');

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-debate-live-claude-')),
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
  if (event.type === 'activity' && /debate|round|second opinion|agrees|blocking/i.test(event.entry.message)) console.log(`      · ${event.entry.message.slice(0, 220)}`);
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 1_800_000, from = 0): Promise<HubEvent> => {
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
const submit = async (text: string, marker: string): Promise<string> => {
  const from = events.length;
  send({ type: 'task.submit', text });
  const e = await waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker) && !ev.task.parentTaskId, 120_000, from);
  return e.type === 'task.updated' ? e.task.id : '';
};
const finish = async (taskId: string, from: number): Promise<Task> => {
  for (;;) {
    const e = await waitFor(
      `${taskId} finished or asked`,
      (ev) =>
        (ev.type === 'task.updated' && ev.task.id === taskId && ['done', 'failed', 'paused'].includes(ev.task.status)) ||
        (ev.type === 'permission.updated' && ev.request.taskId === taskId && ev.request.status === 'pending'),
      1_800_000,
      from,
    );
    if (e.type !== 'permission.updated') return taskOf(taskId)!;
    const request: PermissionRequest = e.request;
    console.log(`      card: ${request.summary}`);
    from = events.length;
    send({ type: 'permission.respond', requestId: request.id, decision: 'approve', scope: 'once', ...(request.options ? { choice: 0 } : {}) });
  }
};

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'pair-debate-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Debatelive', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'debatelive');

  // 1. Text debate, steered mid-debate.
  let mark = events.length;
  const text = await submit(
    '/pair debate @debatelive design team: write a short checklist (one line per item) for safely rotating an API key used by a production web service. Plain text only.',
    'rotating an API key',
  );
  await waitFor('drafting', (e) => e.type === 'activity' && e.entry.taskId === text && /debate round 1/.test(e.entry.message), 300_000, mark);
  send({ type: 'task.message', taskId: text, text: 'Exactly 6 items, and make revoking the old key the very last step.' });
  let task = await finish(text, mark);
  const debate = task.pair?.debate;
  const authorEngine = catalogModel(task.pair?.authorModel ?? '')?.engine;
  const partnerEngine = catalogModel(task.pair?.reviewerModel ?? '')?.engine;
  record('text: Claude and Codex debated', task.pair?.mode === 'debate' && authorEngine === 'claude' && partnerEngine === 'codex', `${label(task.pair?.authorModel)} vs ${label(task.pair?.reviewerModel)}`);
  record(
    'text: real exchanges parsed',
    !!debate && debate.rounds >= 2 && !!debate.last && !!debate.drafts.author && !!debate.drafts.partner,
    `${debate?.rounds} rounds; last: author ${debate?.last?.authorAccepts ? 'accepts' : 'objects'}, partner ${debate?.last?.partnerAccepts ? 'accepts' : 'objects'}; went with ${debate?.accepted}`,
  );
  const steered = events.slice(mark).some((e) => e.type === 'activity' && e.entry.taskId === text && /both sides hear you/.test(e.entry.message));
  const finalDraft = debate?.accepted === 'partner' ? debate.drafts.partner : debate?.drafts.author ?? '';
  // One line per item (as asked), with or without a bullet/number; headings
  // and blank lines don't count.
  const items = finalDraft.split('\n').filter((line) => line.trim() && !/^\s*#/.test(line) && !/:\s*$/.test(line));
  const lastItem = items.at(-1) ?? '';
  record('text: the steer reached both sides', steered, `${items.length} items; last: ${lastItem.trim().slice(0, 100)}`);
  record('text: the steer was followed', items.length === 6 && /revok/i.test(lastItem), `${items.length} items, revoke last: ${/revok/i.test(lastItem)}`);
  record('text: the accepted draft is the report', task.status === 'done' && !!task.synopsis, (task.synopsis ?? '').slice(0, 200));

  // 2. Code debate: converge on the fix, implement, review, tests pass.
  mark = events.length;
  const code = await submit(
    '/pair debate @debatelive coding team: median() in stats.js is wrong — it sorts numbers as strings, ignores even-length arrays, ' +
      "mutates the caller's array, and has no answer for an empty one. Agree how to fix it (empty → null), then fix it, add test.js " +
      '(node:assert) covering those cases, run `node test.js`, and commit.',
    'median() in stats.js is wrong',
  );
  task = await finish(code, mark);
  let testsPass = false;
  try {
    execFileSync('node', ['test.js'], { cwd: projectDir, encoding: 'utf8', timeout: 30_000 });
    testsPass = true;
  } catch {
    testsPass = false;
  }
  const commits = git('log', '--oneline').trim().split('\n').length;
  record('code: converged on an approach', !!task.pair?.debate?.accepted, `${task.pair?.debate?.rounds} rounds, went with ${task.pair?.debate?.accepted}`);
  record(
    'code: implemented and reviewed by the partner',
    task.status === 'done' && (task.pair?.rounds.length ?? 0) >= 1 && catalogModel(task.pair?.reviewerModel ?? '')?.engine === 'codex',
    `${label(task.pair?.reviewerModel)}: ${task.pair?.rounds.map((r) => (r.agree ? `agree@${r.version}` : `blocking(${r.blocking.length})`)).join(' → ')}`,
  );
  record('code: the fix is real', testsPass && commits > 1, `node test.js ${testsPass ? 'passes' : 'FAILS'}; ${commits} commits`);
  console.log(`      synopsis: ${(task.synopsis ?? '').slice(0, 300)}`);
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `PAIR DEBATE LIVE PASS (${results.length} checks)` : `PAIR DEBATE LIVE FAIL: ${failed.map((f) => f.check).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
