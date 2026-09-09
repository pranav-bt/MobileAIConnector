import type {
  Agent,
  AgentStatus,
  ModelTier,
  PermissionRequest,
  Task,
  Team,
} from '@agent-hq/shared';
import type { HubBus } from './bus.js';
import type { CommandHandlers } from './commands.js';

// Demo mode replays the concept-mockup scenario as live data so the office
// can be seen (and interacted with) without spending any real usage. It
// implements the same CommandHandlers interface as the real engine, so the
// desktop app cannot tell the difference.

export interface DemoOptions {
  fast?: boolean; // shrink timers for smoke tests
}

const now = () => Date.now();

function team(partial: Partial<Team> & Pick<Team, 'id' | 'name' | 'charter'>): Team {
  return {
    allowedTools: ['read', 'edit', 'bash'],
    blockedTools: ['installs'],
    leadModel: 'opus',
    workerModel: 'sonnet',
    maxConcurrentWorkers: 2,
    quotaSharePct: 20,
    memoryDir: `teams/${partial.id}`,
    createdAt: now(),
    ...partial,
  };
}

function agent(
  partial: Partial<Agent> & Pick<Agent, 'id' | 'name' | 'role'> & { model?: ModelTier },
): Agent {
  return {
    teamId: null,
    status: 'idle',
    activity: '',
    model: partial.model ?? 'sonnet',
    taskId: null,
    tokensUsed: 0,
    updatedAt: now(),
    ...partial,
  };
}

function task(partial: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    detail: '',
    projectId: null,
    teamId: null,
    status: 'queued',
    progressPct: 0,
    agentIds: [],
    synopsis: null,
    tokensUsed: 0,
    createdAt: now(),
    updatedAt: now(),
    ...partial,
  };
}

