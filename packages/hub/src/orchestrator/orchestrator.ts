import type { Agent, ModelTier, PermissionRequest, Task, Team, Usage } from '@agent-hq/shared';
import type { HubBus } from '../bus.js';
import type { CommandHandlers } from '../commands.js';
import type { OrchestratorEngine } from '../engine/types.js';
import { reviewWorkerReport, routeTask } from './master.js';
import type { TeamRegistry } from './teams.js';

// The real thing: master intake -> team lead -> worker -> lead review ->
// synopsis. Per-team concurrency respected; overflow queues. Every state
// change is a bus event, so the office renders it live.

const now = () => Date.now();
const MAX_LOUNGE_IDLE = 3;

export class Orchestrator implements CommandHandlers {
  #bus: HubBus;
  #engine: OrchestratorEngine;
  #registry: TeamRegistry;
  #workspaceDir: string;

  #taskCounter = 0;
  #workerCounters = new Map<string, number>();
  #activeWorkers = new Map<string, number>();
  #queues = new Map<string, string[]>();
  #pendingResolvers = new Map<string, (decision: 'approve' | 'deny') => void>();
  #controllers = new Map<string, AbortController>();
  #stopping = new Set<string>();
  #routingCount = 0;
  #tokensByModel: Record<ModelTier, number> = { opus: 0, sonnet: 0, haiku: 0 };

  constructor(bus: HubBus, engine: OrchestratorEngine, registry: TeamRegistry, workspaceDir: string) {
    this.#bus = bus;
    this.#engine = engine;
    this.#registry = registry;
    this.#workspaceDir = workspaceDir;
  }

