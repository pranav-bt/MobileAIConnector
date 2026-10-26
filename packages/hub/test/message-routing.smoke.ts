// Messages typed in a task's window, against a mock hub: the master checks
// who each one is for. Follow-ups stay with whoever is on the work (same
// conversation); another team's NEW work becomes a step of the ask on that
// team — same window, same project, carrying the thread; a message while a
// step of another team works can still go to the thread's own team; unclear
// work asks which team (keep / pick / hold); a failed check or a short nudge
// delivers as before; one task's messages stay in order.
//   npx tsx test/message-routing.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type PermissionRequest, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['MESSAGE_ROUTING_SMOKE_PORT'] ?? 4659);
function fail(message: string): never {
  console.error(`MESSAGE ROUTING SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-msgroute-'));
const projectDir = join(sandbox, 'Routeproj');
mkdirSync(projectDir, { recursive: true });
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-msgroute-claude-')),
  accessGrants: [],
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
send({ type: 'hello', client: 'cli', name: 'message-routing-smoke' });
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
const rowsFor = (taskId: string) => {
  const rows = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) rows.set(entry.id, entry);
  return [...rows.values()];
};
const activities = (taskId: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'activity' && e.entry.taskId === taskId ? [e.entry.message] : []));
const newSteps = (rootId: string, from: number, teamId?: string) => [
  ...new Set(events.slice(from).flatMap((e) => (e.type === 'task.updated' && e.task.rootTaskId === rootId && (!teamId || e.task.teamId === teamId) ? [e.task.id] : []))),
];
const done = (taskId: string, from: number) =>
  waitFor(`${taskId} done`, (e) => e.type === 'task.updated' && e.task.id === taskId && e.task.status === 'done', 30000, from);
const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));
const submit = async (text: string, marker: string) => {
  const mark = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`created ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && !e.task.rootTaskId, 30000, mark);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  return id;
};

