// Task Console end to end against a mock hub: opening a console backfills
// its history and streams live rows (to that client only), rows update in
// place, cards appear inline, a follow-up on a finished task continues the
// SAME conversation (and skips QA when nothing changed), a message mid-run
// reaches the running worker, Stop keeps the conversation, closing the
// console stops the rows, and transcripts persist with paging.
//   npx tsx test/console.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { TranscriptStore } from '../src/transcripts.js';

const PORT = Number(process.env['CONSOLE_SMOKE_PORT'] ?? 4641);
function fail(message: string): never {
  console.error(`CONSOLE SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-console-'));
const dataDir = join(sandbox, 'data');
const projectDir = join(sandbox, 'Consolproj');
mkdirSync(projectDir);
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir,
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-console-claude-')),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});

async function connect(name: string) {
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
  send({ type: 'hello', client: 'cli', name });
  const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 15000, from = 0): Promise<HubEvent> => {
    const already = events.slice(from).find(test);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
      waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
    });
  };
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  return { ws, events, send, waitFor };
}

const a = await connect('console-a');
const b = await connect('console-b'); // never opens a console
const rowsFor = (taskId: string) => {
  const rows = new Map<string, TranscriptEntry>();
  for (const e of a.events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) rows.set(entry.id, entry);
  return [...rows.values()];
};
const taskOf = (taskId: string): Task | undefined =>
  ([...a.events].reverse().find((e) => e.type === 'task.updated' && e.task.id === taskId) as Extract<HubEvent, { type: 'task.updated' }> | undefined)?.task;
const created = async (marker: string) => {
  const e = await a.waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker));
  return e.type === 'task.updated' ? e.task.id : '';
};
const doneAfter = (taskId: string, from: number, timeoutMs = 15000) =>
  a.waitFor(`${taskId} finished`, (e) => e.type === 'task.updated' && e.task.id === taskId && ['done', 'failed'].includes(e.task.status), timeoutMs, from);
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
// What the worker itself said (the task's synopsis is the lead's review).
const workerSaid = (taskId: string) => rowsFor(taskId).filter((r) => r.role === 'worker' && r.kind === 'message').map((r) => r.text).join(' || ');

try {
  a.send({ type: 'project.register', name: 'Consolproj', workspaceDir: projectDir });
  await a.waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'consolproj');

  // 1. Open a console: history first, then live rows; rows update in place.
  a.send({ type: 'task.submit', text: '@consolproj coding: console-one writes-files remember KIWI' });
  const one = await created('console-one');
  a.send({ type: 'task.watch', taskId: one });
  const backfill = await a.waitFor('backfill', (e) => e.type === 'task.transcript' && e.taskId === one && e.backfill === true);
  if (backfill.type !== 'task.transcript' || !backfill.entries.some((r) => r.role === 'owner' && r.text.includes('KIWI'))) fail('backfill lacks the owner\'s ask');
  await doneAfter(one, 0);
  await settle();
  const rows = rowsFor(one);
  const tool = rows.find((r) => r.kind === 'tool');
  if (!rows.some((r) => r.role === 'worker' && r.kind === 'message' && r.text.startsWith('Mock worker on it'))) fail('no worker message row');
  if (!tool || tool.state !== 'ok' || tool.detail !== 'mock') fail(`tool row not updated in place: ${JSON.stringify(tool)}`);
  if (!rows.some((r) => r.role === 'lead' && r.kind === 'message')) fail('no lead review row');
  if (!rows.some((r) => r.role === 'master' && r.kind === 'status' && /routed/.test(r.text))) fail('routing line missing from the console');
  const session = taskOf(one)?.session;
  if (!session?.id.startsWith('mock-session-')) fail(`no session saved on the task: ${JSON.stringify(session)}`);
  const qaLink = rows.find((r) => r.kind === 'status' && r.linkTaskId);
  if (!qaLink || !/QA follow-up/.test(qaLink.text)) fail('no link row to the QA follow-up');
  if (b.events.some((e) => e.type === 'task.transcript')) fail('a client that never opened a console got transcript rows');
  console.log('console ok: backfill + live rows, tool rows update in place, routing/lead/QA-link rows, session saved, other clients get nothing');

  // 2. Continue a finished task: same conversation, it remembers; no QA when nothing changed.
  await settle(1500); // let its QA follow-up finish
  const qaBefore = a.events.filter((e) => e.type === 'task.updated' && e.task.title.startsWith('[QA]') && e.task.status === 'queued').length;
  let mark = a.events.length;
  a.send({ type: 'task.message', taskId: one, text: 'recall-test what did I tell you?' });
  await a.waitFor('resumed', (e) => e.type === 'activity' && e.entry.taskId === one && e.entry.message === `mock: resumed ${session!.id}`, 15000, mark);
  await doneAfter(one, mark);
  await settle(1200);
  if (!/remembered: .*KIWI/.test(workerSaid(one))) fail(`continued task forgot: ${workerSaid(one)}`);
  if (!rowsFor(one).some((r) => r.role === 'owner' && r.text === 'recall-test what did I tell you?')) fail('follow-up not shown as an owner row');
  const qaAfter = a.events.filter((e) => e.type === 'task.updated' && e.task.title.startsWith('[QA]') && e.task.status === 'queued').length;
  if (qaAfter !== qaBefore) fail('a follow-up that changed nothing was sent to QA');
  console.log('continue ok: same session resumed, it remembered KIWI, no QA for a no-change follow-up');

  // 3. A message while it works reaches the running worker.
  a.send({ type: 'task.submit', text: '@consolproj coding: console-slow stay busy' });
  const slow = await created('console-slow stay busy');
  a.send({ type: 'task.watch', taskId: slow });
  await a.waitFor('slow worker running', (e) => e.type === 'agent.updated' && e.agent.taskId === slow && e.agent.role === 'worker' && e.agent.status === 'working');
  mark = a.events.length;
  a.send({ type: 'task.message', taskId: slow, text: 'BANANA please' });
  await doneAfter(slow, mark);
  await settle(300);
  if (!/heard: BANANA please/.test(workerSaid(slow))) fail(`mid-run message not heard: ${workerSaid(slow)}`);
  if (!rowsFor(slow).some((r) => r.kind === 'status' && /sent to the worker/.test(r.text))) fail('no "sent to the worker" row');
  console.log('mid-run ok: the running worker got the message');

  // 4. Stop keeps the conversation; a message picks it back up.
  a.send({ type: 'task.submit', text: '@consolproj coding: console-slow stoppable work' });
  const stoppable = await created('console-slow stoppable');
  a.send({ type: 'task.watch', taskId: stoppable });
  await a.waitFor('stoppable running', (e) => e.type === 'agent.updated' && e.agent.taskId === stoppable && e.agent.role === 'worker' && e.agent.status === 'working');
  a.send({ type: 'task.stop', taskId: stoppable });
  await a.waitFor('paused', (e) => e.type === 'task.updated' && e.task.id === stoppable && e.task.status === 'paused');
  await settle();
  const kept = taskOf(stoppable)?.session;
  if (!kept) fail('stopped task lost its conversation');
  if (!rowsFor(stoppable).some((r) => /send a message to pick up where it left off/.test(r.text))) fail('no stopped row');
  mark = a.events.length;
  a.send({ type: 'task.message', taskId: stoppable, text: 'recall-test pick it up' });
  await a.waitFor('resumed after stop', (e) => e.type === 'activity' && e.entry.taskId === stoppable && e.entry.message === `mock: resumed ${kept!.id}`, 15000, mark);
  await doneAfter(stoppable, mark);
  await settle(300);
  if (!/remembered: .*stoppable work/.test(workerSaid(stoppable))) fail(`resumed-after-stop forgot: ${workerSaid(stoppable)}`);
  console.log('stop ok: conversation kept, a message resumed it with memory');

  // 5. Cards show inline and update when answered.
  a.send({ type: 'task.submit', text: '@consolproj coding: console-card please install the thing' });
  const carded = await created('console-card');
  a.send({ type: 'task.watch', taskId: carded });
  const card = await a.waitFor('card', (e) => e.type === 'permission.updated' && e.request.taskId === carded && e.request.status === 'pending');
  if (card.type !== 'permission.updated') fail('unreachable');
  await a.waitFor('card row', (e) => e.type === 'task.transcript' && e.taskId === carded && e.entries.some((r) => r.kind === 'card' && r.requestId === card.request.id));
  a.send({ type: 'permission.respond', requestId: card.request.id, decision: 'approve', scope: 'once' });
  await a.waitFor('card row resolved', (e) => e.type === 'task.transcript' && e.taskId === carded && e.entries.some((r) => r.kind === 'card' && r.state === 'ok'));
  console.log('cards ok: inline, resolved in place');

  // 6. Closing the console stops its rows.
  a.send({ type: 'task.unwatch', taskId: one });
  await settle(300);
  mark = a.events.length;
  a.send({ type: 'task.message', taskId: one, text: 'one more thing' });
  await doneAfter(one, mark);
  await settle();
  if (a.events.slice(mark).some((e) => e.type === 'task.transcript' && e.taskId === one)) fail('rows kept coming after the console closed');
  console.log('unwatch ok: no rows after closing');

  // 7. Transcripts persist and page.
  await settle(500);
  const store = new TranscriptStore(dataDir);
  const saved = await store.read(one);
  if (!saved.entries.some((r) => r.text === 'one more thing')) fail('rows sent while closed were not saved');
  const big = new TranscriptStore(join(sandbox, 'paging'));
  for (let i = 0; i < 350; i++) big.append('t-page', { id: `p${i}`, role: 'worker', kind: 'message', text: `row ${i}`, at: 1000 + i });
  await big.flush();
  const latest = await big.read('t-page');
  const older = await big.read('t-page', latest.entries[0]!.at);
  if (latest.entries.length !== 300 || !latest.more || latest.entries[0]!.text !== 'row 50') fail(`paging wrong: ${latest.entries.length} rows, more=${latest.more}`);
  if (older.entries.length !== 50 || older.more || older.entries.at(-1)!.text !== 'row 49') fail(`older page wrong: ${older.entries.length}`);
  console.log('storage ok: persisted, latest page + older page');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  a.ws.close();
  b.ws.close();
  await hub.close();
}
console.log('CONSOLE SMOKE PASS');
process.exit(0);
