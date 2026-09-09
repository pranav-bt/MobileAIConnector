import type { Agent, PermissionRequest, Task, Team } from '@agent-hq/shared';
import type { HubBus } from '../bus.js';
import type { CommandHandlers } from '../commands.js';
import type { OrchestratorEngine } from './types.js';

// Engine-mode command handlers: real agents doing real work. v1 routing is
// deliberately naive (keyword -> team, else coding); the master agent takes
// over intake in the orchestrator milestone.

const now = () => Date.now();

export function createEngineHandlers(
  bus: HubBus,
  engine: OrchestratorEngine,
  cwd: string,
): CommandHandlers {
  let taskCounter = 0;
  let workerCounter = 0;
  const pendingResolvers = new Map<string, (decision: 'approve' | 'deny') => void>();

  const publishAgent = (agent: Agent) => bus.publish({ type: 'agent.updated', agent });
  const publishTask = (task: Task) => bus.publish({ type: 'task.updated', task });
  const patchAgent = (id: string, patch: Partial<Agent>) => {
    const current = bus.state.agents[id];
    if (current) publishAgent({ ...current, ...patch, updatedAt: now() });
  };
  const patchTask = (id: string, patch: Partial<Task>) => {
    const current = bus.state.tasks[id];
    if (current) publishTask({ ...current, ...patch, updatedAt: now() });
  };

  function pickTeam(text: string): Team | null {
    const teams = Object.values(bus.state.teams);
    const lowered = text.toLowerCase();
    const byName = teams.find((team) => lowered.includes(team.name.toLowerCase().split(' ')[0] ?? ''));
    return byName ?? teams.find((team) => team.id === 'coding') ?? teams[0] ?? null;
  }

  return {
    submitTask(text) {
      taskCounter += 1;
      workerCounter += 1;
      const taskId = `task-${now()}-${taskCounter}`;
      const team = pickTeam(text);
      if (!team) {
        console.warn('[hub] no teams configured; cannot route task');
        return;
      }
      const workerId = `${team.id}-w${workerCounter}`;

      publishTask({
        id: taskId,
        title: text.slice(0, 80),
        detail: text,
        projectId: null,
        teamId: team.id,
        status: 'in_flight',
        progressPct: 0,
        agentIds: [workerId],
        synopsis: null,
        tokensUsed: 0,
        createdAt: now(),
        updatedAt: now(),
      });
      publishAgent({
        id: workerId,
        name: `Worker ${workerId.toUpperCase()}`,
        role: 'worker',
        teamId: team.id,
        status: 'working',
        activity: 'starting…',
        model: team.workerModel,
        taskId,
        tokensUsed: 0,
        updatedAt: now(),
      });

      void engine
        .runWorker({
          prompt: text,
          team,
          model: team.workerModel,
          cwd,
          callbacks: {
            onActivity: (message) => {
              patchAgent(workerId, { activity: message.slice(0, 90), status: 'working' });
              bus.publish({ type: 'activity', entry: { agentId: workerId, taskId, message, at: now() } });
            },
            onTokens: (totalTokens) => {
              patchAgent(workerId, { tokensUsed: totalTokens });
              patchTask(taskId, { tokensUsed: totalTokens });
            },
            onPermission: ({ command, reason }) => {
              const requestId = `perm-${now()}`;
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
              bus.publish({ type: 'permission.updated', request });
              patchAgent(workerId, { status: 'waiting_permission', activity: 'waiting on your approval' });
              patchTask(taskId, { status: 'awaiting_permission' });
              return new Promise((resolve) => pendingResolvers.set(requestId, resolve));
            },
          },
        })
        .then(({ synopsis }) => {
          patchTask(taskId, { status: 'done', progressPct: 100, synopsis: synopsis || null });
          patchAgent(workerId, { status: 'idle', activity: 'done', taskId: null });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          patchTask(taskId, { status: 'failed', synopsis: `Failed: ${message}` });
          patchAgent(workerId, { status: 'blocked', activity: message.slice(0, 90) });
        });
    },

    respondPermission(requestId, decision) {
      const request = bus.state.permissions[requestId];
      if (!request || request.status !== 'pending') return;
      bus.publish({
        type: 'permission.updated',
        request: { ...request, status: decision === 'approve' ? 'approved' : 'denied', resolvedAt: now() },
      });
      patchAgent(request.agentId, { status: 'working', activity: decision === 'approve' ? 'approved — continuing' : 'denied — adjusting approach' });
      patchTask(request.taskId, { status: 'in_flight' });
      const resolve = pendingResolvers.get(requestId);
      if (resolve) {
        pendingResolvers.delete(requestId);
        resolve(decision);
      }
    },

    createTeam(input) {
      const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `team-${now()}`;
      bus.publish({
        type: 'team.updated',
        team: {
          id,
          name: input.name,
          charter: input.charter,
          allowedTools: input.allowedTools,
          blockedTools: input.blockedTools,
          leadModel: 'opus',
          workerModel: input.workerModel ?? 'sonnet',
          maxConcurrentWorkers: 2,
          quotaSharePct: input.quotaSharePct ?? 10,
          memoryDir: `teams/${id}`,
          createdAt: now(),
        },
      });
    },

    killConnection() {
      // Wired to key revocation in the security milestone.
      bus.publish({
        type: 'activity',
        entry: { agentId: 'master', taskId: null, message: 'kill switch pressed — device key revocation lands with the security milestone', at: now() },
      });
    },
  };
}
