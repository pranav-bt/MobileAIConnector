// The owner's conversation thread, end to end through a real hub (mock
// engine): which project an unnamed ask inherits, what may move it, and that
// KILL ALL and a restart don't silently reset it. Started from QA's probe.
//
// Usage: npx tsx test/thread.smoke.ts   (mock engine, no usage)

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['THREAD_SMOKE_PORT'] ?? 4611);
const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-thread-'));
const claudeProjectsDir = mkdtempSync(join(tmpdir(), 'agent-hq-thread-claude-'));
// A root holding one unregistered project folder (scenario 12); listed first
// so the folder scan reaches it before wandering the whole temp dir.
const sparesRoot = mkdtempSync(join(tmpdir(), 'agent-hq-thread-spares-'));
const spareName = `Sparebox${Date.now().toString(36)}`;
mkdirSync(join(sparesRoot, spareName));
writeFileSync(join(sparesRoot, spareName, 'CLAUDE.md'), '# spare project\n');
const pinName = `Pinbox${Date.now().toString(36)}`;
mkdirSync(join(sparesRoot, pinName, '.git'), { recursive: true });
const hubOptions = {
  engine: 'mock' as const,
  dataDir,
  claudeProjectsDir,
  workspaceRoots: [
    { key: 'spares', path: sparesRoot, label: 'spare projects' },
    { key: 'tmp', path: tmpdir(), label: 'test sandbox' },
  ],
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

  // 11. An ask that clearly isn't thread work is ASKED, never guessed: a
  // pick-one card with the master's guesses + the thread. Picking runs it there.
  c.submit('coding: unsure-test the balance sheet off-one');
  const offOne = (await c.created('off-one')).task;
  const question = (await c.card(offOne.id, 'project-')).request;
  const labels = question.options ?? [];
  check(
    '11a. off-thread ask raises a which-project card',
    labels.includes('CastleWars') && labels.at(-1) === 'PancakeStack',
    labels.join('|') || 'no options',
  );
  check('11b. nothing ran before the answer', !c.events.some((e) => e.type === 'agent.updated' && e.agent.taskId === offOne.id && e.agent.role === 'worker'));
  c.send({ type: 'permission.respond', requestId: question.id, decision: 'approve', scope: 'once', choice: labels.indexOf('CastleWars') });
  await c.done('off-one');
  check('11c. the picked project runs it', c.latest('off-one')?.projectId === 'castlewars', c.latest('off-one')?.projectId ?? '');
  c.submit('coding: and tighten the numbers after-pick');
  await c.done('after-pick');
  check('11d. the thread follows the pick', c.latest('after-pick')?.projectId === 'castlewars', c.latest('after-pick')?.projectId ?? '');

  // 12. An unregistered project folder can be picked: it gets registered.
  c.submit(`coding: unsure-test ${spareName.toLowerCase()} needs a lobby off-two`);
  const offTwo = (await c.created('off-two')).task;
  const folderCard = (await c.card(offTwo.id, 'project-')).request;
  const folderIndex = folderCard.options?.findIndex((label) => label === `${spareName} (new)`) ?? -1;
  check('12a. unregistered folder offered as "new"', folderIndex >= 0, folderCard.options?.join('|') ?? '');
  c.send({ type: 'permission.respond', requestId: folderCard.id, decision: 'approve', scope: 'once', choice: Math.max(0, folderIndex) });
  await c.done('off-two');
  const spareId = spareName.toLowerCase();
  check('12b. picking it registers + runs there', c.latest('off-two')?.projectId === spareId, c.latest('off-two')?.projectId ?? '');

  // 13. "None of these": nothing runs, the ask leaves the thread.
  c.submit('coding: unsure-test something else entirely off-three');
  const offThree = (await c.created('off-three')).task;
  const noneCard = (await c.card(offThree.id, 'project-')).request;
  c.send({ type: 'permission.respond', requestId: noneCard.id, decision: 'deny', scope: 'once' });
  await c.waitFor('declined ask paused', (e) => e.type === 'task.updated' && e.task.id === offThree.id && e.task.status === 'paused');
  check('13a. declined: not run, says what to do', /which project\?/.test(c.latest('off-three')?.synopsis ?? ''), c.latest('off-three')?.synopsis ?? '');
  c.submit('coding: follow-up after-none');
  await c.done('after-none');
  check('13b. the thread is where it was', c.latest('after-none')?.projectId === spareId, c.latest('after-none')?.projectId ?? '');

  // 14. "General" asks (about no project) run without asking — only for
  // teams that run no commands; a shell team is asked instead.
  c.submit('design: general-test pick a colour for my bedroom gen-one');
  await c.done('gen-one');
  check('14a. general ask, text team: no card, hub workspace', c.latest('gen-one')?.projectId === 'mobileaiconnector', c.latest('gen-one')?.projectId ?? '');
  c.submit('coding: general-test clean my downloads gen-two');
  const genTwo = (await c.created('gen-two')).task;
  const genCard = await c.card(genTwo.id, 'project-');
  check('14b. general ask, shell team: asked', !!genCard);
  c.send({ type: 'permission.respond', requestId: genCard.request.id, decision: 'deny', scope: 'once' });

  // 15. @pin to a folder that exists but isn't registered: offered for
  // registration (one option), not refused.
  c.submit(`@${pinName.toLowerCase()} coding: set up the repo pin-folder`);
  const pinTask = (await c.created('pin-folder')).task;
  const pinCard = (await c.card(pinTask.id, 'project-')).request;
  check('15a. unregistered @pin offers to register it', pinCard.options?.join('|') === `${pinName} (new)`, pinCard.options?.join('|') ?? '');
  c.send({ type: 'permission.respond', requestId: pinCard.id, decision: 'approve', scope: 'once', choice: 0 });
  await c.done('pin-folder');
  check('15b. registered and ran there', c.latest('pin-folder')?.projectId === pinName.toLowerCase(), c.latest('pin-folder')?.projectId ?? '');
} catch (error) {
  check('run', false, error instanceof Error ? error.message : String(error));
}

c.ws.close();
await hub.close();
console.log(failures ? `\n${failures} THREAD CHECK(S) FAILED` : '\nthread ok: pins, names, stops, kills and restarts all land where they should');
process.exit(failures ? 1 : 0);