export function startDemo(bus: HubBus, options: DemoOptions = {}): {
  handlers: CommandHandlers;
  stop: () => void;
} {
  const speed = options.fast ? 0.05 : 1;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms * speed));
  let taskCounter = 18;

  // --- Seed: teams -----------------------------------------------------
  for (const t of [
    team({ id: 'coding', name: 'Coding team', charter: 'Builds and tests the code.', allowedTools: ['read', 'edit', 'bash', 'git'] }),
    team({ id: 'design', name: 'Design team', charter: 'Mockups, visual assets, UI reviews.', allowedTools: ['read', 'browser', 'docs'] }),
    team({ id: 'tools', name: 'Tools team', charter: 'Installs and system access — most gated.', allowedTools: ['read', 'bash', 'installs'], blockedTools: [] }),
  ]) {
    bus.publish({ type: 'team.updated', team: t });
  }

  // --- Seed: agents ----------------------------------------------------
  const seedAgents: Agent[] = [
    agent({ id: 'master', name: 'MASTER', role: 'master', model: 'opus', status: 'working', activity: 'routing task #18 → coding' }),
    agent({ id: 'c-lead', name: 'C-Lead', role: 'lead', teamId: 'coding', model: 'opus', status: 'working', activity: 'reviewing C-1 output', taskId: 't17' }),
    agent({ id: 'c1', name: 'Worker C-1', role: 'worker', teamId: 'coding', status: 'working', activity: 'running test suite · 54%', taskId: 't17' }),
    agent({ id: 'c2', name: 'Worker C-2', role: 'worker', teamId: 'coding', status: 'working', activity: 'editing api/auth.ts', taskId: 't17' }),
    agent({ id: 'c3', name: 'Worker C-3', role: 'worker', teamId: 'coding', status: 'working', activity: 'setting up e2e harness', taskId: 't17' }),
    agent({ id: 'd-lead', name: 'D-Lead', role: 'lead', teamId: 'design', model: 'opus', status: 'working', activity: 'reviewing hero draft', taskId: 't16' }),
    agent({ id: 'd1', name: 'Worker D-1', role: 'worker', teamId: 'design', status: 'working', activity: 'drafting landing hero v2', taskId: 't16' }),
    agent({ id: 't-lead', name: 'T-Lead', role: 'lead', teamId: 'tools', model: 'opus', status: 'idle', activity: 'standing by' }),
    agent({ id: 'w4', name: 'Worker W-4', role: 'worker', status: 'idle', activity: 'idle · spun down' }),
    agent({ id: 'w5', name: 'Worker W-5', role: 'worker', status: 'idle', activity: 'idle · spun down' }),
    agent({ id: 'freelancer-1', name: 'claude — Claude Code', role: 'freelancer', status: 'working', activity: 'D:\\PersonalWork\\MobileAIConnector · working' }),
  ];
  for (const a of seedAgents) bus.publish({ type: 'agent.updated', agent: a });

  // --- Seed: projects, tasks, usage -------------------------------------
  for (const p of [
    { id: 'p-api', name: 'Mobile API auth', quotaTokens: 3_600_000, usedTokens: 2_100_000, alerted75: false },
    { id: 'p-beatbox', name: 'BeatBox', quotaTokens: 2_700_000, usedTokens: 1_100_000, alerted75: false },
    { id: 'p-ops', name: 'Ops & chores', quotaTokens: 1_000_000, usedTokens: 860_000, alerted75: true },
  ]) {
    bus.publish({ type: 'project.updated', project: p });
  }

  for (const t of [
    task({ id: 't17', title: 'Add auth to mobile API', projectId: 'p-api', teamId: 'coding', status: 'in_flight', progressPct: 62, agentIds: ['c-lead', 'c1', 'c2', 'c3'] }),
    task({ id: 't16', title: 'Landing page concepts', projectId: 'p-beatbox', teamId: 'design', status: 'in_flight', progressPct: 38, agentIds: ['d-lead', 'd1'] }),
    task({ id: 't15', title: 'Audit npm scripts', projectId: 'p-ops', teamId: 'tools', status: 'queued' }),
    task({ id: 't14', title: 'Fix flaky CI tests', teamId: 'coding', status: 'done', progressPct: 100, synopsis: 'Root cause was a shared port between two suites; tests now allocate ports dynamically. 3 files changed, all green.' }),
    task({ id: 't13', title: 'Refactor build scripts', teamId: 'tools', status: 'done', progressPct: 100, synopsis: 'Consolidated 6 npm scripts into 3; CI time down 22%.' }),
  ]) {
    bus.publish({ type: 'task.updated', task: t });
  }

  bus.publish({
    type: 'usage.updated',
    usage: {
      windowPct: 34,
      windowResetsAt: now() + 3 * 60 * 60 * 1000,
      weeklyPct: 41,
      weeklyResetsAt: now() + 4 * 24 * 60 * 60 * 1000,
      tokensToday: 3_800_000,
      modelMixPct: { opus: 18, sonnet: 63, haiku: 19 },
      overageEnabled: false,
    },
  });

  const patchAgent = (id: string, patch: Partial<Agent>) => {
    const current = bus.state.agents[id];
    if (current) bus.publish({ type: 'agent.updated', agent: { ...current, ...patch, updatedAt: now() } });
  };
  const patchTask = (id: string, patch: Partial<Task>) => {
    const current = bus.state.tasks[id];
    if (current) bus.publish({ type: 'task.updated', task: { ...current, ...patch, updatedAt: now() } });
  };

  // --- The scripted moment: C-3 raises a hand ---------------------------
  later(() => {
    const request: PermissionRequest = {
      id: 'perm-1',
      taskId: 't17',
      agentId: 'c3',
      teamId: 'coding',
      command: 'npm install playwright',
      flags: ['network access', 'writes node_modules', 'reversible'],
      reason: 'Playwright is needed to run the end-to-end test suite this task adds. It installs as a dev dependency only.',
      status: 'pending',
      scope: 'once',
      requestedAt: now(),
      resolvedAt: null,
    };
    bus.publish({ type: 'permission.updated', request });
    patchAgent('c3', { status: 'waiting_permission', activity: 'waiting on your approval' });
    patchTask('t17', { status: 'awaiting_permission' });
  }, 6000);

  // --- Ambient motion ----------------------------------------------------
  let tick = 0;
  const interval = setInterval(() => {
    tick += 1;
    const c1 = bus.state.agents['c1'];
    if (c1 && c1.status === 'working') {
      const pct = Math.min(54 + tick * 2, 96);
      patchAgent('c1', { activity: `running test suite · ${pct}%` });
    }
    const t17 = bus.state.tasks['t17'];
    if (t17 && t17.status === 'in_flight') {
      patchTask('t17', { progressPct: Math.min(t17.progressPct + 1, 95) });
    }
    const masterLines = [
      'routing task #18 → coding',
      'compiling synopsis for task #14',
      'watching quota burn — on pace',
    ];
    patchAgent('master', { activity: masterLines[tick % masterLines.length] });
  }, 2500 * speed);

  // --- Command handlers (same interface as the real engine) --------------
  const handlers: CommandHandlers = {
    submitTask(text) {
      taskCounter += 1;
      const id = `t${taskCounter}`;
      bus.publish({ type: 'task.updated', task: task({ id, title: text, status: 'routing' }) });
      patchAgent('master', { activity: `routing task #${taskCounter} → coding` });
      later(() => {
        patchTask(id, { teamId: 'coding', status: 'in_flight', agentIds: ['c2'], progressPct: 5 });
        patchAgent('c2', { activity: `picking up: ${text.slice(0, 40)}`, taskId: id });
        bus.publish({ type: 'activity', entry: { agentId: 'master', taskId: id, message: `assigned to Coding team`, at: now() } });
      }, 2000);
    },

    respondPermission(requestId, decision) {
      const request = bus.state.permissions[requestId];
      if (!request || request.status !== 'pending') return;
      bus.publish({
        type: 'permission.updated',
        request: { ...request, status: decision === 'approve' ? 'approved' : 'denied', resolvedAt: now() },
      });
      const nextStatus: AgentStatus = 'working';
      patchAgent(request.agentId, {
        status: nextStatus,
        activity: decision === 'approve' ? 'npm install playwright · resuming e2e setup' : 'denied — writing a manual test runner instead',
      });
      patchTask(request.taskId, { status: 'in_flight' });
    },

    createTeam(input) {
      const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `team-${now()}`;
      const created = team({
        id,
        name: input.name,
        charter: input.charter,
        allowedTools: input.allowedTools,
        blockedTools: input.blockedTools,
        workerModel: input.workerModel ?? 'sonnet',
        quotaSharePct: input.quotaSharePct ?? 10,
      });
      bus.publish({ type: 'team.updated', team: created });
      bus.publish({
        type: 'agent.updated',
        agent: agent({ id: `${id}-lead`, name: `${input.name} Lead`, role: 'lead', teamId: id, model: 'opus', activity: 'standing by' }),
      });
    },

  };

  return {
    handlers,
    stop: () => {
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
