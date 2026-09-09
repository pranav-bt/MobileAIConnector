import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

// Orchestrator flow against the mock engine: routing by charter keyword,
// full lifecycle to done-with-synopsis, permission gating mid-task, and
// single-command team creation with a live lead.

const PORT = 4601;

function fail(message: string): never {
  console.error(`ORCH SMOKE FAIL: ${message}`);
  process.exit(1);
}

const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: mkdtempSync(join(tmpdir(), 'agent-hq-orch-')),
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
  // The hub classifies a connection by its first frame — say hello first.
  ws.send(encodeCommand({ type: 'hello', client: 'cli', name: 'orch-smoke' }));

  const snapshot = await waitFor('snapshot', (e) => e.type === 'snapshot');
  if (snapshot.type !== 'snapshot') fail('unreachable');
  const leadCount = snapshot.snapshot.agents.filter((agent) => agent.role === 'lead').length;
  if (snapshot.snapshot.teams.length < 3 || leadCount < 3) {
    fail(`expected 3 default teams with leads, got ${snapshot.snapshot.teams.length} teams / ${leadCount} leads`);
  }
  console.log(`registry ok: ${snapshot.snapshot.teams.length} teams, ${leadCount} leads, master seeded`);

  // 1. Routing by charter: mentions design -> design team, full lifecycle.
  ws.send(encodeCommand({ type: 'task.submit', text: 'Write up the design direction for the mobile app' }));
  const routed = await waitFor(
    'design task routed to design team',
    (e) => e.type === 'task.updated' && e.task.detail.startsWith('Write up the design') && e.task.teamId === 'design',
  );
  const designTaskId = routed.type === 'task.updated' ? routed.task.id : '';
  await waitFor(
    'design task done with synopsis',
    (e) => e.type === 'task.updated' && e.task.id === designTaskId && e.task.status === 'done' && !!e.task.synopsis,
  );
  console.log('routing + lifecycle ok: design task done with lead synopsis');

  // 2. Permission gate: "install" makes the mock worker raise a hand.
  ws.send(encodeCommand({ type: 'task.submit', text: 'Please install the test tooling for coding' }));
  const pending = await waitFor(
    'permission request from worker',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending',
  );
  if (pending.type !== 'permission.updated') fail('unreachable');
  ws.send(
    encodeCommand({ type: 'permission.respond', requestId: pending.request.id, decision: 'approve', scope: 'once' }),
  );
  await waitFor(
    'gated task done after approval',
    (e) => e.type === 'task.updated' && e.task.id === pending.request.taskId && e.task.status === 'done',
  );
  console.log('permission gate ok: approved and completed');

  // 3. Single-command team creation seeds a lead too.
  ws.send(
    encodeCommand({
      type: 'team.create',
      name: 'Research',
      charter: 'Gathers sources, never edits code.',
      allowedTools: ['browser', 'read'],
      blockedTools: ['git', 'installs'],
    }),
  );
  await waitFor('research team created', (e) => e.type === 'team.updated' && e.team.id === 'research');
  await waitFor('research lead seeded', (e) => e.type === 'agent.updated' && e.agent.id === 'research-lead');
  console.log('team.create ok: room + lead live');

  // 4. Stopping a task whose worker is parked on a permission request.
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: install another tool (stop-test)' }));
  const pendingStop = await waitFor(
    'stop-test permission request',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending' && e.request.id !== pending.request.id,
  );
  if (pendingStop.type !== 'permission.updated') fail('unreachable');
  ws.send(encodeCommand({ type: 'task.stop', taskId: pendingStop.request.taskId }));
  await waitFor(
    'stop-test permission expired',
    (e) => e.type === 'permission.updated' && e.request.id === pendingStop.request.id && e.request.status === 'expired',
  );
  await waitFor(
    'stop-test task paused',
    (e) => e.type === 'task.updated' && e.task.id === pendingStop.request.taskId && e.task.status === 'paused',
  );
  console.log('task.stop ok: permission expired, task paused');

  console.log('ORCH SMOKE PASS');
  ws.close();
  await hub.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  ws.close();
  await hub.close();
  process.exit(1);
}
