// LIVE pair mode on a real hub (own port, temp data, its own git project):
//   1. code — a Claude author (Sonnet) builds it, a Codex reviewer
//      (GPT-6.1-Sol) checks the actual result read-only, until it agrees;
//   2. the chair answers a question without re-running anything;
//   3. the chair hands a change to the author; the reviewer re-checks in
//      its SAME conversation;
//   4. a doc task (no shell team) gets a second opinion too;
//   5. engines reversed — a Codex author gets a Claude (Opus) reviewer.
//   npx tsx test/pair.live.ts        Spends usage on both plans.
//   npx tsx test/pair.live.ts --reverse-only   (just step 5)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, parseVerdict, type ClientCommand, type HubEvent, type PermissionRequest, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = 4634;
const reverseOnly = process.argv.includes('--reverse-only');
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-pair-live-'));
const projectDir = join(sandbox, 'Pairlive');
mkdirSync(projectDir);
const git = (...args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' });
git('init', '-q');
writeFileSync(join(projectDir, 'README.md'), '# pairlive\nA tiny stats module (CommonJS, no dependencies).\n');
git('add', '.');
git('-c', 'user.name=live', '-c', 'user.email=live@example.invalid', 'commit', '-qm', 'init');

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-pair-live-claude-')),
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
  // QA follow-ups are out of scope here: stop them as they appear.
  if (event.type === 'task.updated' && event.task.title.startsWith('[QA]') && ['queued', 'in_flight'].includes(event.task.status)) {
    send({ type: 'task.stop', taskId: event.task.id });
  }
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 900_000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const taskOf = (taskId: string): Task | undefined =>
  ([...events].reverse().find((e) => e.type === 'task.updated' && e.task.id === taskId) as Extract<HubEvent, { type: 'task.updated' }> | undefined)?.task;
const rows = (taskId: string) => {
  const byId = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) byId.set(entry.id, entry);
  return [...byId.values()];
};
const activities = (taskId: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'activity' && e.entry.taskId === taskId ? [e.entry.message] : []));
const submit = async (text: string, marker: string): Promise<string> => {
  const from = events.length;
  send({ type: 'task.submit', text });
  const e = await waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker), 120_000, from);
  const id = e.type === 'task.updated' ? e.task.id : '';
  send({ type: 'task.watch', taskId: id });
  return id;
};
// Waits for the task to finish; a pair card on the way is answered "Go with
// it as it is" (recorded — real models may legitimately disagree).
const finishPair = async (taskId: string, from: number): Promise<Task> => {
  for (;;) {
    const e = await waitFor(
      `${taskId} finished or asked`,
      (ev) =>
        (ev.type === 'task.updated' && ev.task.id === taskId && ['done', 'failed', 'paused'].includes(ev.task.status)) ||
        (ev.type === 'permission.updated' && ev.request.taskId === taskId && ev.request.status === 'pending'),
      900_000,
      from,
    );
    if (e.type === 'permission.updated') {
      const request: PermissionRequest = e.request;
      console.log(`      card: ${request.summary}`);
      from = events.length;
      if (request.id.startsWith('pair-')) send({ type: 'permission.respond', requestId: request.id, decision: 'approve', scope: 'once', choice: 0 });
      else send({ type: 'permission.respond', requestId: request.id, decision: 'approve', scope: 'once' });
      continue;
    }
    return taskOf(taskId)!;
  }
};
const node = (file: string) => {
  try {
    return { ok: true, out: execFileSync('node', [file], { cwd: projectDir, encoding: 'utf8', timeout: 30_000 }) };
  } catch (error) {
    return { ok: false, out: String((error as { stderr?: string }).stderr ?? error) };
  }
};
const reviewerRows = (taskId: string) => rows(taskId).filter((row) => /-r\d+$/.test(row.agentId ?? ''));
const describeRounds = (task: Task) =>
  (task.pair?.rounds ?? []).map((r) => `r${r.round}:${r.agree ? 'agree' : `blocking(${r.blocking.length})`}@${r.version}`).join(' ');

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'pair-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Pairlive', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'pairlive');

  let mark = events.length;
  let task: Task;
  let code = '';
  if (!reverseOnly) {
    // 1. Code: Claude author, Codex reviewer.
    code = await submit(
      '/pair @pairlive coding team: create stats.js in the project root exporting median(numbers) as CommonJS ' +
        '(module.exports = { median }). An empty array returns null; it must not reorder the caller\'s array. ' +
        'Add test.js with node:assert cases (odd, even, unsorted, empty, input not mutated) and run `node test.js`.',
      'exporting median',
    );
    task = await finishPair(code, mark);
    const reviewer = events.find((e) => e.type === 'agent.updated' && e.agent.taskId === code && /-r\d+$/.test(e.agent.id));
    const reviewerModel = reviewer?.type === 'agent.updated' ? reviewer.agent.modelId : undefined;
    record('code: Claude author, Codex reviewer', task.pair?.reviewerModel === 'gpt-6.1-sol' && reviewerModel === 'gpt-6.1-sol', `reviewer seat ${task.pair?.reviewerModel} / agent ${reviewerModel}`);
    const verdictRows = reviewerRows(code).filter((row) => row.kind === 'message' && parseVerdict(row.text));
    record('code: real verdicts parsed', (task.pair?.rounds.length ?? 0) >= 1 && verdictRows.length >= 1 && !task.pair!.rounds.some((r) => r.summary === 'no readable verdict'), describeRounds(task));
    record('code: reviewer wrote nothing', !reviewerRows(code).some((row) => row.kind === 'diff'), `${reviewerRows(code).filter((r) => r.kind === 'tool').length} reviewer tool rows, 0 edits`);
    const test1 = node('test.js');
    record('code: the work is real', task.status === 'done' && existsSync(join(projectDir, 'stats.js')) && test1.ok, `status ${task.status}; node test.js ${test1.ok ? 'passes' : `fails: ${test1.out.slice(0, 200)}`}`);
    record('code: outcome', ['agreed', 'disagreed'].includes(task.pair?.state ?? ''), `${task.pair?.state} after ${task.pair?.round} round(s); synopsis: ${(task.synopsis ?? '').slice(0, 160)}`);
    const firstReviewerSession = task.pair?.reviewerSession?.id;

    // 2. Chair answers a question — nothing re-runs.
    mark = events.length;
    send({ type: 'task.message', taskId: code, text: 'Which edge cases did the reviewer check?' });
    const answer = await waitFor('chair reply', (e) => e.type === 'task.transcript' && e.taskId === code && e.entries.some((r) => r.role === 'lead' && r.kind === 'message' && r.at > Date.now() - 300_000 && events.indexOf(e) >= mark), 300_000, mark);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const reran = events.slice(mark).some((e) => e.type === 'task.updated' && e.task.id === code && e.task.status === 'in_flight');
    const reply = answer.type === 'task.transcript' ? answer.entries.find((r) => r.role === 'lead')?.text ?? '' : '';
    record('chair: answers a question without a re-run', !reran && reply.length > 0, reply.slice(0, 200));

    // 3. Chair hands a change to the author; the reviewer re-checks in its own thread.
    mark = events.length;
    const roundsBefore = taskOf(code)?.pair?.rounds.length ?? 0;
    send({ type: 'task.message', taskId: code, text: 'Also add mean(numbers) to stats.js (null for an empty array) with tests, and run them.' });
    await waitFor('change re-runs', (e) => e.type === 'task.updated' && e.task.id === code && e.task.status === 'in_flight', 300_000, mark);
    task = await finishPair(code, events.length - 1);
    const test2 = node('test.js');
    let hasMean = false;
    try {
      hasMean = typeof (execFileSync('node', ['-e', 'console.log(typeof require("./stats.js").mean)'], { cwd: projectDir, encoding: 'utf8' }).trim() === 'function');
    } catch {
      hasMean = false;
    }
    record('chair: a change goes to the author', hasMean && test2.ok && activities(code, mark).some((m) => /handing it to the author/.test(m)), `mean ${hasMean ? 'exported' : 'missing'}; tests ${test2.ok ? 'pass' : 'fail'}`);
    record(
      'chair: reviewed again in the same reviewer thread',
      (task.pair?.rounds.length ?? 0) > roundsBefore && task.pair?.reviewerSession?.id === firstReviewerSession,
      `${describeRounds(task)}; reviewer thread ${firstReviewerSession === task.pair?.reviewerSession?.id ? 'kept' : `changed ${firstReviewerSession} → ${task.pair?.reviewerSession?.id}`}`,
    );

    // 4. A doc task gets a second opinion too.
    mark = events.length;
    const doc = await submit('/pair @general write a 5-item checklist for reviewing a pull request — one line each, plain text.', '5-item checklist');
    task = await finishPair(doc, mark);
    record('doc: second opinion on a text task', task.status === 'done' && (task.pair?.rounds.length ?? 0) >= 1 && !task.pair!.rounds.some((r) => r.summary === 'no readable verdict'), `${taskOf(doc)?.teamId}: ${describeRounds(task)} — ${task.pair?.state}`);

  }

  // 5. Engines reversed: a Codex author gets a Claude reviewer (Opus 5.5 by default).
  send({ type: 'models.set', overrides: { teams: { coding: { worker: { model: 'gpt-6.1-sol' } } } } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  mark = events.length;
  const reverse = await submit(
    '/pair @pairlive coding team: add range(numbers) to stats.js (max minus min; null for an empty array) with tests in test.js, and run them.',
    'add range(numbers)',
  );
  task = await finishPair(reverse, mark);
  const author = events.find((e) => e.type === 'agent.updated' && e.agent.taskId === reverse && /-w\d+$/.test(e.agent.id));
  const authorModel = author?.type === 'agent.updated' ? author.agent.modelId : undefined;
  const test3 = node('test.js');
  record(
    'reverse: Codex author, Claude reviewer',
    authorModel === 'gpt-6.1-sol' && task.pair?.reviewerModel === 'claude-opus-5-5' && test3.ok,
    `author ${authorModel}, reviewer ${task.pair?.reviewerModel}; ${describeRounds(task)} — ${task.pair?.state}; tests ${test3.ok ? 'pass' : 'fail'}`,
  );
  record('tokens counted', (reverseOnly || (taskOf(code)?.tokensUsed ?? 0) > 0) && (taskOf(reverse)?.tokensUsed ?? 0) > 0, `code ${code ? taskOf(code)?.tokensUsed : '-'} · reverse ${taskOf(reverse)?.tokensUsed}`);
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `PAIR LIVE PASS (${results.length} checks)` : `PAIR LIVE FAIL: ${failed.map((f) => f.check).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
