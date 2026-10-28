// One ask, one thread: every team on an ask has its Studio and its story.
//  - the Studio picked for an ask survives the master turning it into a plan,
//    reaches every step, and becomes the project's (later asks there use it);
//    the task's window can change it, and so can a message naming an open
//    window as the Studio
//  - a plan that halts on a stuck step keeps its later steps waiting (not
//    dropped): "start those steps" in the ask's window runs them in order,
//    as steps of the same ask, each brief carrying the thread — the owner's
//    ask and messages, the other steps' reports, what the plan still has
//    for other teams
//   npx tsx test/ask-thread.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type Project, type Task } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['ASK_THREAD_SMOKE_PORT'] ?? 4675);
function fail(message: string): never {
  console.error(`ASK THREAD SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-ask-thread-'));
const workRoot = join(sandbox, 'Work');
const proj = join(workRoot, 'Game');
mkdirSync(proj, { recursive: true });
const studios = [
  { id: 's-owner', name: 'Heat (placeId: 1)' },
  { id: 's-bot', name: 'Pranav2_Workspace (placeId: 2)' },
];
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-ask-thread-claude-')),
  claudeConfigPath: join(sandbox, 'claude.json'),
  accessGrants: [],
  workspaceRoots: [{ key: 'work', path: workRoot, label: 'work' }],
  detectApps: () => [],
  studios: async () => studios,
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
send({ type: 'hello', client: 'cli', name: 'ask-thread-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const activitySince = (from: number) => events.slice(from).flatMap((e) => (e.type === 'activity' ? [e.entry.message] : []));
const taskNow = (id: string): Task | undefined => events.flatMap((e) => (e.type === 'task.updated' && e.task.id === id ? [e.task] : [])).at(-1);
const tasksNow = (): Task[] => [...new Map(events.flatMap((e) => (e.type === 'task.updated' ? [[e.task.id, e.task] as const] : []))).values()];
const projectNow = (): Project | undefined =>
  events.flatMap((e) => (e.type === 'project.updated' && e.project.workspaceDir === proj ? [e.project] : [])).at(-1);
const rows = (taskId: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'task.transcript' && e.taskId === taskId ? e.entries : []));
async function submit(text: string): Promise<{ id: string; from: number }> {
  const from = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`task: ${text}`, (e) => e.type === 'task.updated' && !!e.task.ownerAsk && text.includes(e.task.ownerAsk.slice(0, 20)), 30000, from);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  return { id, from };
}
const finished = (taskId: string, from: number) =>
  waitFor(`finished ${taskId}`, (e) => e.type === 'task.updated' && e.task.id === taskId && ['done', 'failed', 'paused'].includes(e.task.status), 30000, from);
const stepOf = (rootId: string, title: RegExp) => tasksNow().find((task) => task.rootTaskId === rootId && title.test(task.title));

try {
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Game', workspaceDir: proj });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === proj);
  send({ type: 'studios.list' });
  await waitFor('studios', (e) => e.type === 'hub.updated' && (e.info.studios ?? []).length === 2);

  // 1. A plan ask with a Studio: step 1 (the ask itself) keeps it, and gets stuck.
  const plan = await submit('@game multi-step plan-stuck studio:Pranav2_Workspace build the arena');
  await waitFor('halted', (e) => e.type === 'activity' && e.entry.message.startsWith('plan halted at step 1/3'), 30000, plan.from);
  const step1 = taskNow(plan.id);
  if (!step1?.title.startsWith('Step 1/3') || step1.studio !== 'Pranav2_Workspace') fail(`the plan dropped the ask's Studio: ${JSON.stringify(step1)}`);
  if (projectNow()?.studio !== 'Pranav2_Workspace') fail(`the ask's Studio didn't become the project's: ${JSON.stringify(projectNow())}`);
  if (step1.planNext?.steps.length !== 2) fail(`step 1 should carry the 2 later steps: ${JSON.stringify(step1.planNext)}`);
  console.log("studio ok: the ask's Studio survived routing into a plan and became the project's");

  // 2. The plan halts; its later steps wait (not dropped).
  let from = events.length;
  const halted = activitySince(plan.from).find((line) => line.startsWith('plan halted at step 1/3')) ?? '';
  if (!halted.includes('the next 2 steps wait') || !halted.includes('continue the plan')) fail(`halt line: ${halted}`);
  if (taskNow(plan.id)?.planNext?.steps.length !== 2) fail('the waiting steps were dropped');
  if (stepOf(plan.id, /Build pass/)) fail('a waiting step started on its own');
  console.log('halt ok: the stuck step keeps the plan\'s next 2 steps waiting');

  // 3. "start those steps": they run in order as steps of the same ask, with the thread.
  from = events.length;
  send({ type: 'task.message', taskId: plan.id, text: 'ok, start those steps now please' });
  await waitFor('goes on', (e) => e.type === 'activity' && e.entry.message.startsWith('plan goes on (you said to go on)'), 10000, from);
  const polish = await waitFor('polish step done', (e) => e.type === 'task.updated' && e.task.rootTaskId === plan.id && e.task.title.startsWith('Step 3/3') && e.task.status === 'done', 30000, from);
  const build = stepOf(plan.id, /^Step 2\/3 — Build pass/);
  if (!build || build.status !== 'done' || polish.type !== 'task.updated') fail(`steps 2-3: ${JSON.stringify(tasksNow().filter((task) => task.rootTaskId === plan.id))}`);
  if (taskNow(plan.id)?.planNext) fail('the waiting steps are still on the halted step');
  for (const step of [build, polish.task]) {
    if (!step.synopsis?.includes('env AGENT_HQ_STUDIO=Pranav2_Workspace')) fail(`${step.title} didn't get the ask's Studio: ${step.synopsis}`);
  }
  const brief = rows(plan.id, from).map((row) => row.text).find((text) => text.startsWith('BRIEF:')) ?? '';
  for (const part of [
    'This task is part of one ask from the owner',
    "The owner's ask: \"multi-step plan-stuck build the arena",
    '"ok, start those steps now please"',
    'Step 1/3 — Design pass — Design team, failed: Stuck',
    'After you, the plan goes on with: Design team — Polish pass',
    'Roblox Studio for this task: "Pranav2_Workspace"',
  ]) {
    if (!brief.includes(part)) fail(`step 2's brief lacks "${part}":\n${brief.slice(0, 3000)}`);
  }
  if (!brief.includes('The owner said when starting this step')) fail('the owner\'s words didn\'t reach the next step');
  console.log('resume ok: "start those steps" ran steps 2-3 in order on the ask, each with its Studio; the brief carries the ask, the owner\'s message, step 1\'s report and what comes next');

  // 4. A later ask in the project with no Studio named uses the project's.
  const later = await submit('@game design: env-echo lines-done tidy the lobby');
  const laterDone = await finished(later.id, later.from);
  if (laterDone.type !== 'task.updated' || !laterDone.task.synopsis?.includes('env AGENT_HQ_STUDIO=Pranav2_Workspace')) fail(`later ask's Studio: ${JSON.stringify(laterDone)}`);
  console.log("project ok: a later ask with no Studio named used the project's");

  // 5. The window's picker changes it (ask + project); a message naming an
  // open window as the Studio does too; "don't use …" doesn't.
  from = events.length;
  send({ type: 'task.studio', taskId: later.id, studio: 'Heat' });
  await waitFor('picker', (e) => e.type === 'project.updated' && e.project.workspaceDir === proj && e.project.studio === 'Heat', 10000, from);
  if (taskNow(later.id)?.studio !== 'Heat') fail('the picker did not set the ask');
  from = events.length;
  send({ type: 'task.message', taskId: later.id, text: "don't use Pranav2_Workspace as the studio" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (projectNow()?.studio !== 'Heat') fail('a "don\'t use" message changed the Studio');
  await finished(later.id, from);
  from = events.length;
  send({ type: 'task.message', taskId: later.id, text: 'I assigned Pranav2_Workspace as studio. Use that' });
  await waitFor('named', (e) => e.type === 'project.updated' && e.project.workspaceDir === proj && e.project.studio === 'Pranav2_Workspace', 10000, from);
  await finished(later.id, from);
  console.log('change ok: the picker set the ask and project; a message naming an open window as the Studio did too; "don\'t use" left it');

  // 6. Another wording: the routing check sends it to the waiting steps.
  const second = await submit('@game multi-step plan-stuck build the tower');
  await waitFor('halted 2', (e) => e.type === 'activity' && e.entry.message.startsWith('plan halted at step 1/3') && e.entry.taskId === second.id, 30000, second.from);
  from = events.length;
  send({ type: 'task.message', taskId: second.id, text: 'onward-request with what you have' });
  await waitFor('goes on 2', (e) => e.type === 'activity' && e.entry.message.startsWith('plan goes on (you said to go on)'), 10000, from);
  await waitFor('tower step 3', (e) => e.type === 'task.updated' && e.task.rootTaskId === second.id && e.task.title.startsWith('Step 3/3') && e.task.status === 'done', 30000, from);
  console.log('route ok: the check sent "go on" in other words to the waiting steps');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
console.log('ASK THREAD SMOKE PASS');
process.exit(0);
