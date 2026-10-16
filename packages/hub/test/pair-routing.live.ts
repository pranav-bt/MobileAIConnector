// LIVE: the real master picks a pair mode from the owner's "## Pairing"
// rules. Tasks are paused first, so asks are only ROUTED (queued, never
// run) — routing calls only; the queue is cleared at the end.
//   npx tsx test/pair-routing.live.ts      Spends a little usage (routing only).
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type Task } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = 4639;
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-pairroute-live-'));
const projectDir = join(sandbox, 'Routelive');
mkdirSync(projectDir);
const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-pairroute-live-claude-')),
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
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 180_000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const taskOf = (taskId: string): Task | undefined =>
  ([...events].reverse().find((e) => e.type === 'task.updated' && e.task.id === taskId) as Extract<HubEvent, { type: 'task.updated' }> | undefined)?.task;

const cases: { text: string; want: 'review' | 'split' | 'debate' | 'none' }[] = [
  { text: '@routelive fix the bug where expired session tokens are still accepted by the login check in auth/session.js', want: 'review' },
  { text: '@routelive decide whether our new public API should be REST or GraphQL, and write up the decision with the trade-offs', want: 'debate' },
  {
    text: '@routelive build the importer: two independent modules built in parallel — a CSV parser in src/csv and an XLSX parser in src/xlsx — plus tests for each',
    want: 'split',
  },
  { text: '@routelive fix the typo "Wellcome" in the README title', want: 'none' },
];
let failures = 0;
try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'pair-routing-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Routelive', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'routelive');
  send({ type: 'tasks.control', action: 'pause' });
  for (const [section, rule] of [
    ['pairing', 'Pair-review anything touching authentication, sessions, payments or data migrations.'],
    ['pairing', 'Debate architecture and API design decisions before anything is built.'],
    ['pairing', 'Split big builds made of independent modules between the two models.'],
  ] as const) {
    send({ type: 'team.rules.add', teamId: 'master', rule, section });
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const { text, want } of cases) {
    const mark = events.length;
    send({ type: 'task.submit', text });
    const routed = await waitFor(
      `routed: ${text.slice(10, 50)}`,
      (e) => e.type === 'activity' && e.entry.agentId === 'master' && /^(routed|project:)/.test(e.entry.message),
      180_000,
      mark,
    );
    const taskId = routed.type === 'activity' ? routed.entry.taskId ?? '' : '';
    const got = taskOf(taskId)?.pair?.mode ?? 'none';
    const ok = got === want;
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${want.padEnd(6)} ← ${got.padEnd(6)} ${routed.type === 'activity' ? routed.entry.message.slice(0, 150) : ''}`);
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL  run — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  send({ type: 'tasks.control', action: 'killall' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  ws.close();
  await hub.close();
}
console.log(failures === 0 ? `PAIR ROUTING LIVE PASS (${cases.length} asks)` : `PAIR ROUTING LIVE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
