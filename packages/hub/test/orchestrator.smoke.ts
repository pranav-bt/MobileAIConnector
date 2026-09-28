import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
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

const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-orch-'));
const claudeProjectsDir = mkdtempSync(join(tmpdir(), 'agent-hq-claude-'));
// Freelancer session cwds live under the test workspace root so the
// freelancer-task flow can auto-register their projects.
const castleCwd = join(tmpdir(), 'CastleWars');
const bnbCwd = join(tmpdir(), 'BuildAndBattle');
let freelancerCalls = 0;
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir,
  claudeProjectsDir, // isolate the freelancer observer from real sessions
  freelancerOpenSessions: () => 2, // pretend two terminal sessions are open
  paTickMs: 300, // fast PA clock for scenario 21
  freelancerRunner: async (_sessionId, _cwd, text) => {
    freelancerCalls += 1;
    return text.includes('QA found issues')
      ? 'Fixed the tower HUD glitch as requested.'
      : 'Tower HUD tweak done (first pass).';
  },
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

  // 15. Phone -> PC: a file sent from the phone lands in data/inbox on disk
  // (the reverse of the outbox), announced in the activity feed.
  ws.send(
    encodeCommand({
      type: 'file.send',
      name: 'ref-art.png',
      mimeType: 'image/png',
      bytesB64: Buffer.from('phone-bytes').toString('base64'),
      from: 'phone',
    }),
  );
  await waitFor(
    'phone file announced in activity',
    (e) => e.type === 'activity' && e.entry.message.startsWith('file from your phone: ref-art.png'),
  );
  const landed = readFileSync(join(dataDir, 'inbox', 'ref-art.png'), 'utf8');
  if (landed !== 'phone-bytes') fail('inbox file content did not round-trip');
  if (events.some((e) => e.type === 'file.shared' && e.file.name === 'ref-art.png')) {
    fail('a phone-origin file must not be broadcast back out to the phone');
  }
  console.log('phone inbox ok: file landed in data/inbox, no echo broadcast');

  // 16. Research-style teams (no bash): reading the web is silent in auto
  // mode, and text-producing work gets NO QA follow-up.
  ws.send(
    encodeCommand({
      type: 'team.create',
      name: 'Notes team',
      charter: 'Writes notes and briefs. No code, no shell.',
      allowedTools: ['read', 'edit', 'web'],
      blockedTools: ['git', 'installs'],
    }),
  );
  await waitFor('notes team created', (e) => e.type === 'team.updated' && e.team.id === 'notes-team');
  ws.send(encodeCommand({ type: 'task.submit', text: 'notes-team webfetch-test research the papaya market' }));
  const notesDone = await waitFor(
    'notes research task done',
    (e) => e.type === 'task.updated' && e.task.detail.includes('papaya market') && e.task.status === 'done',
  );
  if (notesDone.type !== 'task.updated' || notesDone.task.teamId !== 'notes-team') fail('notes task ran on the wrong team');
  if (events.some((e) => e.type === 'permission.updated' && e.request.taskId === notesDone.task.id)) {
    fail('reading the web raised a permission card in auto mode');
  }
  await waitFor(
    'web page actually read',
    (e) => e.type === 'activity' && e.entry.message === 'mock: page read',
  );
  await new Promise((resolve) => setTimeout(resolve, 400)); // give any QA spawn a beat
  if (events.some((e) => e.type === 'task.updated' && e.task.title.includes('[QA]') && e.task.title.includes('papaya'))) {
    fail('a no-bash team task spawned a QA follow-up');
  }
  console.log('research policy ok: web read silent, no QA for text-only work');

  // 17. Credential-like reads always raise a card (flag: reads sensitive data).
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: sensitive-test inspect the deploy setup' }));
  const sensitiveAsk = await waitFor(
    'sensitive read asks',
    (e) =>
      e.type === 'permission.updated' &&
      e.request.status === 'pending' &&
      e.request.flags.includes('reads sensitive data'),
  );
  if (sensitiveAsk.type !== 'permission.updated') fail('unreachable');
  if (!sensitiveAsk.request.command.includes('id_rsa')) fail('sensitive card is not about the ssh key');
  ws.send(
    encodeCommand({ type: 'permission.respond', requestId: sensitiveAsk.request.id, decision: 'deny', scope: 'once' }),
  );
  await waitFor(
    'sensitive read denied, worker adjusted',
    (e) => e.type === 'activity' && e.entry.message === 'mock: sensitive read denied',
  );
  await waitFor(
    'sensitive-test task still completes',
    (e) => e.type === 'task.updated' && e.task.id === sensitiveAsk.request.taskId && e.task.status === 'done',
  );
  // The auto-QA follow-up re-runs the same brief (it quotes the task), so it
  // raises its own sensitive card — deny it too or its worker occupies a QA
  // slot forever and starves later scenarios.
  const qaSensitiveAsk = await waitFor(
    'QA follow-up raises its own sensitive card',
    (e) =>
      e.type === 'permission.updated' &&
      e.request.status === 'pending' &&
      e.request.flags.includes('reads sensitive data') &&
      e.request.id !== sensitiveAsk.request.id,
    20000,
  );
  if (qaSensitiveAsk.type !== 'permission.updated') fail('unreachable');
  ws.send(
    encodeCommand({ type: 'permission.respond', requestId: qaSensitiveAsk.request.id, decision: 'deny', scope: 'once' }),
  );
  await waitFor(
    'sensitive QA follow-up completes after denial',
    (e) => e.type === 'task.updated' && e.task.id === qaSensitiveAsk.request.taskId && e.task.status === 'done',
    15000,
  );
  console.log('sensitive-read gate ok: card raised, denial honored, task completed');

  // 18. Findings reach the owner: a text team's long report is saved to
  // data/reports AND pushed to the phone via the outbox.
  ws.send(encodeCommand({ type: 'task.submit', text: 'notes-team report-test full brief on the papaya market' }));
  await waitFor(
    'full report saved + announced',
    (e) => e.type === 'activity' && e.entry.message.startsWith('full report saved'),
    15000,
  );
  const reportFiles = readdirSync(join(dataDir, 'reports'));
  if (reportFiles.length === 0) fail('no file in data/reports');
  const reportBody = readFileSync(join(dataDir, 'reports', reportFiles[0]!), 'utf8');
  if (!reportBody.includes('Mock findings')) fail('report file is missing the worker findings');
  const pushed = await waitFor(
    'report pushed to the phone via outbox',
    (e) => e.type === 'file.shared' && e.file.name.startsWith('report-'),
    20000,
  );
  if (pushed.type !== 'file.shared' || !Buffer.from(pushed.file.bytesB64, 'base64').toString().includes('Mock findings')) {
    fail('pushed report does not carry the findings');
  }
  console.log('report delivery ok: findings saved to data/reports and pushed to the phone');

  // 19. Freelancer observer: a live terminal Claude Code session (a
  // recently-written transcript) shows up as a freelancer with its project
  // name and last action.
  const sessionDir = join(claudeProjectsDir, 'tmp-CastleWars');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'sess-castle-1.jsonl'),
    [
      JSON.stringify({ type: 'user', cwd: castleCwd, message: { content: 'tweak the tower balance' } }),
      JSON.stringify({
        type: 'assistant',
        cwd: castleCwd,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
      }),
    ].join('\n') + '\n',
  );
  // A second session that went quiet 10 minutes ago: open (process count
  // says 2) but idle — it must STAY visible.
  const idleDir = join(claudeProjectsDir, 'tmp-BuildAndBattle');
  mkdirSync(idleDir, { recursive: true });
  const idlePath = join(idleDir, 'sess-bnb-1.jsonl');
  writeFileSync(
    idlePath,
    JSON.stringify({
      type: 'assistant',
      cwd: bnbCwd,
      message: { content: [{ type: 'text', text: 'Battle system refactor is done, awaiting your review.' }] },
    }) + '\n',
  );
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  utimesSync(idlePath, tenMinutesAgo, tenMinutesAgo);

  const freelancer = await waitFor(
    'active terminal session appears as a working freelancer',
    (e) => e.type === 'agent.updated' && e.agent.role === 'freelancer' && e.agent.name === 'CastleWars',
    12000,
  );
  if (freelancer.type !== 'agent.updated') fail('unreachable');
  if (!freelancer.agent.activity.includes('npm test')) fail('freelancer activity missing the last action');
  const idleFreelancer = await waitFor(
    'quiet-but-open session appears as an idle freelancer',
    (e) =>
      e.type === 'agent.updated' &&
      e.agent.role === 'freelancer' &&
      e.agent.name === 'BuildAndBattle' &&
      e.agent.status === 'idle',
    12000,
  );
  if (idleFreelancer.type !== 'agent.updated') fail('unreachable');
  console.log('freelancer observer ok: working AND idle sessions visible with project name + last action');

  // Messaging plumbing: an unknown freelancer id fails loudly (real sends
  // spawn a live claude sidecar — exercised manually, not in smokes).
  ws.send(encodeCommand({ type: 'freelancer.send', agentId: 'fl-does-not-exist', text: 'status?' }));
  await waitFor(
    'freelancer.send reaches the manager',
    (e) => e.type === 'activity' && e.entry.message.includes('freelancer message failed — session not found'),
  );
  console.log('freelancer messaging plumbing ok: command routed to the manager');

  // 20. Freelancers work like workers: an instruction becomes a real task —
  // the session's project is auto-registered, the freelance desk lead
  // reviews the reply, auto-QA runs in that project, and QA failures send a
  // [fix] instruction back to the SAME session, re-QA'd until it passes.
  ws.send(
    encodeCommand({ type: 'freelancer.send', agentId: 'fl-sess-castle-1', text: 'remediate-me tweak the tower HUD' }),
  );
  const flTask = await waitFor(
    'freelancer instruction became a reviewed task',
    (e) =>
      e.type === 'task.updated' &&
      e.task.title.startsWith('[FL CastleWars]') &&
      e.task.status === 'done' &&
      !!e.task.synopsis,
    15000,
  );
  if (flTask.type !== 'task.updated') fail('unreachable');
  await waitFor(
    'freelancer project auto-registered',
    (e) => e.type === 'project.updated' && e.project.id === 'castlewars',
  );
  if (flTask.task.projectId !== 'castlewars') fail('freelancer task not pinned to its auto-registered project');
  await waitFor(
    'QA ran on the freelancer work',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('[QA] [FL CastleWars]') && e.task.status === 'done',
    15000,
  ).catch((error) => {
    console.error('--- recent task/activity events at failure ---');
    for (const e of events.slice(-40)) {
      if (e.type === 'task.updated') console.error('TASK', e.task.status, e.task.title.slice(0, 55), e.task.teamId, e.task.projectId);
      if (e.type === 'activity') console.error('ACT ', e.entry.message.slice(0, 90));
    }
    throw error;
  });
  await waitFor(
    'QA findings meeting names the freelance desk',
    (e) => e.type === 'activity' && e.entry.message.includes('Freelance desk leads are meeting'),
    15000,
  );
  await waitFor(
    'remediation went back to the same session',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('[fix] [FL CastleWars]') && e.task.status === 'done',
    15000,
  );
  await waitFor(
    're-QA passed the freelancer fix',
    (e) => e.type === 'activity' && e.entry.message.startsWith('QA verdict: pass — [fix] [FL'),
    15000,
  );
  if (freelancerCalls !== 2) fail(`expected 2 freelancer runs (work + fix), got ${freelancerCalls}`);
  console.log('freelancer-as-worker ok: task, review, QA in own project, remediation to the same session, re-QA pass');

  // 21. PA desk: deterministic capture, token-free firing to the phone, and
  // the single kill switch (/pa off holds everything; /pa on releases it).
  ws.send(encodeCommand({ type: 'pa.add', kind: 'todo', text: 'buy milk' }));
  await waitFor('todo captured', (e) => e.type === 'activity' && e.entry.message === 'todo added: buy milk');
  const todosOnDisk = JSON.parse(readFileSync(join(dataDir, 'pa', 'todos.json'), 'utf8'));
  if (!todosOnDisk.some((t: { text: string }) => t.text === 'buy milk')) fail('todo not persisted to data/pa');
  // The PA tab renders from mirrored state: pa.updated carries the stores.
  const paMirror = await waitFor(
    'pa state mirrored to clients',
    (e) => e.type === 'pa.updated' && e.pa.todos.some((t) => t.text === 'buy milk'),
  );
  if (paMirror.type !== 'pa.updated') fail('unreachable');
  const milkId = paMirror.pa.todos.find((t) => t.text === 'buy milk')!.id;
  ws.send(encodeCommand({ type: 'pa.toggle', id: milkId }));
  await waitFor(
    'todo ticked via the tab command',
    (e) => e.type === 'pa.updated' && e.pa.todos.some((t) => t.id === milkId && t.done),
  );
  ws.send(encodeCommand({ type: 'pa.remove', kind: 'todo', id: milkId }));
  await waitFor(
    'todo removed via the tab command',
    (e) => e.type === 'pa.updated' && !e.pa.todos.some((t) => t.id === milkId),
  );

  // Multi-day event (a trip): endMs survives to the mirrored state.
  ws.send(
    encodeCommand({
      type: 'pa.add',
      kind: 'event',
      text: 'Tokyo trip',
      atMs: Date.now() + 60 * 60_000,
      endMs: Date.now() + 5 * 24 * 60 * 60_000,
    }),
  );
  await waitFor(
    'spanning event mirrored with endMs',
    (e) => e.type === 'pa.updated' && e.pa.events.some((ev) => ev.title === 'Tokyo trip' && typeof ev.endMs === 'number'),
  );

  ws.send(encodeCommand({ type: 'pa.add', kind: 'reminder', text: 'stand up and stretch', atMs: Date.now() + 700 }));
  await waitFor(
    'reminder fires as an activity',
    (e) => e.type === 'activity' && e.entry.message === 'Reminder: stand up and stretch',
    8000,
  );
  await waitFor(
    'reminder pushed to the phone via outbox',
    (e) => e.type === 'file.shared' && e.file.name.startsWith('PA Reminder'),
    20000,
  );

  ws.send(encodeCommand({ type: 'pa.set', enabled: false }));
  await waitFor('PA desk off', (e) => e.type === 'activity' && e.entry.message.includes('PA desk switched OFF'));
  ws.send(encodeCommand({ type: 'pa.add', kind: 'reminder', text: 'ghost ping', atMs: Date.now() + 400 }));
  await waitFor('ghost reminder accepted', (e) => e.type === 'activity' && e.entry.message.includes('ghost ping'));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  if (events.some((e) => e.type === 'activity' && e.entry.message === 'Reminder: ghost ping')) {
    fail('the kill switch did not gate the PA clock');
  }
  ws.send(encodeCommand({ type: 'pa.set', enabled: true }));
  await waitFor(
    'held reminder fires after re-enable',
    (e) => e.type === 'activity' && e.entry.message === 'Reminder: ghost ping',
    8000,
  );
  console.log('PA desk ok: capture persisted, clock fires to phone, /pa off holds and /pa on releases');

  // 22. Global task controls: pause holds new work, resume drains, killall
  // stops everything and clears queues.
  ws.send(encodeCommand({ type: 'tasks.control', action: 'pause' }));
  await waitFor('pause announced', (e) => e.type === 'activity' && e.entry.message.startsWith('ALL TASKS PAUSED'));
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding slow-test paused-probe feature' }));
  const held = await waitFor(
    'task queued while paused',
    (e) => e.type === 'task.updated' && e.task.detail.includes('paused-probe') && e.task.status === 'queued',
  );
  if (held.type !== 'task.updated') fail('unreachable');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (events.some((e) => e.type === 'task.updated' && e.task.id === held.task.id && e.task.status === 'in_flight')) {
    fail('paused hub started a task anyway');
  }
  ws.send(encodeCommand({ type: 'tasks.control', action: 'resume' }));
  await waitFor('resume announced', (e) => e.type === 'activity' && e.entry.message.startsWith('tasks resumed'));
  await waitFor(
    'held task ran after resume',
    (e) => e.type === 'task.updated' && e.task.id === held.task.id && e.task.status === 'done',
    20000,
  );

  ws.send(encodeCommand({ type: 'task.submit', text: 'coding slow-test killme-one' }));
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding slow-test killme-two' }));
  await waitFor(
    'a killme task is running',
    (e) => e.type === 'task.updated' && e.task.detail.includes('killme') && e.task.status === 'in_flight',
    15000,
  );
  ws.send(encodeCommand({ type: 'tasks.control', action: 'killall' }));
  await waitFor('kill all announced', (e) => e.type === 'activity' && e.entry.message.startsWith('KILL ALL'));
  for (const which of ['killme-one', 'killme-two']) {
    await waitFor(
      `${which} stopped`,
      (e) => e.type === 'task.updated' && e.task.detail.includes(which) && e.task.status === 'paused',
      15000,
    );
  }
  console.log('task controls ok: pause held, resume drained, killall stopped everything');

  // 23. Model + effort choices: an override layer over the team defaults.
  // Fields resolve independently (per-team > all-role > default), the engine
  // receives the exact model id and effort, an effort the model can't take
  // (Haiku) is dropped, chips follow, it persists, and reset restores all.
  const since = (mark: number, test: (e: HubEvent) => boolean) => (e: HubEvent) => events.indexOf(e) >= mark && test(e);
  const ranOn = (mark: number, label: string, expected: string) =>
    waitFor(label, since(mark, (e) => e.type === 'activity' && e.entry.message === `mock: model ${expected}`), 15000);
  ws.send(
    encodeCommand({
      type: 'models.set',
      overrides: {
        master: { model: 'claude-sonnet-5' },
        worker: { model: 'claude-haiku-4-5-20251001', effort: 'low' },
        teams: {
          design: { lead: { model: 'claude-sonnet-5' }, worker: { model: 'claude-opus-5-5', effort: 'max' } },
          tools: { worker: { model: 'claude-sonnet-5-5' } },
        },
      },
    }),
  );
  await waitFor(
    'overrides published in hub info',
    (e) =>
      e.type === 'hub.updated' &&
      e.info.modelOverrides.worker?.model === 'claude-haiku-4-5-20251001' &&
      e.info.modelOverrides.teams['design']?.worker?.effort === 'max',
  );
  await waitFor('master chip follows (family)', (e) => e.type === 'agent.updated' && e.agent.id === 'master' && e.agent.model === 'sonnet');
  await waitFor('design lead chip follows its per-team pick', (e) => e.type === 'agent.updated' && e.agent.id === 'design-lead' && e.agent.model === 'sonnet');
  const savedConfig = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  if (savedConfig.modelOverrides?.worker?.model !== 'claude-haiku-4-5-20251001') fail('model overrides were not persisted to config.json');

  let mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: models-probe-one' }));
  // all-workers Haiku; its 'low' effort is dropped (Haiku has no effort control)
  await ranOn(mark, 'coding worker on the all-workers model, effort dropped for Haiku', 'claude-haiku-4-5-20251001 · effort default');
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: 'design models-probe-two' }));
  await ranOn(mark, 'per-team model + effort beat all-workers', 'claude-opus-5-5 · effort max');
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: 'tools models-probe-tools' }));
  // per-team model only: effort falls through to all-workers 'low' (Sonnet 5.5 supports it)
  await ranOn(mark, 'per-team model composes with the all-workers effort', 'claude-sonnet-5-5 · effort low');
  await waitFor(
    'tools probe done',
    (e) => e.type === 'task.updated' && e.task.detail.includes('models-probe-tools') && e.task.status === 'done',
    15000,
  );

  ws.send(encodeCommand({ type: 'models.set', overrides: { teams: {} } }));
  await waitFor('reset announced', (e) => e.type === 'activity' && e.entry.message === 'models reset to defaults');
  await waitFor('master chip back to its default', (e) => e.type === 'agent.updated' && e.agent.id === 'master' && e.agent.model === 'opus');
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: models-probe-three' }));
  await ranOn(mark, 'after reset the coding worker is back on its team default', 'claude-sonnet-5 · effort default');
  const resetConfig = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  if (resetConfig.modelOverrides?.worker !== undefined) fail('reset did not clear the persisted overrides');
  console.log('model choices ok: per-field precedence, exact id + effort reach the engine, Haiku effort dropped, persisted, reset restores defaults');

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
