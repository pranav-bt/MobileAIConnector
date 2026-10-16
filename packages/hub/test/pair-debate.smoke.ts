// Pair mode "debate" end to end against a mock hub: both models draft
// independently (read-only), then each round each reads the other's draft,
// critiques it and revises its own until one accepts the other's. The owner
// steers mid-debate (both sides hear it); the cap asks (pick a draft / two
// more rounds / None). Text work: the accepted draft is the report. Code:
// the author implements the agreed approach and the partner reviews it in
// its debate conversation.
//   npx tsx test/pair-debate.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type PermissionRequest, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['PAIR_DEBATE_SMOKE_PORT'] ?? 4647);
function fail(message: string): never {
  console.error(`PAIR DEBATE SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-debate-'));
const projectDir = join(sandbox, 'Debateproj');
mkdirSync(projectDir);
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-debate-claude-')),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const events: HubEvent[] = [];
const waiters: { test: (e: HubEvent) => boolean; resolve: (e: HubEvent) => void }[] = [];
ws.on('message', (raw) => {
  const event = decodeEvent(raw.toString());
  if (!event) return;
  events.push(event);
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
await new Promise<void>((resolve) => ws.on('open', () => resolve()));
const send = (command: ClientCommand) => ws.send(encodeCommand(command));
send({ type: 'hello', client: 'cli', name: 'pair-debate-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
await waitFor('snapshot', (e) => e.type === 'snapshot');

const taskOf = (taskId: string): Task | undefined =>
  ([...events].reverse().find((e) => e.type === 'task.updated' && e.task.id === taskId) as Extract<HubEvent, { type: 'task.updated' }> | undefined)?.task;
const created = async (marker: string) => {
  const e = await waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker) && !ev.task.parentTaskId);
  return e.type === 'task.updated' ? e.task.id : '';
};
const finished = (taskId: string, from: number, statuses = ['done', 'failed']) =>
  waitFor(`${taskId} → ${statuses.join('/')}`, (e) => e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status), 30000, from);
const card = async (prefix: string, from: number): Promise<PermissionRequest> => {
  const e = await waitFor(`card ${prefix}`, (ev) => ev.type === 'permission.updated' && ev.request.id.startsWith(prefix) && ev.request.status === 'pending', 30000, from);
  return (e as Extract<HubEvent, { type: 'permission.updated' }>).request;
};
const activities = (taskId: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'activity' && e.entry.taskId === taskId ? [e.entry.message] : []));
const rowsFor = (taskId: string) => {
  const rows = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) rows.set(entry.id, entry);
  return [...rows.values()];
};
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  send({ type: 'project.register', name: 'Debateproj', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'debateproj');

  // 1. Text work: both draft; the partner (Codex) accepts the author's draft
  // in the first exchange; that draft is the report — no writing run.
  let mark = events.length;
  send({ type: 'task.submit', text: '/pair debate @debateproj design: debate-codex-yields write the onboarding note' });
  const text = await created('debate-codex-yields');
  send({ type: 'task.watch', taskId: text });
  await finished(text, mark);
  await settle();
  let task = taskOf(text)!;
  if (task.detail.startsWith('debate ')) fail('the "debate" word stayed in the task');
  const debate = task.pair?.debate;
  if (task.pair?.mode !== 'debate' || !debate || debate.rounds !== 2 || debate.accepted !== 'author' || task.pair.state !== 'agreed') fail(`text debate: ${JSON.stringify(task.pair)}`);
  const drafts = activities(text, mark).filter((m) => m.startsWith('mock: debate draft'));
  if (!drafts.includes('mock: debate draft · engine claude') || !drafts.includes('mock: debate draft · engine codex')) fail(`both sides should draft: ${drafts.join(' | ')}`);
  if (!activities(text, mark).includes('mock: debate exchange · engine codex · resumed')) fail('the partner did not answer in its conversation');
  if (!activities(text, mark).some((m) => /debate converged in round 2: going with Sonnet 5's draft/.test(m))) fail('no convergence line');
  if (activities(text, mark).some((m) => /^mock: model /.test(m))) fail('text debate ran an extra writing run');
  if (!/Mock draft \(claude\)/.test(debate.drafts.author)) fail(`author draft not kept: ${debate.drafts.author}`);
  // the chair's synopsis folds in the debate note
  if (!/with the debate/.test(task.synopsis ?? '')) fail(`the chair's synopsis missed the debate: ${task.synopsis}`);
  const debaters = rowsFor(text).filter((r) => /-d\d+$/.test(r.agentId ?? ''));
  if (debaters.length < 4) fail(`expected both drafts + both exchanges in the console, got ${debaters.length}`);
  console.log('text debate ok: both drafted, Codex accepted Sonnet 5\'s draft, that draft is the report (no writing run)');

  // 2. The owner steers mid-debate: both sides hear it next round.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair debate @debateproj design: debate-slow debate-claude-yields write the release note' });
  const steer = await created('debate-slow');
  await waitFor('drafting', (e) => e.type === 'activity' && e.entry.taskId === steer && e.entry.message.startsWith('mock: debate draft'), 30000, mark);
  send({ type: 'task.message', taskId: steer, text: 'keep it under 100 words' });
  await finished(steer, mark);
  task = taskOf(steer)!;
  if (!activities(steer, mark).some((m) => /both sides hear you — keep it under 100 words/.test(m))) fail('the steer was not passed to both sides');
  if (!/heard: keep it under 100 words/.test(task.pair?.debate?.drafts.partner ?? '')) fail(`the winning draft did not take the steer: ${task.pair?.debate?.drafts.partner}`);
  if (task.pair?.debate?.accepted !== 'partner') fail(`expected the author to yield: ${task.pair?.debate?.accepted}`);
  console.log('steer ok: a message mid-debate reached both sides; the author yielded to the partner\'s draft');

  // 3. Code: they agree an approach, the author implements it, the partner
  // reviews the implementation in its debate conversation.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair debate @debateproj coding: debate-codex-yields fix the loader' });
  const code = await created('debate-codex-yields fix');
  await finished(code, mark);
  task = taskOf(code)!;
  if (!activities(code, mark).some((m) => /^mock: model claude-sonnet-5/.test(m))) fail('the author did not implement');
  if (!activities(code, mark).includes('mock: read-only review · engine codex · resumed')) fail('the partner did not review in its debate conversation');
  if ((task.pair?.rounds.length ?? 0) < 1 || task.pair?.state !== 'agreed') fail(`code review rounds: ${JSON.stringify(task.pair?.rounds)}`);
  console.log('code debate ok: approach agreed → author implemented → partner reviewed in its debate conversation');

  // 4. No convergence: the cap card (pick a draft / two more / None).
  mark = events.length;
  send({ type: 'task.submit', text: '/pair debate @debateproj design: debate-never pick check' });
  const never = await created('debate-never pick');
  let ask = await card(`pair-${never}-debate4`, mark);
  if (ask.options?.join('|') !== "Go with Sonnet 5's draft|Go with GPT-6.1-Sol's draft|Two more rounds") fail(`debate card options: ${ask.options?.join('|')}`);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 2 });
  ask = await card(`pair-${never}-debate6`, mark);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 1 });
  await finished(never, mark);
  task = taskOf(never)!;
  if (task.pair?.debate?.accepted !== 'partner' || task.pair.debate.rounds !== 6 || task.pair.state !== 'disagreed') fail(`picked draft: ${JSON.stringify(task.pair)}`);
  mark = events.length;
  send({ type: 'task.submit', text: '/pair debate @debateproj design: debate-never leave check' });
  const left = await created('debate-never leave');
  ask = await card(`pair-${left}-debate4`, mark);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'deny', scope: 'once' });
  await finished(left, mark, ['paused']);
  if (!/^Left for you: the two models didn't converge/.test(taskOf(left)?.synopsis ?? '')) fail('None did not leave it for the owner');
  console.log('debate cap ok: card at round 4 → two more → card at 6 → picked the partner\'s draft; None leaves it for you');

  // 5. Stop mid-debate: nothing implemented.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair debate @debateproj coding: debate-never stop check' });
  const stopped = await created('debate-never stop');
  ask = await card(`pair-${stopped}-debate4`, mark);
  send({ type: 'task.stop', taskId: stopped });
  await finished(stopped, mark, ['paused']);
  await settle();
  if (activities(stopped, mark).some((m) => /^mock: model /.test(m))) fail('a stopped debate implemented anyway');
  console.log('stop ok: stopped mid-debate, nothing implemented');

  console.log('PAIR DEBATE SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
