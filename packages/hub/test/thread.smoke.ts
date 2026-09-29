// The owner's conversation thread, end to end through a real hub (mock
// engine): which project an unnamed ask inherits, what may move it, and that
// KILL ALL and a restart don't silently reset it. Started from QA's probe.
//
// Usage: npx tsx test/thread.smoke.ts   (mock engine, no usage)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['THREAD_SMOKE_PORT'] ?? 4611);
const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-thread-'));
const claudeProjectsDir = mkdtempSync(join(tmpdir(), 'agent-hq-thread-claude-'));
const hubOptions = {
  engine: 'mock' as const,
  dataDir,
  claudeProjectsDir,
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
};

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures += 1;
};

type TaskEvent = Extract<HubEvent, { type: 'task.updated' }>;
type PermissionEvent = Extract<HubEvent, { type: 'permission.updated' }>;

// One client per hub; a restart swaps in a fresh one.
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events: HubEvent[] = [];
  const waiters: { test: (e: HubEvent) => boolean; resolve: (e: HubEvent) => void }[] = [];
  ws.on('message', (raw) => {
    const event = decodeEvent(raw.toString());
    if (!event) return;
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.test(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  const waitFor = <T extends HubEvent = HubEvent>(label: string, test: (e: HubEvent) => boolean, timeoutMs = 20000) => {
    const already = events.find(test);
    if (already) return Promise.resolve(already as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
      waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e as T)) });
    });
  };
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  const send = (command: ClientCommand) => ws.send(encodeCommand(command));
  send({ type: 'hello', client: 'cli', name: 'thread-smoke' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');

  const latest = (marker: string) =>
    ([...events].reverse().find((e) => e.type === 'task.updated' && e.task.detail.includes(marker)) as TaskEvent | undefined)
      ?.task;
  return {
    ws,
    events,
    send,
    waitFor,
    latest,
    submit: (text: string) => send({ type: 'task.submit', text }),
    done: (marker: string) =>
      waitFor<TaskEvent>(`done: ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && e.task.status === 'done'),
    created: (marker: string) =>
      waitFor<TaskEvent>(`created: ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker)),
    card: (taskId: string, prefix = '') =>
      waitFor<PermissionEvent>(
        `card for ${taskId}`,
        (e) => e.type === 'permission.updated' && e.request.status === 'pending' && e.request.taskId === taskId && e.request.id.startsWith(prefix),
      ),
    routedLine: (taskId: string) =>
      ([...events].reverse().find((e) => e.type === 'activity' && e.entry.taskId === taskId && e.entry.message.startsWith('routed')) as
        | Extract<HubEvent, { type: 'activity' }>
        | undefined)?.entry.message ?? '',
  };
}
const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

let hub = await startHub({ ...hubOptions, port: PORT });
let c = await connect(PORT);

for (const name of ['PancakeStack', 'CastleWars']) {
  c.send({ type: 'project.register', name, workspaceDir: join(tmpdir(), `agent-hq-thread-${name}-${Date.now()}`), description: '' });
  await c.waitFor(`${name} registered`, (e) => e.type === 'project.updated' && e.project.id === name.toLowerCase());
}

