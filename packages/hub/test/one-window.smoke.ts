// One window per ask + folder access, against a mock hub:
//   - the owner opens folders to every worker (read / read & write) from the
//     PC; bad grants are refused with a reason; write grants and the
//     project's own Claude Code folder join the worker's scope, read ones
//     don't; workers are told; the list persists;
//   - QA passes, fix rounds and handovers are STEPS of the ask: a fix round
//     continues the SAME task in its own conversation, steps carry the ask's
//     id, their rows land in the ask's console, a message to the ask reaches
//     the step that's working, and stopping the ask stops its steps;
//   - foldAsks shows the ask once, live with its working step, tokens summed.
//   npx tsx test/one-window.smoke.ts   (mock engine, no usage)
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, foldAsks, type ClientCommand, type HubEvent, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { isInside } from '../src/orchestrator/util.js';

const PORT = Number(process.env['ONE_WINDOW_SMOKE_PORT'] ?? 4653);
function fail(message: string): never {
  console.error(`ONE WINDOW SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-onewin-'));
const dataDir = join(sandbox, 'data');
const projectDir = join(sandbox, 'Onewin');
const writable = join(sandbox, 'Scratch');
const readable = join(sandbox, 'Reference');
for (const dir of [projectDir, writable, readable]) mkdirSync(dir, { recursive: true });
const claudeProjectsDir = mkdtempSync(join(tmpdir(), 'agent-hq-onewin-claude-'));
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir,
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir,
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
send({ type: 'hello', client: 'cli', name: 'one-window-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
await waitFor('snapshot', (e) => e.type === 'snapshot');

const tasks = (): Task[] => {
  const byId = new Map<string, Task>();
  for (const e of events) {
    if (e.type === 'snapshot') for (const task of e.snapshot.tasks) byId.set(task.id, task);
    if (e.type === 'task.updated') byId.set(e.task.id, e.task);
  }
  return [...byId.values()];
};
const taskOf = (taskId: string) => tasks().find((task) => task.id === taskId);
const created = async (marker: string) => {
  const e = await waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker) && !ev.task.rootTaskId);
  return e.type === 'task.updated' ? e.task.id : '';
};
const activities = (taskId: string | null, from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'activity' && (taskId === null || e.entry.taskId === taskId) ? [e.entry.message] : []));
const rowsFor = (taskId: string) => {
  const rows = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) rows.set(entry.id, entry);
  return [...rows.values()];
};
const stepsOf = (rootId: string) => tasks().filter((task) => task.rootTaskId === rootId);
const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  send({ type: 'project.register', name: 'Onewin', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'onewin');

  // A. Folder access.
  let mark = events.length;
  send({
    type: 'access.set',
    grants: [
      { path: writable, access: 'write' },
      { path: readable, access: 'read' },
      { path: 'C:\\', access: 'write' },
      { path: dataDir, access: 'write' },
      { path: 'relative\\folder', access: 'write' },
      { path: join(sandbox, 'does-not-exist'), access: 'read' },
    ],
  });
  const info = await waitFor('grants published', (e) => e.type === 'hub.updated' && (e.info.accessGrants?.length ?? 0) > 0, 10000, mark);
  const grants = info.type === 'hub.updated' ? info.info.accessGrants ?? [] : [];
  if (grants.map((grant) => `${grant.access}:${grant.path}`).join('|') !== `write:${writable}|read:${readable}`) fail(`grants kept: ${JSON.stringify(grants)}`);
  const refusals = activities(null, mark).filter((m) => m.startsWith('folder access: not added'));
  if (refusals.length !== 4) fail(`expected 4 refusals with reasons, got: ${refusals.join(' | ')}`);
  if (!refusals.some((m) => /whole drive is too broad/.test(m)) || !refusals.some((m) => /own data folder stays locked/.test(m))) fail(`refusal reasons: ${refusals.join(' | ')}`);
  const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { accessGrants?: unknown[] };
  if (saved.accessGrants?.length !== 2) fail('folder access was not saved to config.json');
  mark = events.length;
  send({ type: 'task.submit', text: '@onewin coding: access-check look around' });
  const accessTask = await created('access-check');
  await waitFor('access task done', (e) => e.type === 'task.updated' && e.task.id === accessTask && e.task.status === 'done', 30000, mark);
  const scope = activities(accessTask, mark).find((m) => m.startsWith('mock: workspace ')) ?? '';
  const extras = (scope.match(/· extra \[(.*)\]$/)?.[1] ?? '').split('|').filter(Boolean);
  if (!extras.includes(writable)) fail(`the write grant is not in the worker's scope: ${scope}`);
  if (extras.includes(readable)) fail('a read grant became writable');
  const claudeCode = extras.find((dir) => isInside(dir, claudeProjectsDir));
  if (!claudeCode || !existsSync(claudeCode) || !/Onewin$/.test(claudeCode)) fail(`the project's Claude Code folder is not in scope: ${scope}`);
  if (!activities(accessTask, mark).includes('mock: opened folders 2')) fail('the worker was not told which folders are open');
  console.log("access ok: read / read & write kept, 4 bad grants refused with reasons, saved; write grant + the project's Claude Code folder in scope, read grant not; worker told");

  // B1. A QA fix round continues the same task; both QA passes are steps of the ask.
  mark = events.length;
  send({ type: 'task.submit', text: '@onewin coding: remediate-me one-window check' });
  const ask = await created('remediate-me one-window');
  send({ type: 'task.watch', taskId: ask });
  await waitFor('re-QA passes', (e) => e.type === 'activity' && e.entry.message.startsWith('QA verdict: pass — remediate-me one-window'), 30000, mark);
  await settle();
  const qaSteps = stepsOf(ask).filter((task) => task.title.startsWith('[QA]'));
  if (qaSteps.length !== 2) fail(`expected 2 QA steps of the ask, got ${qaSteps.length}`);
  if (tasks().some((task) => /^\[fix\d*\]/.test(task.title))) fail('a separate [fix] task was created');
  if (taskOf(ask)?.status !== 'done') fail(`the ask should end done, is ${taskOf(ask)?.status}`);
  const askRows = rowsFor(ask);
  const mirrored = askRows.filter((row) => row.stepTaskId && qaSteps.some((step) => step.id === row.stepTaskId));
  if (mirrored.length < 4 || !mirrored.every((row) => row.id.startsWith(`${row.stepTaskId}~`))) fail(`QA rows not mirrored into the ask's console (${mirrored.length})`);
  if (!askRows.some((row) => row.kind === 'status' && /^QA found issues — back to the .+ worker in this same conversation \(fix round 1\)$/.test(row.text))) fail('no fix-round line in the ask\'s console');
  if (!askRows.some((row) => row.role === 'worker' && !row.stepTaskId && /fixed-after-qa/.test(row.text))) fail('the fix was not done by the ask\'s own worker');
  console.log('fix round ok: QA findings went back to the same task and conversation; both QA passes are steps; their rows are in the ask\'s console');

  // B2. A handover to another team is a step of the ask too.
  mark = events.length;
  send({ type: 'task.submit', text: '@onewin coding: handoff-test fold check' });
  const handAsk = await created('handoff-test fold');
  send({ type: 'task.watch', taskId: handAsk });
  const handStep = await waitFor('handover step', (e) => e.type === 'task.updated' && e.task.rootTaskId === handAsk && e.task.teamId === 'design', 30000, mark);
  const handStepId = handStep.type === 'task.updated' ? handStep.task.id : '';
  await waitFor('handover done', (e) => e.type === 'task.updated' && e.task.id === handStepId && e.task.status === 'done', 30000, mark);
  await settle();
  if (!rowsFor(handAsk).some((row) => row.stepTaskId === handStepId && row.role === 'worker')) fail("the handover's rows are not in the ask's console");
  console.log("handover ok: the design team's work is a step of the ask, in the same console");

  // B3. A message to the ask reaches the step that's working (QA here).
  mark = events.length;
  send({ type: 'task.submit', text: '@onewin coding: console-slow route check' });
  const routeAsk = await created('console-slow route');
  send({ type: 'task.watch', taskId: routeAsk });
  const qaWorking = await waitFor(
    'QA step working',
    (e) => e.type === 'agent.updated' && e.agent.role === 'worker' && e.agent.status === 'working' && !!e.agent.taskId && taskOf(e.agent.taskId)?.rootTaskId === routeAsk,
    30000,
    mark,
  );
  const routeStep = qaWorking.type === 'agent.updated' ? qaWorking.agent.taskId! : '';
  send({ type: 'task.message', taskId: routeAsk, text: 'ROUTED-NOTE check the edge case' });
  await waitFor('QA step done', (e) => e.type === 'task.updated' && e.task.id === routeStep && e.task.status === 'done', 30000, mark);
  await settle();
  const routeRows = rowsFor(routeAsk);
  if (!routeRows.some((row) => row.kind === 'status' && /^sent to the .+ worker \(QA check\)/.test(row.text))) fail('no "sent to the QA worker" line');
  if (!routeRows.some((row) => row.stepTaskId === routeStep && /heard: ROUTED-NOTE/.test(row.text))) fail('the working step did not get the message');
  console.log("routing ok: a message to the ask reached the QA step that was working, in the same console");

  // B4. Stopping the ask stops its working step.
  mark = events.length;
  send({ type: 'task.submit', text: '@onewin coding: console-slow stop check' });
  const stopAsk = await created('console-slow stop');
  const stopWorking = await waitFor(
    'stop: QA step working',
    (e) => e.type === 'agent.updated' && e.agent.role === 'worker' && e.agent.status === 'working' && !!e.agent.taskId && taskOf(e.agent.taskId)?.rootTaskId === stopAsk,
    30000,
    mark,
  );
  const stopStep = stopWorking.type === 'agent.updated' ? stopWorking.agent.taskId! : '';
  send({ type: 'task.stop', taskId: stopAsk });
  await waitFor('step stopped', (e) => e.type === 'task.updated' && e.task.id === stopStep && e.task.status === 'paused', 15000, mark);
  console.log('stop ok: stopping the ask stopped its working step');

  // C. The lists: one card per ask.
  const views = foldAsks(tasks());
  const askView = views.find((view) => view.id === ask)!;
  if (views.some((view) => view.rootTaskId && tasks().some((task) => task.id === view.rootTaskId))) fail('a step showed as its own card');
  if (askView.steps.length !== 2 || askView.tokensUsed !== [taskOf(ask)!, ...qaSteps].reduce((sum, task) => sum + task.tokensUsed, 0)) fail('the ask card does not sum its steps');
  const live = foldAsks([
    { ...taskOf(ask)!, status: 'done' },
    { ...qaSteps[0]!, status: 'in_flight', progressPct: 40 },
  ]);
  if (live.length !== 1 || live[0]!.status !== 'in_flight' || live[0]!.current?.id !== qaSteps[0]!.id || live[0]!.progressPct !== 40) fail(`a done ask with a working step should read as live: ${JSON.stringify(live[0]?.status)}`);
  console.log('lists ok: steps fold into their ask — one card, live with the working step, tokens summed');

  console.log('ONE WINDOW SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
