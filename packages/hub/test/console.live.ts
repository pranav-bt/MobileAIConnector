// LIVE Task Console on a real hub (own port, temp data) with real workers:
// a finished task continues with its memory, a message sent mid-run reaches
// the running worker, and Stop keeps the conversation. Run it per engine:
//   npx tsx test/console.live.ts                      (Claude worker)
//   npx tsx test/console.live.ts --model gpt-6.1-sol  (Codex worker)
// Spends some usage.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const modelArg = process.argv.indexOf('--model');
const WORKER = modelArg > 0 ? process.argv[modelArg + 1]! : 'claude-sonnet-5-5';
const PORT = 4632;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-console-live-'));
const projectDir = join(sandbox, 'Liveproj');
mkdirSync(projectDir);
const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-console-live-claude-')),
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
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 600_000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const rows = (taskId: string) => {
  const byId = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) byId.set(entry.id, entry);
  return [...byId.values()];
};
const workerSaid = (taskId: string, from = 0) =>
  rows(taskId)
    .filter((row) => row.role === 'worker' && row.kind === 'message' && row.at >= from)
    .map((row) => row.text)
    .join(' || ');
const finished = (taskId: string, from: number) =>
  waitFor(`${taskId} finished`, (e) => e.type === 'task.updated' && e.task.id === taskId && ['done', 'failed'].includes(e.task.status), 600_000, from);
const submit = async (text: string, marker: string): Promise<string> => {
  send({ type: 'task.submit', text });
  const e = await waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker) && ev.task.teamId === 'coding');
  const id = e.type === 'task.updated' ? e.task.id : '';
  send({ type: 'task.watch', taskId: id });
  return id;
};
const toolRunning = (taskId: string, from: number) =>
  waitFor('a tool started', (e) => e.type === 'task.transcript' && e.taskId === taskId && e.entries.some((row) => row.kind === 'tool' && row.state === 'running'), 300_000, from);

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'console-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({
    type: 'models.set',
    overrides: {
      master: { model: 'claude-haiku-4-5-20251001' },
      teams: { coding: { lead: { model: 'claude-haiku-4-5-20251001' }, worker: { model: WORKER, effort: 'low' } } },
    },
  });
  await waitFor('seats', (e) => e.type === 'hub.updated' && e.info.modelOverrides.teams['coding']?.worker?.model === WORKER);
  send({ type: 'project.register', name: 'Liveproj', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'liveproj');
  console.log(`worker model: ${WORKER}\n`);

  // 1. A task that sets up memory.
  const one = await submit('@liveproj coding: Remember the secret word PINEAPPLE for later. Create a file note.txt containing hello. Reply in one sentence.', 'PINEAPPLE');
  await finished(one, 0);
  const task1 = [...events].reverse().find((e) => e.type === 'task.updated' && e.task.id === one);
  const session = task1?.type === 'task.updated' ? task1.task.session : null;
  record('first run', existsSync(join(projectDir, 'note.txt')) && !!session, `note.txt ${existsSync(join(projectDir, 'note.txt')) ? 'written' : 'missing'} · session ${session?.engine}:${session?.id.slice(0, 12)}`);
  record('console rows', rows(one).some((r) => r.kind === 'tool' || r.kind === 'diff') && rows(one).some((r) => r.role === 'lead'), rows(one).map((r) => `${r.role}/${r.kind}`).slice(0, 12).join(' '));

  // 2. Continue it: same conversation, it remembers.
  let mark = events.length;
  let since = Date.now();
  send({ type: 'task.message', taskId: one, text: 'What was the secret word I gave you? Reply with just the word.' });
  await finished(one, mark);
  const resumedLine = events.slice(mark).find((e) => e.type === 'activity' && e.entry.taskId === one && e.entry.message.startsWith('resuming the conversation'));
  record('continue remembers', /PINEAPPLE/i.test(workerSaid(one, since)) && !!resumedLine, `"${workerSaid(one, since).slice(0, 120)}"`);

  // 3. A message while it works reaches the running worker.
  since = Date.now();
  mark = events.length;
  const slow = await submit(
    '@liveproj coding: Run this shell command and wait for it: node -e "setTimeout(()=>console.log(\'slow done\'),9000)" — then reply in one sentence. slowmark',
    'slowmark',
  );
  await toolRunning(slow, mark);
  send({ type: 'task.message', taskId: slow, text: 'Also: make the very last word of your reply BANANA.' });
  await finished(slow, mark);
  record('mid-run message reaches the worker', /BANANA/i.test(workerSaid(slow, since)), `"${workerSaid(slow, since).slice(-120)}"`);

  // 4. Stop keeps the conversation.
  mark = events.length;
  const stoppable = await submit(
    '@liveproj coding: Remember the word MANGO. Then run this shell command and wait for it to finish: node -e "setTimeout(()=>{},120000)" stopmark',
    'stopmark',
  );
  await toolRunning(stoppable, mark);
  send({ type: 'task.stop', taskId: stoppable });
  await waitFor('paused', (e) => e.type === 'task.updated' && e.task.id === stoppable && e.task.status === 'paused', 60_000, mark);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  since = Date.now();
  mark = events.length;
  send({ type: 'task.message', taskId: stoppable, text: 'Forget the command. What word did I ask you to remember? Reply with just the word.' });
  await finished(stoppable, mark);
  record('stop keeps the conversation', /MANGO/i.test(workerSaid(stoppable, since)), `"${workerSaid(stoppable, since).slice(0, 120)}"`);
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nCONSOLE LIVE FAIL (${WORKER}): ${failed.map((f) => f.check).join('; ')}` : `\nCONSOLE LIVE PASS (${WORKER})`);
process.exit(failed.length ? 1 : 0);