try {
  // 1. An explicit @pin anchors the thread.
  c.submit('@pancakestack coding: build the lobby anchor-one');
  await c.done('anchor-one');
  await settle();
  check('1. @pin anchors the thread', c.latest('anchor-one')?.projectId === 'pancakestack', c.latest('anchor-one')?.projectId ?? '');

  // 2. A bare follow-up inherits it, and the activity line says why.
  c.submit('coding: is the complete map and all the bases setup done follow-two');
  await c.done('follow-two');
  await settle();
  const followTwo = c.latest('follow-two')!;
  check('2. bare follow-up inherits the thread project', followTwo.projectId === 'pancakestack', followTwo.projectId ?? '');
  check('2b. routed line names the basis', c.routedLine(followTwo.id).includes('continues your thread'), c.routedLine(followTwo.id));

  // 3. ownerAsk rides on owner tasks only, never on QA follow-ups.
  check('3a. ownerAsk set on the owner task', !!followTwo.ownerAsk);
  const qa = [...c.events].reverse().find((e) => e.type === 'task.updated' && e.task.title.startsWith('[QA]')) as TaskEvent | undefined;
  check('3b. QA follow-up carries no ownerAsk', !!qa && !qa.task.ownerAsk, qa ? String(qa.task.ownerAsk) : 'no QA task seen');

  // 4. An ask the owner stops doesn't capture the thread.
  c.submit('@castlewars coding: install the audit tooling (stop-me)');
  const stopMe = (await c.created('(stop-me)')).task;
  await c.card(stopMe.id);
  c.send({ type: 'task.stop', taskId: stopMe.id });
  await c.waitFor('stop-me paused', (e) => e.type === 'task.updated' && e.task.id === stopMe.id && e.task.status === 'paused');
  await settle();
  c.submit('coding: and what about the publishable build after-stop');
  await c.done('after-stop');
  await settle();
  check('4. owner-stopped ask does not capture the thread', c.latest('after-stop')?.projectId === 'pancakestack', c.latest('after-stop')?.projectId ?? '');

  // 5. An @pin to an unregistered project fails loudly and runs nothing.
  c.submit('@pancakestak coding: fix the drop rate typo-pin');
  const typo = (await c.waitFor<TaskEvent>('typo-pin failed', (e) => e.type === 'task.updated' && e.task.detail.includes('typo-pin') && e.task.status === 'failed')).task;
  await settle();
  check('5a. unknown @pin fails instead of running', typo.projectId === null && typo.teamId === null, typo.status);
  check('5b. the failure says what to do', /@pancakestak/.test(typo.synopsis ?? '') && /\/project add/.test(typo.synopsis ?? ''), typo.synopsis ?? '');
  check('5c. nothing ran for it', !c.events.some((e) => e.type === 'agent.updated' && e.agent.taskId === typo.id));

  // 6. Naming another project in passing asks first; denying keeps it home.
  c.submit('coding: make the ui look like castlewars mention-deny');
  const deny = (await c.created('mention-deny')).task;
  const denyCard = await c.card(deny.id, 'route-');
  check(
    '6a. leaving the thread raises a card',
    denyCard.request.command.includes('CastleWars') && denyCard.request.reason.includes('PancakeStack'),
    denyCard.request.command,
  );
  c.send({ type: 'permission.respond', requestId: denyCard.request.id, decision: 'deny', scope: 'once' });
  await c.done('mention-deny');
  await settle();
  check('6b. denied switch stays in the thread project', c.latest('mention-deny')?.projectId === 'pancakestack', c.latest('mention-deny')?.projectId ?? '');

  // 7. …and approving moves it (and then the thread).
  c.submit('coding: fix the castlewars towers mention-approve');
  const approve = (await c.created('mention-approve')).task;
  const approveCard = await c.card(approve.id, 'route-');
  c.send({ type: 'permission.respond', requestId: approveCard.request.id, decision: 'approve', scope: 'once' });
  await c.done('mention-approve');
  await settle();
  check('7a. approved switch runs in the named project', c.latest('mention-approve')?.projectId === 'castlewars', c.latest('mention-approve')?.projectId ?? '');
  c.submit('coding: and is that one publishable too after-move');
  await c.done('after-move');
  await settle();
  check('7b. the thread follows the approved move', c.latest('after-move')?.projectId === 'castlewars', c.latest('after-move')?.projectId ?? '');

  // 8. An @pin never needs the card, and the thread survives a chain.
  c.submit('@pancakestack multi-step: first design then build chain-eight');
  await c.waitFor('chain finished', (e) => e.type === 'task.updated' && e.task.title.startsWith('Step 2/') && e.task.status === 'done');
  await settle(2500);
  c.submit('coding: and is the whole thing shippable after-chain');
  await c.done('after-chain');
  await settle();
  check('8. thread survives a multi-team chain', c.latest('after-chain')?.projectId === 'pancakestack', c.latest('after-chain')?.projectId ?? '');

  // 9. KILL ALL is not a verdict on the project: the thread stays, visibly.
  c.submit('@castlewars coding: install the tooling kill-me');
  const killMe = (await c.created('kill-me')).task;
  await c.card(killMe.id);
  c.send({ type: 'tasks.control', action: 'killall' });
  await c.waitFor('kill-me paused', (e) => e.type === 'task.updated' && e.task.id === killMe.id && e.task.status === 'paused');
  const killLine = (await c.waitFor<Extract<HubEvent, { type: 'activity' }>>('kill line', (e) => e.type === 'activity' && e.entry.message.startsWith('KILL ALL'))).entry.message;
  check('9a. KILL ALL says where the thread is', killLine.includes('CastleWars'), killLine);
  await settle();
  c.submit('coding: so where were we after-kill');
  await c.done('after-kill');
  await settle();
  check('9b. the thread survives KILL ALL', c.latest('after-kill')?.projectId === 'castlewars', c.latest('after-kill')?.projectId ?? '');

  // 10. A hub restart (in-flight work comes back paused) keeps it too. The
  // anchor makes "dropped the interrupted ask" land somewhere different.
  c.submit('@castlewars coding: tidy the lobby anchor-ten');
  await c.done('anchor-ten');
  await settle();
  c.submit('@pancakestack coding: install the exporter restart-me');
  const restartMe = (await c.created('restart-me')).task;
  await c.card(restartMe.id);
  c.ws.close();
  await hub.close();
  hub = await startHub({ ...hubOptions, port: PORT + 1 });
  c = await connect(PORT + 1);
  const snapshot = c.events.find((e) => e.type === 'snapshot') as Extract<HubEvent, { type: 'snapshot' }>;
  const restored = snapshot.snapshot.tasks.find((task) => task.id === restartMe.id);
  check('10a. interrupted ask comes back paused by the restart', restored?.status === 'paused' && restored.stoppedBy === 'restart', `${restored?.status} ${restored?.stoppedBy}`);
  c.submit('coding: did that exporter land after-restart');
  await c.done('after-restart');
  await settle();
  check('10b. the thread survives a hub restart', c.latest('after-restart')?.projectId === 'pancakestack', c.latest('after-restart')?.projectId ?? '');
} catch (error) {
  check('run', false, error instanceof Error ? error.message : String(error));
}

c.ws.close();
await hub.close();
console.log(failures ? `\n${failures} THREAD CHECK(S) FAILED` : '\nthread ok: pins, names, stops, kills and restarts all land where they should');
process.exit(failures ? 1 : 0);
