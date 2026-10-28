// Away: while the owner is away, a card left unanswered gets its safe answer
// (a worker's request is declined, never approved; a pair's round cap goes
// with the work as it stands), every such card says so, and switching Away
// off sums up what was answered. While not away, cards wait as always.
//   npx tsx test/away.smoke.ts   (mock engine, no usage; Away's wait is
//   shortened to under a second)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type PermissionRequest } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['AWAY_SMOKE_PORT'] ?? 4675);
function fail(message: string): never {
  console.error(`AWAY SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-away-'));
const workRoot = join(sandbox, 'Work');
const proj = join(workRoot, 'Game');
mkdirSync(proj, { recursive: true });
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-away-claude-')),
  claudeConfigPath: join(sandbox, 'claude.json'),
  accessGrants: [],
  workspaceRoots: [{ key: 'work', path: workRoot, label: 'work' }],
  detectApps: () => [],
  awayMinutes: 0.01, // 0.6 s
  awaySweepMs: 150,
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
send({ type: 'hello', client: 'cli', name: 'away-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const activitySince = (from: number) => events.slice(from).flatMap((e) => (e.type === 'activity' ? [e.entry.message] : []));
const card = (id: string): PermissionRequest | undefined =>
  events.flatMap((e) => (e.type === 'permission.updated' && e.request.id === id ? [e.request] : [])).at(-1);
async function submit(text: string): Promise<{ id: string; from: number }> {
  const from = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`task: ${text}`, (e) => e.type === 'task.updated' && !!e.task.ownerAsk && text.includes(e.task.ownerAsk.slice(0, 24)), 30000, from);
  return { id: created.type === 'task.updated' ? created.task.id : '', from };
}
const pendingCard = async (taskId: string, from: number, prefix = '') => {
  const event = await waitFor('card', (e) => e.type === 'permission.updated' && e.request.taskId === taskId && e.request.status === 'pending' && e.request.id.startsWith(prefix), 30000, from);
  return event.type === 'permission.updated' ? event.request : fail('no card');
};
const finished = (taskId: string, from: number) =>
  waitFor('finished', (e) => e.type === 'task.updated' && e.task.id === taskId && ['done', 'failed', 'paused'].includes(e.task.status), 30000, from);

try {
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Game', workspaceDir: proj });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === proj);

  // 1. Not away: a worker's card waits, however long.
  const waiting = await submit('@game coding: denystuck-test add the package');
  const held = await pendingCard(waiting.id, waiting.from, 'perm-');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (card(held.id)?.status !== 'pending') fail('a card was answered while the owner was not away');
  send({ type: 'permission.respond', requestId: held.id, decision: 'deny', scope: 'once' });
  await finished(waiting.id, waiting.from);
  console.log('not away ok: a card waits for the owner');

  // 2. Away on: on HubInfo, said in the log.
  let from = events.length;
  send({ type: 'away.set', on: true });
  const on = await waitFor('away on', (e) => e.type === 'hub.updated' && e.info.away?.on === true, 10000, from);
  if (on.type !== 'hub.updated' || !on.info.away?.since || on.info.away.minutes !== 0.01) fail(`away info: ${JSON.stringify(on)}`);
  if (!activitySince(from).some((line) => line.startsWith('away — cards left'))) fail('no away line');

  // 3. A worker's request is declined (never approved), and the card says why.
  const worker = await submit('@game coding: denystuck-test add the package again');
  const asked = await pendingCard(worker.id, worker.from, 'perm-');
  await waitFor('declined', (e) => e.type === 'permission.updated' && e.request.id === asked.id && e.request.status === 'denied' && !!e.request.auto, 10000, worker.from);
  if (!/You were away — after .* min with no answer, Away declined it\./.test(card(asked.id)?.auto ?? '')) fail(`auto note: ${card(asked.id)?.auto}`);
  await finished(worker.id, worker.from);
  // Away's no isn't the owner's: the stuck task still gets the master's recovery.
  await pendingCard(worker.id, worker.from, `stuck-${worker.id}`);
  if (activitySince(worker.from).some((line) => line.includes('stopped at your denial'))) fail("Away's decline was taken as the owner's");
  console.log("away ok: a worker's request was declined automatically, the card says so, and the stuck task still got a recovery");

  // 4. A pair's round cap goes with the work as it stands.
  const pair = await submit('/pair @game coding: pair-never-agree rename the loader');
  const cap = await pendingCard(pair.id, pair.from, `pair-${pair.id}-3`);
  await waitFor('cap answered', (e) => e.type === 'permission.updated' && e.request.id === cap.id && e.request.status === 'approved' && !!e.request.auto, 10000, pair.from);
  const pairDone = await finished(pair.id, pair.from);
  if (pairDone.type !== 'task.updated' || pairDone.task.status !== 'done' || pairDone.task.pair?.state !== 'disagreed') fail(`pair after Away: ${JSON.stringify(pairDone)}`);
  if (!(card(cap.id)?.auto ?? '').includes('chose "Go with it as it is"')) fail(`pair auto note: ${card(cap.id)?.auto}`);
  console.log('away ok: a pair round cap went with the work as it stands');

  // 5. Back: Away off sums up what it answered.
  from = events.length;
  send({ type: 'away.set', on: false });
  await waitFor('away off', (e) => e.type === 'hub.updated' && e.info.away?.on === false, 10000, from);
  const back = activitySince(from).find((line) => line.startsWith('welcome back')) ?? '';
  if (!/welcome back — while you were away [2-9] cards were answered for you: .*declined it.*chose "Go with it as it is"/.test(back)) fail(`welcome back: ${back}`);
  console.log('back ok: Away off listed what it answered');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
console.log('AWAY SMOKE PASS');
process.exit(0);
