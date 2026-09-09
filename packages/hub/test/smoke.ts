import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

// End-to-end smoke test against the demo hub: connect, receive a snapshot,
// submit a task, see it routed, approve the scripted permission request.

const PORT = 4599;

function fail(message: string): never {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

const hub = await startHub({
  demo: true,
  demoFast: true,
  port: PORT,
  dataDir: mkdtempSync(join(tmpdir(), 'agent-hq-smoke-')),
});

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
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

function waitFor(label: string, test: (e: HubEvent) => boolean, timeoutMs = 8000): Promise<HubEvent> {
  const already = events.find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), timeoutMs);
    waiters.push({
      test,
      resolve: (event) => {
        clearTimeout(timer);
        resolve(event);
      },
    });
  });
}

try {
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  const snapshot = await waitFor('snapshot', (e) => e.type === 'snapshot');
  if (snapshot.type !== 'snapshot') fail('unreachable');
  if (snapshot.snapshot.teams.length < 3) fail(`expected >=3 teams, got ${snapshot.snapshot.teams.length}`);
  if (snapshot.snapshot.agents.length < 8) fail(`expected >=8 agents, got ${snapshot.snapshot.agents.length}`);
  console.log(`snapshot ok: ${snapshot.snapshot.teams.length} teams, ${snapshot.snapshot.agents.length} agents`);

  ws.send(encodeCommand({ type: 'hello', client: 'cli', name: 'smoke' }));
  ws.send(encodeCommand({ type: 'task.submit', text: 'Smoke test task: touch nothing, report back' }));
  const routed = await waitFor(
    'submitted task routed to a team',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('Smoke test task') && e.task.teamId !== null,
  );
  console.log(`task routing ok: ${routed.type === 'task.updated' ? routed.task.teamId : '?'}`);

  const pending = await waitFor(
    'scripted permission request',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending',
  );
  if (pending.type !== 'permission.updated') fail('unreachable');
  ws.send(
    encodeCommand({
      type: 'permission.respond',
      requestId: pending.request.id,
      decision: 'approve',
      scope: 'once',
    }),
  );
  await waitFor(
    'permission approved',
    (e) => e.type === 'permission.updated' && e.request.id === pending.request.id && e.request.status === 'approved',
  );
  console.log('permission round-trip ok');

  // Single-command team creation → room appears.
  ws.send(
    encodeCommand({
      type: 'team.create',
      name: 'Research',
      charter: 'Gathers sources, never edits code.',
      allowedTools: ['browser', 'read'],
      blockedTools: ['git', 'installs'],
    }),
  );
  await waitFor('team created', (e) => e.type === 'team.updated' && e.team.id === 'research');
  console.log('team.create ok');

  console.log('SMOKE PASS');
  ws.close();
  await hub.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  ws.close();
  await hub.close();
  process.exit(1);
}
