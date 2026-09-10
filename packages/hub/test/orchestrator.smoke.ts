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
  // Tests sandbox the workspace-roots policy to the temp dir.
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
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

  // 5. Projects: default auto-registered; register, pin with @, remove.
  if (snapshot.snapshot.projects.length < 1) fail('expected the default project in the snapshot');
  ws.send(
    encodeCommand({
      type: 'project.register',
      name: 'Sandbox',
      workspaceDir: join(tmpdir(), `agent-hq-sandbox-${Date.now()}`),
      description: 'smoke-test project',
    }),
  );
  await waitFor('sandbox project registered', (e) => e.type === 'project.updated' && e.project.id === 'sandbox');
  ws.send(encodeCommand({ type: 'task.submit', text: '@sandbox design the welcome screen' }));
  const pinned = await waitFor(
    'pinned task done in sandbox project via design team',
    (e) =>
      e.type === 'task.updated' &&
      e.task.projectId === 'sandbox' &&
      e.task.teamId === 'design' &&
      e.task.status === 'done',
  );
  if (pinned.type !== 'task.updated') fail('unreachable');
  console.log('project pinning ok: @sandbox task ran in the sandbox workspace');

  // 6. Scaling subagents and removing teams/projects — each one command.
  ws.send(encodeCommand({ type: 'team.update', teamId: 'coding', maxConcurrentWorkers: 3 }));
  await waitFor(
    'coding cap raised to 3',
    (e) => e.type === 'team.updated' && e.team.id === 'coding' && e.team.maxConcurrentWorkers === 3,
  );
  ws.send(encodeCommand({ type: 'team.remove', teamId: 'research' }));
  await waitFor('research team removed', (e) => e.type === 'team.removed' && e.teamId === 'research');
  ws.send(encodeCommand({ type: 'project.remove', projectId: 'sandbox' }));
  await waitFor('sandbox project removed', (e) => e.type === 'project.removed' && e.projectId === 'sandbox');
  console.log('team scaling + team/project removal ok');

  // 7. Workspace-roots policy: registration outside the roots is refused.
  ws.send(
    encodeCommand({ type: 'project.register', name: 'Escapee', workspaceDir: 'C:\\Windows\\definitely-not-allowed' }),
  );
  await waitFor(
    'out-of-roots registration refused',
    (e) => e.type === 'activity' && e.entry.message.includes('outside the allowed workspace roots'),
  );
  if (events.some((e) => e.type === 'project.updated' && e.project.id === 'escapee')) {
    fail('out-of-roots project was registered anyway');
  }
  console.log('workspace-roots policy ok: out-of-roots registration refused');

  // 8. Permission policy — auto (default): plain edits run without asking…
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: edit-test tweak the readme' }));
  const autoEdit = await waitFor(
    'auto-mode edit-test task done',
    (e) => e.type === 'task.updated' && e.task.detail.includes('edit-test tweak') && e.task.status === 'done',
  );
  if (autoEdit.type !== 'task.updated') fail('unreachable');
  if (
    events.some(
      (e) => e.type === 'permission.updated' && e.request.taskId === autoEdit.task.id,
    )
  ) {
    fail('auto mode raised a permission card for a plain edit');
  }
  console.log('auto policy ok: edit ran silently (install still asked earlier)');

  // …strict: the same edit asks.
  ws.send(encodeCommand({ type: 'permissions.set', mode: 'strict' }));
  await waitFor('strict mode set', (e) => e.type === 'hub.updated' && e.info.permissionMode === 'strict');
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: edit-test again strictly' }));
  const strictPending = await waitFor(
    'strict-mode edit asks',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending' && e.request.command === 'Edit mock-file.ts',
  );
  if (strictPending.type !== 'permission.updated') fail('unreachable');
  ws.send(
    encodeCommand({ type: 'permission.respond', requestId: strictPending.request.id, decision: 'approve', scope: 'once' }),
  );
  await waitFor(
    'strict-mode edit task done',
    (e) => e.type === 'task.updated' && e.task.id === strictPending.request.taskId && e.task.status === 'done',
  );
  ws.send(encodeCommand({ type: 'permissions.set', mode: 'auto' }));
  await waitFor('auto mode restored', (e) => e.type === 'hub.updated' && e.info.permissionMode === 'auto');
  console.log('strict policy ok: edit asked, approval completed, auto restored');

  // 9. Interdisciplinary: QA team auto-exists; a coding task gets a QA
  // follow-up that runs in the same project.
  const qaTeam = snapshot.snapshot.teams.find((team) => /qa|test/i.test(team.id)) ??
    (await waitFor('qa team seeded', (e) => e.type === 'team.updated' && /qa|test/i.test(e.team.id)) as never);
  const codingDone = await waitFor(
    'earlier coding task done',
    (e) => e.type === 'task.updated' && e.task.teamId === 'coding' && e.task.status === 'done',
  );
  if (codingDone.type !== 'task.updated') fail('unreachable');
  const qaFollowUp = await waitFor(
    'QA follow-up created and completed',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('[QA]') && e.task.status === 'done',
  );
  if (qaFollowUp.type !== 'task.updated') fail('unreachable');
  if (!/qa|test/i.test(qaFollowUp.task.teamId ?? '')) fail('QA follow-up not assigned to the QA team');
  if (events.some((e) => e.type === 'task.updated' && e.task.title.startsWith('[QA] [QA]'))) {
    fail('QA recursion: QA tasks must not spawn QA tasks');
  }
  console.log('auto-QA ok: follow-up ran on the QA team, no recursion');

  // 10. Sequenced multi-team plan with handover.
  ws.send(encodeCommand({ type: 'task.submit', text: 'multi-step: first design then build the widget' }));
  const step1 = await waitFor(
    'plan step 1 (design) done',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('Step 1/2') && e.task.status === 'done',
  );
  if (step1.type !== 'task.updated' || step1.task.teamId !== 'design') fail('step 1 should run on design');
  const step2 = await waitFor(
    'plan step 2 (coding) done with handover',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('Step 2/2') && e.task.status === 'done',
    15000,
  );
  if (step2.type !== 'task.updated' || step2.task.teamId !== 'coding') fail('step 2 should run on coding');
  if (!step2.task.detail.includes('Handover from the previous step')) fail('step 2 missing the handover context');
  console.log('multi-team plan ok: design -> coding with handover');

  // 11. File channel: a sent file comes back as a file.shared event.
  ws.send(
    encodeCommand({ type: 'file.send', name: 'note.txt', mimeType: 'text/plain', bytesB64: Buffer.from('hello phone').toString('base64') }),
  );
  const shared = await waitFor('file.shared broadcast', (e) => e.type === 'file.shared' && e.file.name === 'note.txt');
  if (shared.type !== 'file.shared' || Buffer.from(shared.file.bytesB64, 'base64').toString() !== 'hello phone') {
    fail('file payload did not round-trip');
  }
  console.log('file channel ok: desktop -> hub -> clients');

  // 12. QA remediation loop: QA finds real issues -> the QA and source-team
  // leads meet in the Meeting room -> a [fix] task goes back to the source
  // team -> the fix is re-QA'd and passes (no infinite loop).
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: remediate-me sneaky bug feature' }));
  await waitFor(
    'remediate-me coding task done',
    (e) => e.type === 'task.updated' && e.task.detail.startsWith('coding: remediate-me') && e.task.status === 'done',
  );
  await waitFor(
    'leads meet over QA findings',
    (e) => e.type === 'agent.updated' && e.agent.id === 'coding-lead' && e.agent.activity.startsWith('meeting:'),
    15000,
  );
  const qaLeadMeeting = events.some(
    (e) => e.type === 'agent.updated' && /qa|test/i.test(e.agent.id) && e.agent.activity.startsWith('meeting:'),
  );
  if (!qaLeadMeeting) fail('QA lead never joined the meeting');
  const fixDone = await waitFor(
    '[fix] task done on the source team',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('[fix]') && e.task.status === 'done',
    15000,
  );
  if (fixDone.type !== 'task.updated' || fixDone.task.teamId !== 'coding') {
    fail('the [fix] task should run on the coding team');
  }
  await waitFor(
    're-QA passes the fix',
    (e) => e.type === 'activity' && e.entry.message.startsWith('QA verdict: pass — [fix]'),
    15000,
  );
  if (events.some((e) => e.type === 'task.updated' && e.task.title.startsWith('[fix2]'))) {
    fail('remediation looped past the first round when the fix was clean');
  }
  console.log('QA remediation ok: meeting held, [fix] ran on coding, re-QA passed');

  // 13. Scale-up ask: a backed-up team raises an approval card; approving it
  // lifts the team's concurrent-worker cap by one.
  for (let i = 1; i <= 5; i++) {
    ws.send(encodeCommand({ type: 'task.submit', text: `coding slow-test batch item ${i}` }));
  }
  const scaleAsk = await waitFor(
    'scale-up card for the coding team',
    (e) => e.type === 'permission.updated' && e.request.id.startsWith('scale-coding-') && e.request.status === 'pending',
    15000,
  );
  if (scaleAsk.type !== 'permission.updated') fail('unreachable');
  ws.send(
    encodeCommand({ type: 'permission.respond', requestId: scaleAsk.request.id, decision: 'approve', scope: 'once' }),
  );
  await waitFor(
    'coding cap raised by approval',
    (e) => e.type === 'team.updated' && e.team.id === 'coding' && e.team.maxConcurrentWorkers === 4,
  );
  await waitFor(
    'slow-test backlog fully drained',
    (e) => e.type === 'task.updated' && e.task.detail.includes('batch item 5') && e.task.status === 'done',
    30000,
  );
  console.log('scale-up ask ok: card raised at 2 queued, approval lifted the cap, queue drained');

  // 14. General master coordination: ANY completed report that hands work to
  // a different team makes the master hold a meeting and dispatch a follow-up
  // there — not just the QA case.
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: handoff-test build the settings screen' }));
  await waitFor(
    'handoff-test coding task done',
    (e) => e.type === 'task.updated' && e.task.detail.startsWith('coding: handoff-test') && e.task.status === 'done',
    20000,
  );
  await waitFor(
    'coding + design leads meet over the handover',
    (e) => e.type === 'agent.updated' && e.agent.id === 'design-lead' && e.agent.activity.startsWith('meeting: handover'),
    15000,
  );
  const followUp = await waitFor(
    'dispatched follow-up done on design',
    (e) => e.type === 'task.updated' && e.task.title === 'Produce the icon set' && e.task.status === 'done',
    15000,
  );
  if (followUp.type !== 'task.updated' || followUp.task.teamId !== 'design') {
    fail('the dispatched follow-up should run on the design team');
  }
  if (!followUp.task.detail.includes('Handover from the Coding team')) {
    fail('the follow-up is missing the handover context from the source report');
  }
  const iconTasks = events.filter(
    (e) => e.type === 'task.updated' && e.task.title === 'Produce the icon set',
  );
  const distinctIconTaskIds = new Set(iconTasks.map((e) => (e.type === 'task.updated' ? e.task.id : '')));
  if (distinctIconTaskIds.size > 1) fail('coordination dispatched the same follow-up more than once');
  console.log('master coordination ok: handover meeting held, follow-up dispatched to design, no cascade');

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