  init(): void {
    for (const team of this.#registry.all()) {
      this.#bus.publish({ type: 'team.updated', team });
      this.#publishAgent({
        id: `${team.id}-lead`,
        name: `${team.name.replace(/ team$/i, '')} Lead`,
        role: 'lead',
        teamId: team.id,
        status: 'idle',
        activity: 'standing by',
        model: team.leadModel,
        taskId: null,
        tokensUsed: 0,
        updatedAt: now(),
      });
    }
    this.#publishAgent({
      id: 'master',
      name: 'MASTER',
      role: 'master',
      teamId: null,
      status: 'idle',
      activity: 'standing by',
      model: 'opus',
      taskId: null,
      tokensUsed: 0,
      updatedAt: now(),
    });
  }

  // Restore token counters from a persisted usage snapshot (per-tier split
  // reconstructed from the mix percentages — close enough for meters).
  seedUsage(usage: Usage): void {
    const total = usage.tokensToday;
    this.#tokensByModel = {
      opus: Math.round((total * usage.modelMixPct.opus) / 100),
      sonnet: Math.round((total * usage.modelMixPct.sonnet) / 100),
      haiku: Math.round((total * usage.modelMixPct.haiku) / 100),
    };
  }

  // --- helpers -----------------------------------------------------------

  #publishAgent(agent: Agent): void {
    this.#bus.publish({ type: 'agent.updated', agent });
  }

  #publishTask(task: Task): void {
    this.#bus.publish({ type: 'task.updated', task });
  }

  #patchAgent(id: string, patch: Partial<Agent>): void {
    const current = this.#bus.state.agents[id];
    if (current) this.#publishAgent({ ...current, ...patch, updatedAt: now() });
  }

  #patchTask(id: string, patch: Partial<Task>): void {
    const current = this.#bus.state.tasks[id];
    if (current) this.#publishTask({ ...current, ...patch, updatedAt: now() });
  }

  #activity(agentId: string, taskId: string | null, message: string): void {
    this.#bus.publish({ type: 'activity', entry: { agentId, taskId, message, at: now() } });
  }

  #recordTokens(model: ModelTier, tokens: number): void {
    if (tokens <= 0) return;
    this.#tokensByModel[model] += tokens;
    const total = this.#tokensByModel.opus + this.#tokensByModel.sonnet + this.#tokensByModel.haiku;
    const pct = (tier: ModelTier) => (total > 0 ? Math.round((this.#tokensByModel[tier] / total) * 100) : 0);
    this.#bus.publish({
      type: 'usage.updated',
      usage: {
        ...this.#bus.state.usage,
        tokensToday: total,
        modelMixPct: { opus: pct('opus'), sonnet: pct('sonnet'), haiku: pct('haiku') },
      },
    });
  }

  #masterStatus(): void {
    const inFlight = Object.values(this.#bus.state.tasks).filter((task) =>
      ['in_flight', 'awaiting_permission', 'review'].includes(task.status),
    ).length;
    if (this.#routingCount > 0) return; // routing activity is already showing
    this.#patchAgent('master', {
      status: inFlight > 0 ? 'working' : 'idle',
      activity: inFlight > 0 ? `watching ${inFlight} task${inFlight > 1 ? 's' : ''} in flight` : 'standing by',
    });
  }

  // --- commands ----------------------------------------------------------

  submitTask(text: string): void {
    void this.#intake(text);
  }

  stopTask(taskId: string): void {
    const task = this.#bus.state.tasks[taskId];
    if (!task || ['done', 'failed', 'paused'].includes(task.status)) return;
    this.#stopping.add(taskId);

    // Unblock a worker parked on a permission (as a denial), expire the card.
    for (const request of Object.values(this.#bus.state.permissions)) {
      if (request.taskId !== taskId || request.status !== 'pending') continue;
      this.#bus.publish({
        type: 'permission.updated',
        request: { ...request, status: 'expired', resolvedAt: now() },
      });
      const resolve = this.#pendingResolvers.get(request.id);
      if (resolve) {
        this.#pendingResolvers.delete(request.id);
        resolve('deny');
      }
    }

    const controller = this.#controllers.get(taskId);
    if (controller) controller.abort();
    else this.#patchTask(taskId, { status: 'paused', synopsis: 'Stopped by you.' }); // queued/routing — no worker yet
    // If the task was queued, drop it from its team's queue.
    if (task.teamId) {
      const queue = this.#queues.get(task.teamId);
      if (queue) this.#queues.set(task.teamId, queue.filter((queued) => queued !== taskId));
    }
    this.#activity('master', taskId, `task stopped by you: ${task.title.slice(0, 50)}`);
  }

  async #intake(text: string): Promise<void> {
    this.#taskCounter += 1;
    const taskId = `t-${now().toString(36)}-${this.#taskCounter}`;
    this.#publishTask({
      id: taskId,
      title: text.slice(0, 60),
      detail: text,
      projectId: null,
      teamId: null,
      status: 'routing',
      progressPct: 0,
      agentIds: [],
      synopsis: null,
      tokensUsed: 0,
      createdAt: now(),
      updatedAt: now(),
    });

    this.#routingCount += 1;
    this.#patchAgent('master', { status: 'working', activity: `routing: ${text.slice(0, 50)}` });

    const decision = await routeTask(this.#engine, this.#registry.all(), text);
    this.#recordTokens('opus', decision.tokens);
    this.#routingCount -= 1;

    const team = this.#registry.get(decision.teamId);
    if (!team) {
      this.#patchTask(taskId, { status: 'failed', synopsis: 'Routing failed: no team available.' });
      this.#masterStatus();
      return;
    }

    this.#patchTask(taskId, { teamId: team.id, title: decision.title });
    this.#activity(
      'master',
      taskId,
      `routed "${decision.title}" → ${team.name}${decision.fallback ? ' (keyword fallback)' : ''}`,
    );

    const active = this.#activeWorkers.get(team.id) ?? 0;
    if (active >= team.maxConcurrentWorkers) {
      this.#patchTask(taskId, { status: 'queued' });
      const queue = this.#queues.get(team.id) ?? [];
      queue.push(taskId);
      this.#queues.set(team.id, queue);
    } else {
      void this.#runTask(taskId, team);
    }
    this.#masterStatus();
  }

  async #runTask(taskId: string, team: Team): Promise<void> {
    const task = this.#bus.state.tasks[taskId];
    if (!task) return;

    this.#activeWorkers.set(team.id, (this.#activeWorkers.get(team.id) ?? 0) + 1);
    const workerNumber = (this.#workerCounters.get(team.id) ?? 0) + 1;
    this.#workerCounters.set(team.id, workerNumber);
    const workerId = `${team.id}-w${workerNumber}`;
    const workerName = `Worker ${(team.name[0] ?? 'X').toUpperCase()}-${workerNumber}`;

    this.#publishAgent({
      id: workerId,
      name: workerName,
      role: 'worker',
      teamId: team.id,
      status: 'working',
      activity: 'starting…',
      model: team.workerModel,
      taskId,
      tokensUsed: 0,
      updatedAt: now(),
    });
    this.#patchTask(taskId, { status: 'in_flight', agentIds: [`${team.id}-lead`, workerId], progressPct: 5 });
    this.#patchAgent(`${team.id}-lead`, { status: 'working', activity: `briefing ${workerName}`, taskId });

    const controller = new AbortController();
    this.#controllers.set(taskId, controller);

    try {
      const result = await this.#engine.runWorker({
        prompt: task.detail,
        team,
        model: team.workerModel,
        cwd: this.#workspaceDir,
        signal: controller.signal,
        callbacks: {
          onActivity: (message) => {
            this.#patchAgent(workerId, { status: 'working', activity: message.slice(0, 90) });
            this.#activity(workerId, taskId, message);
            const current = this.#bus.state.tasks[taskId];
            if (current && current.status === 'in_flight' && current.progressPct < 90) {
              this.#patchTask(taskId, { progressPct: current.progressPct + 5 });
            }
          },
          onTokens: (totalTokens) => {
            const previous = this.#bus.state.agents[workerId]?.tokensUsed ?? 0;
            this.#patchAgent(workerId, { tokensUsed: totalTokens });
            this.#patchTask(taskId, { tokensUsed: totalTokens });
            this.#recordTokens(team.workerModel, totalTokens - previous);
          },
          onPermission: ({ command, reason }) => this.#raisePermission(taskId, workerId, team, command, reason),
        },
      });

      if (this.#stopping.has(taskId)) {
        this.#patchTask(taskId, { status: 'paused', synopsis: 'Stopped by you.' });
        this.#patchAgent(workerId, { status: 'idle', activity: 'task stopped', taskId: null });
        return;
      }

      // Lead review: the worker's report becomes the synopsis the owner reads.
      this.#patchTask(taskId, { status: 'review', progressPct: 95 });
      this.#patchAgent(workerId, { status: 'reporting', activity: 'reporting to lead' });
      this.#patchAgent(`${team.id}-lead`, { status: 'working', activity: `reviewing: ${task.title.slice(0, 40)}` });
      const review = await reviewWorkerReport(this.#engine, team, task.title, result.synopsis);
      this.#recordTokens(team.leadModel, review.tokens);

      this.#patchTask(taskId, { status: 'done', progressPct: 100, synopsis: review.synopsis || null });
      this.#activity(`${team.id}-lead`, taskId, `report filed: ${task.title.slice(0, 50)}`);
    } catch (error) {
      if (this.#stopping.has(taskId)) {
        this.#patchTask(taskId, { status: 'paused', synopsis: 'Stopped by you.' });
        this.#patchAgent(workerId, { status: 'idle', activity: 'task stopped', taskId: null });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.#patchTask(taskId, { status: 'failed', synopsis: `Failed: ${message}` });
        this.#patchAgent(workerId, { status: 'blocked', activity: message.slice(0, 90) });
      }
    } finally {
      this.#controllers.delete(taskId);
      this.#stopping.delete(taskId);
      this.#patchAgent(`${team.id}-lead`, { status: 'idle', activity: 'standing by', taskId: null });
      this.#retireWorker(workerId);
      this.#activeWorkers.set(team.id, Math.max(0, (this.#activeWorkers.get(team.id) ?? 1) - 1));
      this.#masterStatus();
      this.#drainQueue(team.id);
    }
  }

  // Finished workers head to the lounge; the lounge keeps only the last few.
  #retireWorker(workerId: string): void {
    const worker = this.#bus.state.agents[workerId];
    if (!worker || worker.status === 'blocked') return;
    this.#patchAgent(workerId, { teamId: null, status: 'idle', activity: 'idle · spun down', taskId: null });
    const idle = Object.values(this.#bus.state.agents)
      .filter((agent) => agent.role === 'worker' && agent.teamId === null && agent.status === 'idle')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (idle.length > MAX_LOUNGE_IDLE) {
      const oldest = idle.shift();
      if (oldest) this.#bus.publish({ type: 'agent.removed', agentId: oldest.id });
    }
  }

  #drainQueue(teamId: string): void {
    const team = this.#registry.get(teamId);
    const queue = this.#queues.get(teamId) ?? [];
    if (!team || queue.length === 0) return;
    if ((this.#activeWorkers.get(teamId) ?? 0) >= team.maxConcurrentWorkers) return;
    const nextTaskId = queue.shift();
    if (nextTaskId) void this.#runTask(nextTaskId, team);
  }

  #raisePermission(
    taskId: string,
    workerId: string,
    team: Team,
    command: string,
    reason: string,
  ): Promise<'approve' | 'deny'> {
    const requestId = `perm-${now().toString(36)}-${workerId}`;
    const request: PermissionRequest = {
      id: requestId,
      taskId,
      agentId: workerId,
      teamId: team.id,
      command,
      flags: [],
      reason,
      status: 'pending',
      scope: 'once',
      requestedAt: now(),
      resolvedAt: null,
    };
    this.#bus.publish({ type: 'permission.updated', request });
    this.#patchAgent(workerId, { status: 'waiting_permission', activity: 'waiting on your approval' });
    this.#patchTask(taskId, { status: 'awaiting_permission' });
    return new Promise((resolve) => this.#pendingResolvers.set(requestId, resolve));
  }

  respondPermission(requestId: string, decision: 'approve' | 'deny'): void {
    const request = this.#bus.state.permissions[requestId];
    if (!request || request.status !== 'pending') return;
    this.#bus.publish({
      type: 'permission.updated',
      request: { ...request, status: decision === 'approve' ? 'approved' : 'denied', resolvedAt: now() },
    });
    this.#patchAgent(request.agentId, {
      status: 'working',
      activity: decision === 'approve' ? 'approved — continuing' : 'denied — adjusting approach',
    });
    this.#patchTask(request.taskId, { status: 'in_flight' });
    const resolve = this.#pendingResolvers.get(requestId);
    if (resolve) {
      this.#pendingResolvers.delete(requestId);
      resolve(decision);
    }
  }

  createTeam(input: {
    name: string;
    charter: string;
    allowedTools: string[];
    blockedTools: string[];
    workerModel?: ModelTier;
    quotaSharePct?: number;
  }): void {
    const team = this.#registry.add(input);
    this.#bus.publish({ type: 'team.updated', team });
    this.#publishAgent({
      id: `${team.id}-lead`,
      name: `${team.name.replace(/ team$/i, '')} Lead`,
      role: 'lead',
      teamId: team.id,
      status: 'idle',
      activity: 'standing by',
      model: team.leadModel,
      taskId: null,
      tokensUsed: 0,
      updatedAt: now(),
    });
    this.#activity('master', null, `new team created: ${team.name}`);
  }
}
