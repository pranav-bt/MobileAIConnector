import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, parseRules, rulesFor, type HubEvent } from '@agent-hq/shared';
import { refusedWrite } from '../src/engine/claude.js';
import { startHub } from '../src/index.js';
import { HubBus } from '../src/bus.js';
import { startEventLog } from '../src/persist.js';
import { ownershipIsDisjoint } from '../src/orchestrator/master.js';
import { splitWorthChecking } from '../src/orchestrator/orchestrator.js';
import { evaluatePermission, type WorkspaceScope } from '../src/orchestrator/policy.js';
import { isInside } from '../src/orchestrator/util.js';

// Orchestrator flow against the mock engine: routing by charter keyword,
// full lifecycle to done-with-synopsis, permission gating mid-task, and
// single-command team creation with a live lead.

// Overridable so two smoke runs (e.g. parallel workers) can coexist.
const PORT = Number(process.env['ORCH_SMOKE_PORT'] ?? 4601);

function fail(message: string): never {
  console.error(`ORCH SMOKE FAIL: ${message}`);
  process.exit(1);
}

// Long enough for the event log's 250 ms flush timer and the append that
// follows it — the async path the running hub actually takes.
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 600));

const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-orch-'));
const claudeProjectsDir = mkdtempSync(join(tmpdir(), 'agent-hq-claude-'));
// Freelancer session cwds live under the test workspace root so the
// freelancer-task flow can auto-register their projects.
const castleCwd = join(tmpdir(), 'CastleWars');
const bnbCwd = join(tmpdir(), 'BuildAndBattle');
let freelancerCalls = 0;
// A stand-in ~/.claude.json: the MCP servers "configured on this PC".
const claudeConfigPath = join(claudeProjectsDir, 'claude.json');
writeFileSync(
  claudeConfigPath,
  JSON.stringify({
    mcpServers: { Fake_Studio: { type: 'stdio', command: 'cmd.exe', args: ['/c', 'exit'] } },
    projects: { 'D:/Somewhere': { mcpServers: { Fake_Figma: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } } },
  }),
);
const hub = await startHub({
  claudeConfigPath,
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

// Waits until no task (on `teamId`, or anywhere) is queued or running.
// Parked-on-a-card tasks from earlier scenarios count as idle.
async function waitIdle(label: string, teamId?: string, timeoutMs = 30000): Promise<void> {
  const settled = ['done', 'failed', 'paused', 'awaiting_permission'];
  for (const started = Date.now(); ; ) {
    const latest = new Map<string, { title: string; status: string }>();
    for (const e of events) {
      if (e.type === 'task.updated' && (!teamId || e.task.teamId === teamId)) latest.set(e.task.id, e.task);
    }
    const busy = [...latest.values()].filter((task) => !settled.includes(task.status));
    if (busy.length === 0) return;
    if (Date.now() - started > timeoutMs) {
      fail(`timed out waiting for: ${label} (busy: ${busy.map((task) => `${task.title} [${task.status}]`).join('; ')})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  // Plain English from the first frame (rule-based, no model wait)…
  if (!pending.request.summary?.includes('install software packages')) {
    fail(`card opened without a plain-English summary: ${pending.request.summary ?? '(none)'}`);
  }
  // …then the master's explanation replaces it while the card is pending.
  await waitFor(
    'card summary upgraded to the master explanation',
    (e) =>
      e.type === 'permission.updated' &&
      e.request.id === pending.request.id &&
      e.request.status === 'pending' &&
      !!e.request.summary?.startsWith('Mock explanation'),
  );
  ws.send(
    encodeCommand({ type: 'permission.respond', requestId: pending.request.id, decision: 'approve', scope: 'once' }),
  );
  await waitFor(
    'gated task done after approval',
    (e) => e.type === 'task.updated' && e.task.id === pending.request.taskId && e.task.status === 'done',
  );
  const cardHistory = events.flatMap((e) =>
    e.type === 'permission.updated' && e.request.id === pending.request.id ? [e.request.status] : [],
  );
  if (cardHistory.lastIndexOf('pending') > cardHistory.indexOf('approved')) {
    fail(`a decided card was reopened: ${cardHistory.join(' → ')}`);
  }
  console.log('permission gate ok: plain-English card, master explanation, approved and completed');

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
  const stopTestTask = await waitFor(
    'stop-test task created',
    (e) => e.type === 'task.updated' && e.task.detail.includes('(stop-test)'),
  );
  if (stopTestTask.type !== 'task.updated') fail('unreachable');
  // Match on the task: another pending card (e.g. a QA follow-up's install)
  // would otherwise stop the wrong task and leave this one parked forever.
  const pendingStop = await waitFor(
    'stop-test permission request',
    (e) =>
      e.type === 'permission.updated' &&
      e.request.status === 'pending' &&
      e.request.id !== pending.request.id &&
      e.request.taskId === stopTestTask.task.id,
  );
  if (pendingStop.type !== 'permission.updated') fail('unreachable');
  ws.send(encodeCommand({ type: 'task.stop', taskId: pendingStop.request.taskId }));
  await waitFor(
    'stop-test permission expired',
    (e) => e.type === 'permission.updated' && e.request.id === pendingStop.request.id && e.request.status === 'expired',
  );
  const stopped = await waitFor(
    'stop-test task paused',
    (e) => e.type === 'task.updated' && e.task.id === pendingStop.request.taskId && e.task.status === 'paused',
  );
  if (stopped.type !== 'task.updated') fail('unreachable');
  // A paused task must let go of its agents, or the Today panel keeps
  // reporting "2 agents" for work that stopped.
  if (stopped.task.agentIds.length > 0) {
    fail(`stopped task still lists agents: ${stopped.task.agentIds.join(', ')}`);
  }
  console.log('task.stop ok: permission expired, task paused, agents released');
  // Task 1's QA follow-up also asks to install; approve it so the QA team
  // isn't left parked on the card for the rest of the run.
  const qaInstallTask = await waitFor(
    'QA follow-up of the install task',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('[QA] Please install'),
  );
  if (qaInstallTask.type !== 'task.updated') fail('unreachable');
  const qaInstallCard = await waitFor(
    'QA install permission card',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending' && e.request.taskId === qaInstallTask.task.id,
  );
  if (qaInstallCard.type !== 'permission.updated') fail('unreachable');
  ws.send(encodeCommand({ type: 'permission.respond', requestId: qaInstallCard.request.id, decision: 'approve', scope: 'once' }));

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

  // 5b. Project isolation: a worker's tool scope is its OWN workspace plus
  // the phone inbox/outbox — never a workspace root, which would hand it
  // write access to every other project under it.
  const scopes = events.flatMap((e) =>
    e.type === 'activity' && e.entry.message.startsWith('mock: workspace ') ? [e.entry.message] : [],
  );
  if (scopes.length === 0) fail('no worker workspace scope was reported by the mock engine');
  const allowedExtras = [join(dataDir, 'outbox'), join(dataDir, 'inbox')];
  for (const scope of scopes) {
    const extras = (scope.match(/· extra \[(.*)\]$/)?.[1] ?? '').split('|').filter(Boolean);
    for (const dir of extras) {
      if (!allowedExtras.includes(dir)) {
        fail(`worker was handed a directory outside its project: ${dir} (${scope})`);
      }
    }
  }
  console.log(`project isolation ok: ${scopes.length} workers scoped to their own workspace + the phone dirs`);

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

  // 8b. Shell writes are scoped too. Write/Edit are refused outright outside
  // the project, but the shell is NOT confined by the SDK's directory grants —
  // cp/mv/redirects/sed -i once reached straight into sibling projects with no
  // card at all, which is how a worker copied a file into the project next
  // door. Table first (every construct), then end-to-end through a worker.
  const castleScope: WorkspaceScope = { cwd: 'D:\\PersonalWork\\CastleWars', extraDirs: ['D:\\hub\\data\\outbox'] };
  const shellCases: [string, boolean][] = [
    // in-project work stays silent
    ['cp src/Art.luau build/Art.luau', false],
    ['echo hello > notes.txt', false],
    ['npm run build > build.log 2>&1', false],
    ['mkdir -p src/server/modules', false],
    ["sed -i 's/a/b/' src/Art.luau", false],
    ['Set-Content -Path .\\data\\x.json -Value "{}"', false],
    ['cp src/a.luau D:\\PersonalWork\\CastleWars\\build\\a.luau', false],
    ['cp report.md D:\\hub\\data\\outbox\\report.md', false], // the phone outbox is granted
    ['grep -r steal D:\\PersonalWork\\PancakeStack', false], // reading elsewhere stays routine
    ['ls D:\\Work\\Roblox', false],
    // …and every way out of the project asks
    ['cp Art.luau D:\\PersonalWork\\PancakeStack\\src\\Art.luau', true],
    ['cp Art.luau /d/PersonalWork/PancakeStack/src/Art.luau', true], // Git Bash drive form
    ['mv build/out.rbxl ../PancakeStack/out.rbxl', true],
    ['echo "patched" > ../PancakeStack/src/Art.luau', true],
    ['echo "patched" >> D:/PersonalWork/PancakeStack/notes.md', true],
    ["sed -i 's/a/b/' ../PancakeStack/src/Art.luau", true],
    ['Set-Content -Path D:\\PersonalWork\\PancakeStack\\x.json -Value "{}"', true],
    ['Copy-Item src\\Art.luau -Destination ..\\PancakeStack\\Art.luau', true],
    ['Out-File -FilePath ~\\Desktop\\dump.txt', true],
    ['curl https://example.com/x.zip -o ../PancakeStack/x.zip', true],
    ['tar -xzf bundle.tgz -C ../PancakeStack', true],
    ['New-Item -ItemType Directory -Path D:\\Work\\Sneaky', true],
    ['cp "Art.luau" "../Pancake Stack/Art.luau"', true], // quoted path with a space
  ];
  for (const [command, shouldAsk] of shellCases) {
    const verdict = evaluatePermission('Bash', command, 'auto', castleScope);
    const asked = verdict.decision === 'ask' && verdict.flags.some((f) => f.startsWith('writes outside this project'));
    if (asked !== shouldAsk) {
      fail(`shell scope: \`${command}\` should ${shouldAsk ? 'ask' : 'run silently'} (got ${JSON.stringify(verdict)})`);
    }
  }
  // git carries its repo in a global option, so the gate has to read the
  // resolved repo path, not the command string.
  const gitCases: [string, string][] = [
    ['git push origin main', 'publishes / pushes'],
    ['git -C ../PancakeStack push', 'publishes / pushes'],
    ['git --git-dir=../PancakeStack/.git --work-tree=../PancakeStack push', 'publishes / pushes'],
    ['git -c user.name=x push --force', 'destructive'],
    ['git -C ../PancakeStack reset --hard HEAD~1', 'destructive'],
    ['git --git-dir ../PancakeStack/.git clean -fd', 'destructive'],
  ];
  for (const [command, flag] of gitCases) {
    const verdict = evaluatePermission('Bash', command, 'auto', castleScope);
    if (verdict.decision !== 'ask' || !verdict.flags.includes(flag)) {
      fail(`git gate: \`${command}\` should be flagged "${flag}" (got ${JSON.stringify(verdict)})`);
    }
  }
  // …and a git command aimed at another project's repo is caught whatever it does.
  const strayCommit = evaluatePermission('Bash', 'git -C ../PancakeStack commit -am wip', 'auto', castleScope);
  if (strayCommit.decision !== 'ask') fail('git -C into a sibling project ran ungated');
  if (evaluatePermission('Bash', 'git commit -am wip', 'auto', castleScope).decision !== 'allow') {
    fail('an ordinary in-project commit should stay silent');
  }
  // A junction can't tunnel out either: realPath resolves both sides.
  const junctionRoot = mkdtempSync(join(tmpdir(), 'agent-hq-junction-'));
  const realTarget = join(junctionRoot, 'OtherProject');
  const workspace = join(junctionRoot, 'MyProject');
  mkdirSync(realTarget, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  let junctionMade = true;
  try {
    symlinkSync(realTarget, join(workspace, 'escape'), 'junction');
  } catch {
    junctionMade = false; // no rights to make one — the check below is moot
  }
  if (junctionMade) {
    const viaJunction = evaluatePermission(
      'Bash',
      `cp Art.luau ${join(workspace, 'escape', 'Art.luau')}`,
      'auto',
      { cwd: workspace, extraDirs: [] },
    );
    if (viaJunction.decision !== 'ask') fail('a junction let a shell write escape the workspace');
    if (isInside(join(workspace, 'escape', 'x.txt'), workspace)) fail('isInside followed a junction out of the workspace');
  }
  console.log(
    `shell scope ok: ${shellCases.length} constructs classified, git global options gated${junctionMade ? ', junction escape blocked' : ' (junction check skipped)'}`,
  );

  // 8c. End-to-end: a worker's cross-project shell write raises a card…
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: shellwrite-test copy the art file next door' }));
  const shellCard = await waitFor(
    'cross-project shell write asks',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending' && e.request.command.startsWith('cp Art.luau'),
  );
  if (shellCard.type !== 'permission.updated') fail('unreachable');
  if (!shellCard.request.flags.some((f) => f.startsWith('writes outside this project'))) {
    fail(`the cross-project shell card is missing its flag: ${JSON.stringify(shellCard.request.flags)}`);
  }
  ws.send(encodeCommand({ type: 'permission.respond', requestId: shellCard.request.id, decision: 'deny', scope: 'once' }));
  await waitFor(
    'cross-project copy denied',
    (e) => e.type === 'activity' && e.entry.message === 'mock: cross-project copy denied',
  );
  // …while the same command inside the project does not.
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: shellinside-test copy the art file in place' }));
  await waitFor('in-project copy ran silently', (e) => e.type === 'activity' && e.entry.message === 'mock: copied in place');
  const inPlaceTask = await waitFor(
    'in-project copy task done',
    (e) => e.type === 'task.updated' && e.task.detail.includes('shellinside-test') && e.task.status === 'done',
  );
  if (inPlaceTask.type !== 'task.updated') fail('unreachable');
  if (events.some((e) => e.type === 'permission.updated' && e.request.taskId === inPlaceTask.task.id)) {
    fail('an in-project shell copy raised a permission card');
  }
  // The QA follow-up inherits the title, so the mock reaches for the same
  // sibling project and hits the same gate — answer it, or a QA worker sits
  // on the card and the whole QA queue parks behind it.
  const qaShellCard = await waitFor(
    'the QA follow-up hits the same gate',
    (e) =>
      e.type === 'permission.updated' &&
      e.request.status === 'pending' &&
      e.request.id !== shellCard.request.id &&
      e.request.command.includes('SomeOtherProject'),
    15000,
  );
  if (qaShellCard.type !== 'permission.updated') fail('unreachable');
  ws.send(encodeCommand({ type: 'permission.respond', requestId: qaShellCard.request.id, decision: 'deny', scope: 'once' }));
  console.log('shell scope e2e ok: cross-project copy carded and denied, in-project copy silent');

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

  // 10b. Lead split pass: a big build task fans out — scaffold first, then
  // parallel parts on separate workers, then one integration worker on the
  // original task.
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: parallel-test build the two-module widget with a shared index' }));
  const scaffoldDone = await waitFor(
    'split scaffold done',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('[scaffold]') && e.task.status === 'done',
    15000,
  );
  const partsDone = await Promise.all(
    ['[part 1/2]', '[part 2/2]'].map((prefix) =>
      waitFor(
        `split ${prefix} done`,
        (e) => e.type === 'task.updated' && e.task.title.startsWith(prefix) && e.task.status === 'done',
        15000,
      ),
    ),
  );
  if (scaffoldDone.type !== 'task.updated') fail('scaffold event shape');
  for (const part of partsDone) {
    if (part.type !== 'task.updated' || part.task.teamId !== 'coding') fail('split parts should run on coding');
    if (!part.task.detail.includes('You exclusively own: src/')) fail('part missing its file ownership');
    if (part.task.createdAt < scaffoldDone.task.updatedAt) fail('parts started before the scaffold finished');
  }
  await waitFor(
    'split parent integrated and done',
    (e) =>
      e.type === 'task.updated' &&
      e.task.detail.startsWith('coding: parallel-test') &&
      !e.task.title.startsWith('[') &&
      e.task.status === 'done',
    15000,
  );
  await waitFor(
    'integration step ran after the parts',
    (e) => e.type === 'agent.updated' && e.agent.role === 'lead' && e.agent.activity.startsWith('integrating 2 parts'),
  );
  console.log('lead split ok: scaffold -> 2 parallel parts -> integration');

  // The parent's progress only climbs across plan -> parts -> integration.
  const splitParentId = events.find(
    (e) => e.type === 'task.updated' && e.task.detail.startsWith('coding: parallel-test') && !e.task.title.startsWith('['),
  );
  if (splitParentId?.type !== 'task.updated') fail('unreachable');
  let lastPct = -1;
  for (const e of events) {
    if (e.type !== 'task.updated' || e.task.id !== splitParentId.task.id) continue;
    if (e.task.progressPct < lastPct) fail(`split parent progress regressed ${lastPct}% -> ${e.task.progressPct}%`);
    lastPct = e.task.progressPct;
  }

  // Pieces are internal: tagged with the parent, unreviewed (raw worker
  // report, no lead review), no sub-agents; their tokens roll up into the
  // parent (scaffold + 2 parts + integration, 42 each in the mock).
  const parentId = splitParentId.task.id;
  for (const piece of [scaffoldDone, ...partsDone]) {
    if (piece.type !== 'task.updated') fail('unreachable');
    if (piece.task.parentTaskId !== parentId) fail(`${piece.task.title} should carry parentTaskId ${parentId}`);
    if (piece.task.synopsis !== 'Mock worker: completed the task as described.') {
      fail(`${piece.task.title} should keep the raw worker report (no lead review), got: ${piece.task.synopsis}`);
    }
    if (!events.some((e) => e.type === 'activity' && e.entry.taskId === piece.task.id && e.entry.message === 'mock: subagents capped at 0')) {
      fail(`${piece.task.title} should run with sub-agents disabled`);
    }
  }
  if (events.some((e) => e.type === 'activity' && e.entry.message.startsWith('report filed: [part'))) {
    fail('a split part went through the lead review');
  }
  const parentFinal = events.findLast((e) => e.type === 'task.updated' && e.task.id === parentId);
  if (parentFinal?.type !== 'task.updated') fail('unreachable');
  if (parentFinal.task.tokensUsed !== 42 * 4) fail(`split parent should total every worker's tokens (168), got ${parentFinal.task.tokensUsed}`);
  if (parentFinal.task.parentTaskId) fail('the split parent itself is user-facing, not internal');
  if (events.some((e) => e.type === 'activity' && e.entry.taskId === parentId && e.entry.message === 'mock: subagents capped at 0')) {
    fail('the integration worker should keep its sub-agents');
  }
  console.log('split pieces ok: internal, unreviewed, no sub-agents, tokens rolled up into the parent');

  // 10c. Split gate + ownership rules (pure): [fix]/QA/pieces never split,
  // short asks skip the split check, parts must own disjoint non-empty paths.
  if (splitWorthChecking('[fix] Tower HUD', 'coding: build the whole tower system across every module in the game now')) {
    fail('[fix] tasks must never split');
  }
  if (splitWorthChecking('[fix2] Tower HUD', 'implement '.repeat(80))) fail('[fix2] tasks must never split');
  if (splitWorthChecking('Rename var', 'rename the foo variable to bar')) fail('a short ask should skip the split check');
  if (!splitWorthChecking('Build game', 'build the full game: tower system, economy, UI and the save layer')) {
    fail('a build task should get the split check');
  }
  const ownership: [string[][], boolean][] = [
    [[['src/a'], ['src/b']], true],
    [[['src/a/'], ['SRC\\A\\x.ts']], false], // nested, case/slash-insensitive
    [[['src/a'], ['src/a']], false],
    [[['src/a'], []], false], // empty ownership
    [[['src/a'], ['.']], false], // the whole tree
    [[['src/a'], ['src/**/*.ts']], false], // unverifiable glob
    [[['src/a/**'], ['src/ab']], true], // prefix of a name is not nesting
    [[['/src/a'], ['src/a']], false], // a leading slash is still workspace-relative
    [[['D:/Repo/src/a'], ['src/a/x.ts']], false], // absolute inside the workspace
    [[['D:\\repo\\src\\a'], ['/src/b']], true],
    [[['C:/elsewhere/a'], ['src/b']], false], // absolute outside the workspace
    [[['//server/share/a'], ['src/b']], false], // UNC
    [[['~/a'], ['src/b']], false],
  ];
  for (const [lists, expected] of ownership) {
    if (ownershipIsDisjoint(lists, 'D:\\repo\\') !== expected) {
      fail(`ownership ${JSON.stringify(lists)} should be ${expected ? 'ok' : 'rejected'}`);
    }
  }
  if (ownershipIsDisjoint([['D:/repo/src/a'], ['src/b']])) fail('absolute paths need a workspace to be judged');

  // 10d. A plan with overlapping ownership is refused: the task runs as ONE
  // worker, no parts are created.
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: parallel-overlap build the two-module widget with a shared index' }));
  await waitFor(
    'overlapping split plan rejected',
    (e) => e.type === 'activity' && e.entry.message.startsWith('split plan rejected (parts did not own non-empty, disjoint'),
  );
  const overlapDone = await waitFor(
    'overlap task done as a single worker',
    (e) => e.type === 'task.updated' && e.task.detail.startsWith('coding: parallel-overlap') && e.task.status === 'done',
    15000,
  );
  if (overlapDone.type !== 'task.updated') fail('unreachable');
  if (events.some((e) => e.type === 'task.updated' && e.task.title.startsWith('[part') && e.task.detail.includes('parallel-overlap'))) {
    fail('a rejected plan still created parts');
  }
  console.log('split validation ok: gate, ownership rules, overlapping plan ran unsplit');

  // 10e. Priority + 3-way split: with every slot busy, freed slots go to the
  // split's waiting parts before a task queued after them.
  const coding = events.findLast((e) => e.type === 'team.updated' && e.team.id === 'coding');
  const codingCap = coding?.type === 'team.updated' ? coding.team.maxConcurrentWorkers : 0;
  if (codingCap !== 3) fail(`priority scenario expects a coding cap of 3, got ${codingCap}`);
  // Start from an idle coding team: one slow holder + the 3-way split fill
  // all 3 slots, so part 3 waits in the priority line behind the holder.
  await waitIdle('coding team idle before the priority scenario', 'coding');
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding slow-test holder' }));
  await waitFor(
    'holder running',
    (e) => e.type === 'task.updated' && e.task.detail === 'coding slow-test holder' && e.task.status === 'in_flight',
  );
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding: parallel-wide slow-test build the three-module widget and its shared wiring' }));
  await waitFor(
    'wide split planned',
    (e) => e.type === 'activity' && e.entry.message.startsWith('split into 3 parallel parts'),
  );
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding late-queued item' }));
  await waitFor(
    'late task queued behind the split',
    (e) => e.type === 'task.updated' && e.task.detail === 'coding late-queued item' && e.task.status === 'queued',
  );
  await waitFor(
    'late task done',
    (e) => e.type === 'task.updated' && e.task.detail === 'coding late-queued item' && e.task.status === 'done',
    20000,
  );
  const firstRun = (test: (title: string, detail: string) => boolean) =>
    events.findIndex((e) => e.type === 'task.updated' && e.task.status === 'in_flight' && test(e.task.title, e.task.detail));
  const lateStart = firstRun((_title, detail) => detail === 'coding late-queued item');
  for (const k of [2, 3]) {
    const partStart = firstRun((title) => title.startsWith(`[part ${k}/3]`));
    if (partStart === -1 || partStart > lateStart) fail(`[part ${k}/3] should start before the later-queued task`);
  }
  await waitFor(
    'wide split integrated and done',
    (e) =>
      e.type === 'task.updated' &&
      e.task.detail.startsWith('coding: parallel-wide') &&
      !e.task.title.startsWith('[') &&
      e.task.status === 'done',
    20000,
  );
  console.log('split priority ok: 3-way split parts got freed slots before a later-queued task');
  // Let the QA follow-ups these scenarios queued drain, so later timings hold.
  await waitIdle('all teams idle after the split scenarios');

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

  // 22b. The same controls mid-split (3 slow parallel parts). Stop and
  // killall halt the parent and every piece with no integration run and no
  // leaked worker slot; pause lets running parts finish but holds the
  // integration until resume.
  const latestTasks = () => {
    const latest = new Map<string, Extract<HubEvent, { type: 'task.updated' }>['task']>();
    for (const e of events) if (e.type === 'task.updated') latest.set(e.task.id, e.task);
    return latest;
  };
  const integrationRan = (parentId: string) =>
    events.some((e) => e.type === 'activity' && e.entry.taskId === parentId && e.entry.message.startsWith('mock: model'));
  const startSlowSplit = async (marker: string, fromIdle = true): Promise<string> => {
    if (fromIdle) await waitIdle(`coding idle before the ${marker} split`, 'coding');
    ws.send(encodeCommand({ type: 'task.submit', text: `coding: parallel-wide slow-test ${marker} build the three-module widget and its shared wiring` }));
    const parent = await waitFor(
      `${marker} split planned`,
      (e) => e.type === 'task.updated' && e.task.detail.includes(`slow-test ${marker}`) && !e.task.parentTaskId && e.task.status === 'in_flight',
      15000,
    );
    if (parent.type !== 'task.updated') fail('unreachable');
    const id = parent.task.id;
    for (const k of [1, 2, 3]) {
      await waitFor(
        `${marker} part ${k} running`,
        (e) => e.type === 'task.updated' && e.task.parentTaskId === id && e.task.title.startsWith(`[part ${k}/3]`) && e.task.status === 'in_flight',
        15000,
      );
    }
    return id;
  };
  const expectHaltedSplit = async (marker: string, parentId: string): Promise<void> => {
    await waitFor(`${marker} parent stopped`, (e) => e.type === 'task.updated' && e.task.id === parentId && e.task.status === 'paused');
    await waitIdle(`coding idle after the ${marker} split`, 'coding');
    const pieces = [...latestTasks().values()].filter((task) => task.parentTaskId === parentId);
    if (pieces.length !== 3 || pieces.some((task) => task.status !== 'paused')) {
      fail(`${marker}: every piece should stop with the parent, got ${pieces.map((task) => `${task.title} [${task.status}]`).join('; ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (integrationRan(parentId)) fail(`${marker}: the integration ran after the split was halted`);
  };

  const stopId = await startSlowSplit('stop-split');
  ws.send(encodeCommand({ type: 'task.stop', taskId: stopId }));
  await expectHaltedSplit('stop-split', stopId);

  const pauseId = await startSlowSplit('pause-split');
  ws.send(encodeCommand({ type: 'tasks.control', action: 'pause' }));
  for (const k of [1, 2, 3]) {
    await waitFor(
      `pause-split part ${k} finished while paused`,
      (e) => e.type === 'task.updated' && e.task.parentTaskId === pauseId && e.task.title.startsWith(`[part ${k}/3]`) && e.task.status === 'done',
      15000,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (integrationRan(pauseId)) fail('pause-split: the integration started while paused');
  ws.send(encodeCommand({ type: 'tasks.control', action: 'resume' }));
  const pausedDone = await waitFor(
    'pause-split integrated after resume',
    (e) => e.type === 'task.updated' && e.task.id === pauseId && e.task.status === 'done',
    15000,
  );
  if (pausedDone.type !== 'task.updated' || pausedDone.task.tokensUsed !== 42 * 4) fail('pause-split parent should total 3 parts + integration');

  const killId = await startSlowSplit('kill-split');
  ws.send(encodeCommand({ type: 'tasks.control', action: 'killall' }));
  await expectHaltedSplit('kill-split', killId);

  // No slot leaked by any of that: with coding's cap at 4 (raised in 13), a
  // slow holder + a fresh 3-way split fill every slot at once — each part
  // starts before anything finishes.
  const coding4 = events.findLast((e) => e.type === 'team.updated' && e.team.id === 'coding');
  if (coding4?.type !== 'team.updated' || coding4.team.maxConcurrentWorkers !== 4) fail('leak check expects a coding cap of 4');
  await waitIdle('coding idle before the leak check', 'coding');
  ws.send(encodeCommand({ type: 'task.submit', text: 'coding slow-test leak-holder' }));
  const leakHolder = await waitFor(
    'leak holder running',
    (e) => e.type === 'task.updated' && e.task.detail === 'coding slow-test leak-holder' && e.task.status === 'in_flight',
  );
  if (leakHolder.type !== 'task.updated') fail('unreachable');
  const leakId = await startSlowSplit('leak-check', false);
  const leakPart3 = events.findIndex(
    (e) => e.type === 'task.updated' && e.task.parentTaskId === leakId && e.task.title.startsWith('[part 3/3]') && e.task.status === 'in_flight',
  );
  const firstLeakDone = events.findIndex(
    (e) =>
      e.type === 'task.updated' &&
      (e.task.id === leakHolder.task.id || e.task.parentTaskId === leakId) &&
      e.task.status === 'done',
  );
  if (firstLeakDone !== -1 && firstLeakDone < leakPart3) fail('a worker slot leaked: part 3 waited for another worker to finish');
  await waitFor('leak-check split done', (e) => e.type === 'task.updated' && e.task.id === leakId && e.task.status === 'done', 15000);
  console.log('split controls ok: stop / pause-resume / killall mid-split, no leaked slots');

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
  // 24. The PA team can always write its own desk (data/pa), even when the
  // conversation thread is on another project; other teams never get it.
  ws.send(
    encodeCommand({
      type: 'team.create',
      name: 'Personal Assistant team',
      charter: 'Todos, reminders, calendar, notes.',
      allowedTools: ['read', 'edit', 'web'],
      blockedTools: ['git', 'installs'],
    }),
  );
  await waitFor('PA team created', (e) => e.type === 'team.updated' && e.team.id === 'personal-assistant-team');
  const paDir = join(dataDir, 'pa');
  const scopeOf = (mark: number, label: string) =>
    waitFor(label, since(mark, (e) => e.type === 'activity' && e.entry.message.startsWith(`mock: workspace ${castleCwd} `)), 15000);
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars personal-assistant-team add eggs to my todos' }));
  const paScope = await scopeOf(mark, 'PA worker scope reported');
  if (paScope.type !== 'activity' || !paScope.entry.message.includes(paDir)) {
    fail(`PA worker in another project cannot write its desk: ${paScope.type === 'activity' ? paScope.entry.message : ''}`);
  }
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars coding: tweak the tower HUD again' }));
  const codingScope = await scopeOf(mark, 'coding worker scope reported');
  if (codingScope.type !== 'activity' || codingScope.entry.message.includes(paDir)) {
    fail('a non-PA worker was handed the PA desk');
  }
  console.log('PA desk scope ok: PA writes its desk from any project; other teams never get it');

  console.log('model choices ok: per-field precedence, exact id + effort reach the engine, Haiku effort dropped, persisted, reset restores defaults');

  // 25. Team rules: every team has a RULES.md (template, mirrored to clients);
  // a project's CLAUDE.md adds on top. A genuine conflict between the two
  // asks the owner once (two-answer card), the answer is saved to the team's
  // rules and reaches the worker, and a stopped card records nothing.
  const rulesPath = join(dataDir, 'teams', 'coding', 'RULES.md');
  const templateRules = readFileSync(rulesPath, 'utf8');
  if (!templateRules.includes('## Rules') || !templateRules.includes('## Resolved conflicts')) fail('RULES.md template missing its sections');
  const snapCoding = snapshot.snapshot.teams.find((team) => team.id === 'coding');
  if (snapCoding?.rules !== templateRules) fail('team record does not mirror RULES.md to clients');
  const codingRules = (test: (rules: string) => boolean) => (e: HubEvent) =>
    e.type === 'team.updated' && e.team.id === 'coding' && test(e.team.rules ?? '');
  // Team refs resolve by name too; the rule lands under "## Rules".
  ws.send(encodeCommand({ type: 'team.rules.add', teamId: 'Coding team', rule: 'Always indent with tabs (MOCK-CONFLICT)' }));
  await waitFor('rule added and mirrored', codingRules((rules) => rules.includes('- Always indent with tabs (MOCK-CONFLICT)')));
  const added = readFileSync(rulesPath, 'utf8');
  if (added.indexOf('- Always indent with tabs') > added.indexOf('## Resolved conflicts')) fail('rule appended outside ## Rules');

  const rulebookDir = mkdtempSync(join(tmpdir(), 'Rulebook-'));
  writeFileSync(join(rulebookDir, 'CLAUDE.md'), '# Rulebook\n\n- Indent with 2 spaces.\n');
  ws.send(encodeCommand({ type: 'project.register', name: 'Rulebook', workspaceDir: rulebookDir }));
  await waitFor('rulebook project registered', (e) => e.type === 'project.updated' && e.project.id === 'rulebook');

  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@rulebook coding: format the config loader' }));
  const ruleCard = await waitFor(
    'rule-conflict card',
    since(mark, (e) => e.type === 'permission.updated' && e.request.id.startsWith('rules-') && e.request.status === 'pending'),
    15000,
  );
  if (ruleCard.type !== 'permission.updated') fail('unreachable');
  const card = ruleCard.request;
  if (!card.choices || !card.choices[0].includes('Rulebook') || !/indent with tabs/i.test(card.summary ?? '') || !card.flags.includes('rule conflict')) {
    fail(`rule card is not a clear two-answer question: ${JSON.stringify(card)}`);
  }
  if (events.slice(mark).some((e) => e.type === 'activity' && e.entry.taskId === card.taskId && e.entry.message.startsWith('mock: model'))) {
    fail('the worker started before the owner settled the rule conflict');
  }
  ws.send(encodeCommand({ type: 'permission.respond', requestId: card.id, decision: 'approve', scope: 'once' }));
  await waitFor('worker sees the rules and the decision', since(mark, (e) => e.type === 'activity' && e.entry.message === 'mock: team rules 1 · decided 1'), 15000);
  const decidedFile = readFileSync(rulesPath, 'utf8');
  const resolvedPart = decidedFile.slice(decidedFile.indexOf('## Resolved conflicts'));
  if (!resolvedPart.includes("- [rulebook] indentation: follow Rulebook's rule")) fail(`answer not recorded under Resolved conflicts:\n${decidedFile}`);

  // Asked once: the next task in the same project goes straight to work.
  await waitIdle('rulebook task done', 'coding');
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@rulebook coding: format the config writer' }));
  await waitFor('second worker gets the saved decision', since(mark, (e) => e.type === 'activity' && e.entry.message === 'mock: team rules 1 · decided 1'), 15000);
  if (events.slice(mark).some((e) => e.type === 'permission.updated' && e.request.id.startsWith('rules-'))) fail('owner asked again about a settled conflict');
  // Another project sees the team rules but never Rulebook's decision.
  await waitIdle('second rulebook task done', 'coding');
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars coding: polish the tower sprites' }));
  await waitFor('other project: rules without the decision', since(mark, (e) => e.type === 'activity' && e.entry.message === 'mock: team rules 1 · decided 0'), 15000);

  // Hand edits in any editor reach the clients (watcher, ~3 s).
  await waitIdle('castlewars task done', 'coding');
  writeFileSync(rulesPath, readFileSync(rulesPath, 'utf8').replace('## Rules\n', '## Rules\n- Prefer small commits\n'));
  await waitFor('hand edit mirrored', codingRules((rules) => rules.includes('- Prefer small commits')), 8000);

  // Deleting the decision re-asks; stopping the task at the card records nothing.
  const withoutDecision = readFileSync(rulesPath, 'utf8').split('\n').filter((line) => !line.startsWith('- [rulebook]')).join('\n');
  ws.send(encodeCommand({ type: 'team.rules.set', teamId: 'coding', markdown: withoutDecision }));
  await waitFor('decision removed', codingRules((rules) => rules.includes('Prefer small commits') && !rules.includes('[rulebook]')));
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@rulebook coding: format the config reader' }));
  const reAsk = await waitFor(
    'deleted decision asks again',
    since(mark, (e) => e.type === 'permission.updated' && e.request.id.startsWith('rules-') && e.request.status === 'pending'),
    15000,
  );
  if (reAsk.type !== 'permission.updated') fail('unreachable');
  ws.send(encodeCommand({ type: 'task.stop', taskId: reAsk.request.taskId }));
  await waitFor('stopped at the rule card', since(mark, (e) => e.type === 'task.updated' && e.task.id === reAsk.request.taskId && e.task.status === 'paused'));
  await waitFor('rule card expired', since(mark, (e) => e.type === 'permission.updated' && e.request.id === reAsk.request.id && e.request.status === 'expired'));
  await settle();
  if (readFileSync(rulesPath, 'utf8').includes('[rulebook]')) fail('a stopped rule card recorded a decision');
  if (events.slice(mark).some((e) => e.type === 'activity' && e.entry.taskId === reAsk.request.taskId && e.entry.message.startsWith('mock: model'))) fail('a worker ran after its rule card was stopped');
  ws.send(encodeCommand({ type: 'team.rules.set', teamId: 'coding', markdown: templateRules }));
  await waitFor('coding rules restored', codingRules((rules) => rules === templateRules));
  console.log('team rules ok: RULES.md per team, mirrored + hand edits, conflict asked once with two answers, saved per project, stop records nothing');

  // 26. Team tools + connections + master rules. Tools live under "## Tools"
  // in a team's RULES.md and reach its workers; MCP connections are granted
  // by name from the PC's catalog (exactly those, nothing else); the master
  // has its own RULES.md, mirrored on HubInfo.
  if (!templateRules.includes('## Tools')) fail('team RULES.md template has no ## Tools section');
  const masterPath = join(dataDir, 'master', 'RULES.md');
  const masterTemplate = readFileSync(masterPath, 'utf8');
  for (const heading of ['## Routing', '## Handover', '## Splitting', '## When a task is stuck']) {
    if (!masterTemplate.includes(heading)) fail(`master RULES.md template missing ${heading}`);
  }
  const latestInfo = () => [...events].reverse().find((e) => e.type === 'hub.updated' || e.type === 'snapshot');
  const infoOf = (e: HubEvent | undefined) => (e?.type === 'hub.updated' ? e.info : e?.type === 'snapshot' ? e.snapshot.info : undefined);
  if (infoOf(latestInfo())?.masterRules !== masterTemplate) fail('master rules not mirrored on HubInfo');
  const catalog = infoOf(latestInfo())?.mcpCatalog ?? [];
  if (catalog.join(',') !== 'Fake_Figma,Fake_Studio') fail(`MCP catalog wrong: ${catalog.join(',')}`);

  ws.send(encodeCommand({ type: 'team.rules.add', teamId: 'design', section: 'tools', rule: 'magick (ImageMagick CLI): resize and convert images' }));
  await waitFor(
    'tool added under ## Tools',
    (e) => e.type === 'team.updated' && e.team.id === 'design' && (e.team.rules ?? '').includes('## Tools\n- magick (ImageMagick CLI)'),
  );
  ws.send(encodeCommand({ type: 'team.mcp.set', teamId: 'design', servers: ['Fake_Studio', 'Not_On_This_PC'] }));
  const granted = await waitFor('connection granted by name', (e) => e.type === 'team.updated' && e.team.id === 'design' && 'Fake_Studio' in e.team.mcpServers);
  if (granted.type !== 'team.updated' || Object.keys(granted.team.mcpServers).join(',') !== 'Fake_Studio') fail('unknown MCP name was granted');
  await waitFor('unknown connection reported', (e) => e.type === 'activity' && e.entry.message.includes('not configured on this PC: Not_On_This_PC'));
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars design: resize the icon sheet' }));
  await waitFor('worker sees its tools', since(mark, (e) => e.type === 'activity' && e.entry.message === 'mock: team tools 1'), 15000);
  await waitFor('worker gets exactly its connections', since(mark, (e) => e.type === 'activity' && e.entry.message === 'mock: mcp [Fake_Studio]'), 15000);
  await waitIdle('icon task done', 'design');
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars coding: tidy the tower module' }));
  await waitFor('ungranted team gets no connections', since(mark, (e) => e.type === 'activity' && e.entry.message === 'mock: mcp []'), 15000);
  ws.send(encodeCommand({ type: 'team.mcp.set', teamId: 'design', servers: [] }));
  await waitFor('connections cleared', (e) => e.type === 'team.updated' && e.team.id === 'design' && Object.keys(e.team.mcpServers).length === 0);

  // Master rules: /rule master/<section> lands in that section and on HubInfo.
  ws.send(encodeCommand({ type: 'team.rules.add', teamId: 'master', section: 'handover', rule: 'Icons always go to the design team' }));
  await waitFor('master rule mirrored', (e) => e.type === 'hub.updated' && (e.info.masterRules ?? '').includes('## Handover\n- Icons always go to the design team'));
  const masterParsed = parseRules(readFileSync(masterPath, 'utf8'));
  if (rulesFor(masterParsed, ['handover']).join() !== '[Handover] Icons always go to the design team') fail('handover rule not scoped to handovers');
  if (rulesFor(masterParsed, ['stuck']).length !== 0) fail('a handover rule leaked into the stuck pass');
  await waitIdle('tower task done', 'coding');
  console.log('team tools ok: ## Tools reach workers, MCP granted by name from the PC catalog (exactly those), master rules per section on HubInfo');

  // 27. Stuck tasks. A run that fails, or a report the lead calls stuck,
  // makes the master propose ONE way forward and ask (two-answer card);
  // approving runs it. A master rule can let it act without asking. Work a
  // recovery spawned never gets a second automatic pass.
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars coding: crash-test the build pipeline' }));
  const stuckCard = await waitFor(
    'stuck card after a crash',
    since(mark, (e) => e.type === 'permission.updated' && e.request.id.startsWith('stuck-') && e.request.status === 'pending'),
    15000,
  );
  if (stuckCard.type !== 'permission.updated') fail('unreachable');
  const crashed = stuckCard.request;
  if (crashed.choices?.join('|') !== 'Do it|Leave it' || !/got stuck/.test(crashed.summary ?? '') || !/hand it to the Design team/.test(crashed.summary ?? '')) {
    fail(`stuck card unclear: ${crashed.summary}`);
  }
  if (events.slice(mark).some((e) => e.type === 'task.updated' && e.task.title.startsWith('[handover]'))) fail('recovery ran before the owner answered');
  ws.send(encodeCommand({ type: 'permission.respond', requestId: crashed.id, decision: 'approve', scope: 'once' }));
  const handover = await waitFor(
    'approved handover ran',
    since(mark, (e) => e.type === 'task.updated' && e.task.title.startsWith('[handover]') && e.task.teamId === 'design' && e.task.status === 'done'),
    15000,
  );
  if (handover.type !== 'task.updated' || handover.task.projectId !== 'castlewars') fail('recovery left the stuck task\'s project');

  // Lead-flagged stuck + "Leave it": nothing runs.
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars coding: blocked-test the studio sync' }));
  const blockedCard = await waitFor(
    'stuck card from the lead review',
    since(mark, (e) => e.type === 'permission.updated' && e.request.id.startsWith('stuck-') && e.request.status === 'pending'),
    15000,
  );
  if (blockedCard.type !== 'permission.updated') fail('unreachable');
  const blockedTask = events.slice(mark).find((e) => e.type === 'task.updated' && e.task.id === blockedCard.request.taskId && e.task.status === 'failed');
  if (!blockedTask || blockedTask.type !== 'task.updated' || !blockedTask.task.synopsis?.startsWith('Stuck — ')) fail('lead-flagged stuck task not marked stuck');
  if (events.slice(mark).some((e) => e.type === 'task.updated' && e.task.title.startsWith('[QA]') && e.task.detail.includes('blocked-test'))) {
    fail('a stuck task was sent to QA');
  }
  ws.send(encodeCommand({ type: 'permission.respond', requestId: blockedCard.request.id, decision: 'deny', scope: 'once' }));
  await waitFor('left as is', since(mark, (e) => e.type === 'activity' && e.entry.message.startsWith('left as is:')));
  await settle();
  if (events.slice(mark).some((e) => e.type === 'task.updated' && /^\[(handover|retry)\]/.test(e.task.title))) fail('a declined recovery ran anyway');

  // A master rule lets it go ahead alone — here a split into two steps.
  ws.send(encodeCommand({ type: 'team.rules.add', teamId: 'master', section: 'stuck', rule: 'Go ahead without asking me (MOCK-AUTO)' }));
  await waitFor('stuck rule mirrored', (e) => e.type === 'hub.updated' && (e.info.masterRules ?? '').includes('MOCK-AUTO'));
  await waitIdle('coding idle before the auto recovery', 'coding');
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars coding: crash-test split-me the loader' }));
  await waitFor('auto recovery announced', since(mark, (e) => e.type === 'activity' && e.entry.message.includes('your master rules allow it without asking')), 15000);
  await waitFor('split step 2 done', since(mark, (e) => e.type === 'task.updated' && e.task.title.startsWith('Step 2/2') && e.task.teamId === 'coding' && e.task.status === 'done'), 20000);
  if (events.slice(mark).some((e) => e.type === 'permission.updated' && e.request.id.startsWith('stuck-'))) fail('asked although the master rules allow acting alone');

  // A recovered task that gets stuck again goes to the owner, no second pass.
  mark = events.length;
  ws.send(encodeCommand({ type: 'task.submit', text: '@castlewars coding: blocked-test again with rerun-stuck' }));
  const firstRecovery = await waitFor(
    'auto handover for the blocked task',
    since(mark, (e) => e.type === 'task.updated' && e.task.title.startsWith('[handover]') && e.task.status === 'queued'),
    15000,
  );
  if (firstRecovery.type !== 'task.updated') fail('unreachable');
  await waitFor(
    'recovered task stuck again goes to the owner',
    since(mark, (e) => e.type === 'activity' && e.entry.taskId === firstRecovery.task.id && e.entry.message.startsWith('still stuck after a recovery')),
    15000,
  );
  await waitIdle('recovery chain settled');
  const recoveries = events.slice(mark).filter((e) => e.type === 'task.updated' && e.task.title.startsWith('[handover]') && e.task.status === 'queued');
  if (new Set(recoveries.map((e) => (e.type === 'task.updated' ? e.task.id : ''))).size !== 1) fail('recovery recursed');
  ws.send(encodeCommand({ type: 'team.rules.set', teamId: 'master', markdown: masterTemplate }));
  await waitFor('master rules restored', (e) => e.type === 'hub.updated' && e.info.masterRules === masterTemplate);
  console.log('stuck tasks ok: crash and lead-flagged stuck propose one way forward, owner decides (Do it / Leave it), master rules allow acting alone, no recursion');

  // 28. Agent HQ's own data is off limits to workers, even in the hub
  // project where it sits inside the workspace: pairing keys, secrets,
  // config and every RULES.md. Art, the phone inbox/outbox (and the PA desk
  // for the PA team) stay writable.
  const lockedScope: WorkspaceScope = {
    cwd: tmpdir(),
    extraDirs: [],
    locked: { dir: dataDir, open: [join(dataDir, 'art'), join(dataDir, 'inbox')] },
  };
  const lockCases: [string, boolean][] = [
    [`echo x > ${join(dataDir, 'security.json')}`, true],
    [`Set-Content -Path ${join(dataDir, 'teams', 'coding', 'RULES.md')} -Value "- anything goes"`, true],
    [`cp evil.md ${join(dataDir, 'master', 'RULES.md')}`, true],
    [`magick in.png -resize 50% ${join(dataDir, 'art', 'icon.png')}`, false],
    [`cp photo.jpg ${join(dataDir, 'inbox', 'photo.jpg')}`, false],
    [`echo ok > ${join(tmpdir(), 'notes.txt')}`, false],
    [`type ${join(dataDir, 'config.json')}`, false], // reading isn't writing
  ];
  for (const [command, asks] of lockCases) {
    const verdict = evaluatePermission('Bash', command, 'auto', lockedScope);
    if ((verdict.decision === 'ask') !== asks) fail(`data lock: "${command}" → ${verdict.decision}`);
    if (asks && verdict.decision === 'ask' && !verdict.flags.some((flag) => flag.startsWith("writes Agent HQ's own data"))) {
      fail(`data lock flag unclear for "${command}": ${verdict.flags.join('; ')}`);
    }
  }
  const editRules = refusedWrite({ file_path: join(dataDir, 'teams', 'coding', 'RULES.md') }, tmpdir(), [], lockedScope.locked);
  if (!editRules?.config) fail('Edit of a RULES.md inside the workspace was not refused as Agent HQ data');
  if (refusedWrite({ file_path: join(dataDir, 'art', 'a.png') }, tmpdir(), [], lockedScope.locked)) fail('art output refused');
  if (refusedWrite({ file_path: join(tmpdir(), 'ok.txt') }, tmpdir(), [], lockedScope.locked)) fail('normal workspace write refused');
  console.log('data lock ok: workers cannot write Agent HQ data (keys, secrets, config, rules) — art/inbox stay open');

  // 29. Event log: rolls over instead of growing without bound, and appends
  // off the publish path so a busy run isn't paying for a sync write each
  // time. Driven directly — 8 MB of real events would be a slow smoke.
  const logDir = mkdtempSync(join(tmpdir(), 'agent-hq-log-'));
  writeFileSync(join(logDir, 'events.jsonl'), 'x'.repeat(9 * 1024 * 1024));
  const logBus = new HubBus();
  const stopLog = startEventLog(logBus, logDir);
  logBus.publish({ type: 'activity', entry: { agentId: 'master', taskId: null, message: 'after rotation', at: Date.now() } });
  // Nothing is written synchronously: the oversized log is still in place.
  if (readdirSync(logDir).some((name) => /^events-.+\.jsonl$/.test(name))) {
    fail('event log rotated on the publish path — the write should be deferred');
  }
  stopLog();
  const rolled = readdirSync(logDir).filter((name) => /^events-.+\.jsonl$/.test(name));
  if (rolled.length !== 1) fail(`expected exactly 1 rolled event log, got ${rolled.length}`);
  const liveLog = readFileSync(join(logDir, 'events.jsonl'), 'utf8');
  if (!liveLog.includes('after rotation')) fail('the event after rotation did not reach the fresh log');
  if (liveLog.length > 4096) fail('the fresh event log kept the rotated content');
  console.log('event log ok: rotates past 8 MB, keeps the tail, writes off the publish path');

  // 29b. The same rotation on the ASYNC path — the one a running hub actually
  // takes. Above only proves the shutdown flush rotates.
  const asyncDir = mkdtempSync(join(tmpdir(), 'agent-hq-log-async-'));
  writeFileSync(join(asyncDir, 'events.jsonl'), 'x'.repeat(9 * 1024 * 1024));
  const asyncBus = new HubBus();
  const stopAsync = startEventLog(asyncBus, asyncDir);
  asyncBus.publish({ type: 'activity', entry: { agentId: 'master', taskId: null, message: 'async roll', at: Date.now() } });
  await settle();
  if (readdirSync(asyncDir).filter((name) => /^events-.+\.jsonl$/.test(name)).length !== 1) {
    fail('the timed flush did not roll the oversized log');
  }
  if (!readFileSync(join(asyncDir, 'events.jsonl'), 'utf8').includes('async roll')) {
    fail('the event that triggered the async rotation never reached the fresh log');
  }
  stopAsync();

  // 29c. Pruning: only the newest KEEP_ROLLED_LOGS rolled files survive.
  const pruneDir = mkdtempSync(join(tmpdir(), 'agent-hq-log-prune-'));
  const stale = [1, 2, 3, 4, 5].map((n) => `events-2020-01-0${n}T00-00-00-000Z.jsonl`);
  for (const name of stale) writeFileSync(join(pruneDir, name), 'old\n');
  writeFileSync(join(pruneDir, 'events.jsonl'), 'x'.repeat(9 * 1024 * 1024));
  const pruneBus = new HubBus();
  const stopPrune = startEventLog(pruneBus, pruneDir);
  pruneBus.publish({ type: 'activity', entry: { agentId: 'master', taskId: null, message: 'prune me', at: Date.now() } });
  await settle();
  stopPrune();
  const kept = readdirSync(pruneDir).filter((name) => /^events-.+\.jsonl$/.test(name)).sort();
  if (kept.length !== 3) fail(`expected 3 rolled logs after pruning, got ${kept.length}: ${kept.join(', ')}`);
  if (kept.some((name) => stale.slice(0, 3).includes(name))) fail(`pruning kept the oldest logs: ${kept.join(', ')}`);
  if (!kept.includes(stale[3]!) || !kept.includes(stale[4]!)) fail(`pruning dropped the newest rolled logs: ${kept.join(', ')}`);

  // 29d. A rotation that FAILS — Windows hands out EPERM whenever anything
  // still holds the file — must not take the log with it. It used to drop the
  // buffered batch AND every batch after it, so the log died silently for the
  // rest of the run. Injected, because a real EPERM can't be staged here.
  const stuckDir = mkdtempSync(join(tmpdir(), 'agent-hq-log-stuck-'));
  const stuckPath = join(stuckDir, 'events.jsonl');
  writeFileSync(stuckPath, 'x'.repeat(9 * 1024 * 1024));
  let rotateAttempts = 0;
  const stuckBus = new HubBus();
  const stopStuck = startEventLog(stuckBus, stuckDir, () => {
    rotateAttempts += 1;
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  });
  for (const message of ['stuck one', 'stuck two', 'stuck three']) {
    stuckBus.publish({ type: 'activity', entry: { agentId: 'master', taskId: null, message, at: Date.now() } });
    await settle();
  }
  stopStuck();
  const stuckLog = readFileSync(stuckPath, 'utf8');
  for (const message of ['stuck one', 'stuck two', 'stuck three']) {
    if (!stuckLog.includes(message)) fail(`"${message}" was lost — a failed rotation must not drop a batch`);
  }
  if (readdirSync(stuckDir).some((name) => /^events-.+\.jsonl$/.test(name))) fail('the failed rotation rolled a file anyway');
  // …and it backs off instead of retrying (and re-warning) on every flush.
  if (rotateAttempts !== 1) fail(`a failed rotation should back off, not retry each flush (tried ${rotateAttempts}x)`);
  console.log('event log ok: async rotation, pruning to 3, and a failed rotation loses no events');

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