try {
  send({ type: 'project.register', name: 'Routeproj', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'routeproj');

  // A finished coding task (its QA pass done too).
  let mark = events.length;
  const ask = await submit('@routeproj coding: build the shop screen with prices', 'build the shop screen');
  await waitFor('QA done', (e) => e.type === 'activity' && e.entry.message.startsWith('QA verdict: pass — build the shop screen'), 30000, mark);
  await settle();

  // 1. Another team's new work → a step of the ask on that team, carrying the thread.
  mark = events.length;
  send({ type: 'task.message', taskId: ask, text: 'design-request: now make icons for every shop item' });
  const designStep = await waitFor('design step', (e) => e.type === 'task.updated' && e.task.rootTaskId === ask && e.task.teamId === 'design', 30000, mark);
  const step = designStep.type === 'task.updated' ? designStep.task : null;
  if (!step || step.projectId !== 'routeproj') fail(`the design step should be in the same project: ${step?.projectId}`);
  if (!/^Do what the owner asked: design-request: now make icons/.test(step.detail) || !/The thread so far — the owner's first ask: @?routeproj coding: build the shop screen|The thread so far — the owner's first ask: .*build the shop screen/.test(step.detail) || !/Latest report: /.test(step.detail)) {
    fail(`the step doesn't carry the thread: ${step.detail.slice(0, 300)}`);
  }
  await done(step.id, mark);
  await settle();
  const rows = rowsFor(ask);
  if (!rows.some((row) => row.kind === 'status' && row.linkTaskId === step.id && /^your message went to the Design team: /.test(row.text))) fail('no "your message went to the Design team" line in the ask\'s window');
  if (!rows.some((row) => row.stepTaskId === step.id && row.role === 'worker')) fail("the design step's work isn't in the ask's window");
  if (activities(ask, mark).some((m) => m.startsWith('mock: resumed'))) fail('the coding worker picked up a design request');
  console.log('another team ok: an art/design request became a Design step of the ask — same window, same project, with the thread');

  // 2. A follow-up for the same work stays with the coding worker, same conversation.
  mark = events.length;
  send({ type: 'task.message', taskId: ask, text: 'recall-test what did you build for the shop?' });
  await waitFor('resumed', (e) => e.type === 'activity' && e.entry.taskId === ask && e.entry.message.startsWith('mock: resumed'), 30000, mark);
  if (newSteps(ask, mark).some((id) => taskOf(id)?.teamId !== 'qa')) fail('a same-work follow-up spawned another team');
  await done(ask, mark);
  console.log('same work ok: a follow-up stayed with the coding worker in its own conversation');

  // 3. While a QA step works: QA-flavoured notes reach QA; the thread's own
  // team gets its own work; another team's work goes to that team.
  mark = events.length;
  const slow = await submit('@routeproj coding: console-slow cart total', 'console-slow cart');
  const qaWorking = await waitFor(
    'QA step working',
    (e) => e.type === 'agent.updated' && e.agent.role === 'worker' && e.agent.status === 'working' && !!e.agent.taskId && taskOf(e.agent.taskId)?.rootTaskId === slow,
    30000,
    mark,
  );
  const qaStep = qaWorking.type === 'agent.updated' ? qaWorking.agent.taskId! : '';
  const during = events.length;
  send({ type: 'task.message', taskId: slow, text: 'coding-request: also round the cart total to cents' });
  send({ type: 'task.message', taskId: slow, text: 'tools-request: set up a price export script' });
  await waitFor('tools step', (e) => e.type === 'task.updated' && e.task.rootTaskId === slow && e.task.teamId === 'tools', 30000, during);
  await waitFor('cart continued', (e) => e.type === 'activity' && e.entry.taskId === slow && e.entry.message.startsWith('mock: resumed'), 30000, during);
  await done(qaStep, during);
  await settle();
  const qaSaid = rowsFor(slow).filter((row) => row.stepTaskId === qaStep && row.role === 'worker').map((row) => row.text).join(' ');
  if (/heard: (coding|tools)-request/.test(qaSaid)) fail(`the QA worker got a message meant for another team: ${qaSaid.slice(0, 200)}`);
  console.log("while QA works ok: the thread's own team took its follow-up, a tools request went to Tools, QA wasn't interrupted");

  // 4. Unclear: a "which team?" card — keep / pick / hold.
  mark = events.length;
  send({ type: 'task.message', taskId: ask, text: 'unclear-request: add something for the launch' });
  let card = (await waitFor('which-team card', (e) => e.type === 'permission.updated' && e.request.id.startsWith(`msg-${ask}`) && e.request.status === 'pending', 30000, mark)) as Extract<HubEvent, { type: 'permission.updated' }>;
  let request: PermissionRequest = card.request;
  if (request.options?.[0] !== 'Coding team (keep it here)' || (request.options?.length ?? 0) < 2) fail(`card options: ${request.options?.join('|')}`);
  if (taskOf(ask)?.status !== 'done') fail('asking about a finished task changed its status');
  const pickedName = request.options![1]!;
  send({ type: 'permission.respond', requestId: request.id, decision: 'approve', scope: 'once', choice: 1 });
  const picked = await waitFor('picked team step', (e) => e.type === 'task.updated' && e.task.rootTaskId === ask && e.task.detail.startsWith('unclear-request'), 30000, mark);
  if (picked.type !== 'task.updated' || (picked.task.teamId && !pickedName.toLowerCase().startsWith(picked.task.teamId))) fail(`the step didn't go to the picked team (${pickedName}): ${picked.type === 'task.updated' ? picked.task.teamId : ''}`);
  mark = events.length;
  send({ type: 'task.message', taskId: ask, text: 'unclear-request: and a banner for the store page' });
  card = (await waitFor('second card', (e) => e.type === 'permission.updated' && e.request.id.startsWith(`msg-${ask}`) && e.request.status === 'pending', 30000, mark)) as Extract<HubEvent, { type: 'permission.updated' }>;
  request = card.request;
  send({ type: 'permission.respond', requestId: request.id, decision: 'deny', scope: 'once' });
  await waitFor('held', (e) => e.type === 'task.transcript' && e.taskId === ask && e.entries.some((row) => row.text.startsWith('not sent anywhere')), 30000, mark);
  await settle();
  if (newSteps(ask, mark).length || activities(ask, mark).some((m) => m.startsWith('mock: resumed'))) fail('a held message was sent somewhere');
  console.log('unclear ok: a "which team?" card — picking a team starts a step there; None holds the message');

  // 5. A failed check and a short nudge deliver as before.
  mark = events.length;
  send({ type: 'task.message', taskId: ask, text: 'classify-fail recall-test still remember the shop?' });
  await waitFor('fallback resumed', (e) => e.type === 'activity' && e.entry.taskId === ask && e.entry.message.startsWith('mock: resumed'), 30000, mark);
  await done(ask, mark);
  mark = events.length;
  send({ type: 'task.message', taskId: ask, text: 'design-request thanks' });
  await waitFor('nudge resumed', (e) => e.type === 'activity' && e.entry.taskId === ask && e.entry.message.startsWith('mock: resumed'), 30000, mark);
  if (newSteps(ask, mark, 'design').length) fail('a short nudge went through the check');
  console.log('fallbacks ok: a failed check and a short nudge still reach the worker');

  console.log('MESSAGE ROUTING SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
