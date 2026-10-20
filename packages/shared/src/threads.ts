import type { Task, TaskStatus } from './schema.js';

// One window per ask. A QA pass, a handover to another team, a recovery move,
// a later step of a plan and a split piece are STEPS of the owner's ask
// (Task.rootTaskId), not tasks of their own: lists show the ask once — live
// with whatever step is working, tokens summed — and its console carries
// every step's rows.

const LIVE: TaskStatus[] = ['intake', 'routing', 'queued', 'in_flight', 'awaiting_permission', 'review'];
// Which live status speaks for the ask when several steps run at once.
const RANK: Partial<Record<TaskStatus, number>> = { awaiting_permission: 5, in_flight: 4, review: 4, queued: 2, routing: 1, intake: 1 };

export const isLiveStatus = (status: TaskStatus): boolean => LIVE.includes(status);

export interface AskView extends Task {
  steps: Task[]; // oldest first
  current: Task | null; // the step working now (not the ask itself), if any
  liveSteps: number; // steps working right now
}

// Steps whose ask isn't in the list (older data) stand on their own.
export function foldAsks(tasks: Task[]): AskView[] {
  const ids = new Set(tasks.map((task) => task.id));
  const isStep = (task: Task) => !!task.rootTaskId && task.rootTaskId !== task.id && ids.has(task.rootTaskId);
  const steps = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!isStep(task)) continue;
    const list = steps.get(task.rootTaskId!) ?? [];
    list.push(task);
    steps.set(task.rootTaskId!, list);
  }
  return tasks
    .filter((task) => !isStep(task))
    .map((root) => {
      const own = (steps.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
      if (own.length === 0) return { ...root, steps: [], current: null, liveSteps: 0 };
      const live = [root, ...own].filter((task) => isLiveStatus(task.status)).sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0));
      const lead = live[0] ?? null;
      const current = lead && lead.id !== root.id ? lead : null;
      return {
        ...root,
        status: lead ? lead.status : root.status,
        teamId: current ? current.teamId : root.teamId,
        agentIds: current ? current.agentIds : root.agentIds,
        progressPct: current ? current.progressPct : root.progressPct,
        tokensUsed: root.tokensUsed + own.reduce((sum, step) => sum + step.tokensUsed, 0),
        updatedAt: Math.max(root.updatedAt, ...own.map((step) => step.updatedAt)),
        steps: own,
        current,
        liveSteps: own.filter((step) => isLiveStatus(step.status)).length,
      };
    });
}

// "QA check", "part 1/2", "handover", or the step's own title.
export function stepKind(step: Pick<Task, 'title'>): string {
  const tag = step.title.match(/^\[([^\]]+)\]\s*/)?.[1];
  if (!tag) return step.title.slice(0, 50);
  if (/^QA$/i.test(tag)) return 'QA check';
  if (/^fix\d*$/i.test(tag)) return 'fix';
  return tag.toLowerCase();
}
