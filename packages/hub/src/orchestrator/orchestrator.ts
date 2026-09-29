import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_DEFAULTS, isInternalTask, resolveModel, type Agent, type ModelOverrides, type ModelSpec, type ModelTier, type PermissionRequest, type Task, type Team, type Usage } from '@agent-hq/shared';
import type { HubBus } from '../bus.js';
import type { CommandHandlers } from '../commands.js';
import type { OrchestratorEngine } from '../engine/types.js';
import {
  coordinateFollowUp,
  evaluateQaReport,
  planParallelSplit,
  reviewWorkerReport,
  routeTask,
  type ParallelPlan,
  type PlanStep,
} from './master.js';
import { capturePcScreen, saveIncomingFile, shareFile } from '../files.js';
import { evaluatePermission } from './policy.js';
import { delay, isInside } from './util.js';
import type { PermissionMode } from '../config.js';
import type { TeamRegistry } from './teams.js';
import type { ProjectRegistry } from './projects.js';

// The real thing: master intake -> team lead -> worker -> lead review ->
// synopsis. Per-team concurrency respected; overflow queues. Every state
// change is a bus event, so the office renders it live.

const now = () => Date.now();
const MAX_LOUNGE_IDLE = 3;
// Upper bound on parallel parts per split, whatever the team's worker cap.
const MAX_PARALLEL_PARTS = 4;
// A split piece's unreviewed report, as kept on the piece and handed to the
// integration worker (capped so N reports keep its prompt bounded).
const MAX_PIECE_REPORT = 4000;
// Titles the split pass never splits: QA passes, QA remediation ([fix],
// [fix2]…) and split pieces.
const UNSPLITTABLE_TITLE = /^\[(QA|fix\d*|part|scaffold)\b/i;
// Cheap gate before the split pass: short asks without build language never
// fan out, so the split check only runs on plausible big builds.
const BUILD_WORDS = /\b(build|implement|create|develop|scaffold|port|rewrite|set up)\b/i;
// The task-text half of the split gate (the team half lives on the class).
export function splitWorthChecking(title: string, detail: string): boolean {
  if (UNSPLITTABLE_TITLE.test(title)) return false;
  const words = detail.split(/\s+/).filter(Boolean).length;
  return words >= 8 && (words >= 60 || BUILD_WORDS.test(detail));
}

interface RunOptions {
  slotHeld?: boolean;
  keepSlot?: boolean;
  noSplit?: boolean;
  startPct?: number;
}

interface SlotWaiter {
  taskId: string;
  parentId: string;
  resolve: (claimed: boolean) => void;
}

// The PA desk, as the orchestrator sees it.
interface PaDeskLike {
  setEnabled(enabled: boolean): void;
  add(kind: 'todo' | 'reminder' | 'event' | 'note', text: string, atMs?: number, endMs?: number): void;
  toggleTodo(id: string): void;
  remove(kind: 'todo' | 'reminder' | 'event', id: string): void;
  listAdd(list: string, text: string): void;
  listRemove(list: string, index: number): void;
  paths: { dir: string; todos: string; reminders: string; calendar: string; notes: string };
}

// The freelancer manager, as the orchestrator sees it.
interface FreelancerRunner {
  describe(agentId: string): { name: string; cwd: string } | null;
  runInstruction(
    agentId: string,
    text: string,
  ): Promise<{ ok: true; name: string; reply: string } | { ok: false; name: string; error: string }>;
  killAll?(): void;
}

// Synthetic team for freelancer work: gives the standard review prompt a
// charter/lead, and satisfies the QA gate (freelancers build and run things).
// It is NOT in the registry — no room is rendered for it.
const FREELANCE_DESK: Team = {
  id: 'freelance',
  name: 'Freelance desk',
  charter:
    'Independent Claude Code terminal sessions supervised directly by the owner; each works inside its own project.',
  allowedTools: ['read', 'edit', 'bash', 'git'],
  blockedTools: [],
  leadModel: 'opus',
  workerModel: 'sonnet',
  maxConcurrentWorkers: 8,
  quotaSharePct: 0,
  memoryDir: '',
  mcpServers: {},
  createdAt: 0,
};

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
  #qaSource = new Map<string, string>(); // [QA] taskId -> source taskId
  #scaleAsked = new Set<string>(); // teams with an open scale-up card
  // Lead split pass, all cleared when the split ends: split parent -> its
  // part/scaffold tasks (stops cascade), the integration brief the parent's
  // final worker gets, and per team the split pieces waiting for a slot
  // (served before the ordinary queue).
  #splitChildren = new Map<string, string[]>();
  #integrationBriefs = new Map<string, string>();
  #slotWaiters = new Map<string, SlotWaiter[]>();
  // Global pause: nothing new starts (everything queues); running work
  // finishes. killall stops running work too.
  #pausedAll = false;
  // Follow-up generation per task (0 = user-submitted). QA passes, fixes,
  // and master-dispatched handovers each add one; past MAX the master stops
  // spawning and escalates to the owner instead of looping.
  #taskDepth = new Map<string, number>();
  // Where each running worker is working — the freelancer observer skips
  // these dirs so hub workers don't double as "freelancers".
  #runningCwds = new Map<string, string>();
  #routingCount = 0;
  #tokensByModel: Record<ModelTier, number> = { opus: 0, sonnet: 0, haiku: 0 };
  // Owner's model choices (a layer over defaults; see ModelOverridesSchema).
  #models: ModelOverrides = { teams: {} };
  #onModelsChange: (overrides: ModelOverrides) => void = () => {};

  #projects: ProjectRegistry;
  #policy: { mode: PermissionMode };
  #onPermissionModeChange: (mode: PermissionMode) => void;
  #outboxDir: string;
  #inboxDir: string;

  constructor(
    bus: HubBus,
    engine: OrchestratorEngine,
    registry: TeamRegistry,
    projects: ProjectRegistry,
    workspaceDir: string,
    policy: { mode: PermissionMode } = { mode: 'auto' },
    onPermissionModeChange: (mode: PermissionMode) => void = () => {},
    outboxDir = '',
    inboxDir = '',
  ) {
    this.#bus = bus;
    this.#engine = engine;
    this.#registry = registry;
    this.#projects = projects;
    this.#workspaceDir = workspaceDir;
    this.#policy = policy;
    this.#onPermissionModeChange = onPermissionModeChange;
    this.#outboxDir = outboxDir;
    this.#inboxDir = inboxDir;
  }

  // Every completed code task gets a QA follow-up; make sure a QA team exists.
  #ensureQaTeam(): void {
    const existing = this.#registry.all().find((team) => /\bqa\b|test/i.test(team.id) || /\bqa\b|test/i.test(team.name));
    if (existing) return;
    this.createTeam({
      name: 'QA team',
      charter:
        "Tests completed work: runs the project's REAL tests and the app itself in its proper environment " +
        '(build it, launch it, exercise the feature). Verifies correctness and edge cases, hunts bugs, and ' +
        'ALWAYS checks performance. Reports pass/fail with concrete findings.',
      allowedTools: ['read', 'bash', 'git'],
      blockedTools: [],
    });
  }

  init(): void {
    for (const project of this.#projects.all()) {
      this.#bus.publish({ type: 'project.updated', project });
    }
    for (const team of this.#registry.all()) {
      this.#bus.publish({ type: 'team.updated', team });
      this.#publishAgent({
        id: `${team.id}-lead`,
        name: `${team.name.replace(/ team$/i, '')} Lead`,
        role: 'lead',
        teamId: team.id,
        status: 'idle',
        activity: 'standing by',
        model: this.#leadSpec(team).tier,
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
      model: this.#masterModel().tier,
      taskId: null,
      tokensUsed: 0,
      updatedAt: now(),
    });
    this.#ensureQaTeam();
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
    if (!current) return;
    const next: Task = { ...current, ...patch, updatedAt: now() };
    // A stopped or failed task has nobody working on it: drop its agents so
    // the office and the Today panel read "paused", not "2 agents". (Done
    // tasks keep theirs — freelancer remediation resumes that same session.)
    if (patch.status && ['paused', 'failed'].includes(patch.status) && next.agentIds.length > 0) {
      next.agentIds = [];
    }
    this.#publishTask(next);
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

  // Project isolation: a worker's tools reach its OWN project workspace (its
  // cwd) and nothing else — never a sibling project's tree. Handing out the
  // workspace roots here used to give every worker write access to every
  // other project, which is how a task pinned to one project wrote into
  // another. The only extras are the hub's phone inbox/outbox, which workers
  // in every project are told to use by name.
  #extraDirs(cwd: string): string[] {
    const extras = [this.#outboxDir, this.#inboxDir].filter(Boolean);
    return [...new Set(extras)].filter((dir) => existsSync(dir) && !isInside(dir, cwd));
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

  activeWorkerCwds(): string[] {
    return [...this.#runningCwds.values()];
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
    else this.#patchTask(taskId, { status: 'paused', synopsis: 'Stopped by you.' }); // queued/routing/split — no worker yet
    // A split task's parallel parts stop with it; pieces waiting for a slot
    // give up their place in line.
    this.#cancelSlotWaiters(taskId);
    for (const childId of this.#splitChildren.get(taskId) ?? []) this.stopTask(childId);
    // If the task was queued, drop it from its team's queue.
    if (task.teamId) {
      const queue = this.#queues.get(task.teamId);
      if (queue) this.#queues.set(task.teamId, queue.filter((queued) => queued !== taskId));
    }
    this.#activity('master', taskId, `task stopped by you: ${task.title.slice(0, 50)}`);
  }

  async #intake(rawText: string): Promise<void> {
    // "@<project> do something" pins the task to a project explicitly.
    let text = rawText.trim();
    let forcedProjectId: string | null = null;
    const atMatch = text.match(/^@(\S+)\s+([\s\S]+)$/);
    if (atMatch && atMatch[1] && atMatch[2]) {
      const forced = this.#projects.find(atMatch[1]);
      if (forced) {
        forcedProjectId = forced.id;
        text = atMatch[2].trim();
      }
    }

    this.#taskCounter += 1;
    const taskId = `t-${now().toString(36)}-${this.#taskCounter}`;
    this.#publishTask({
      id: taskId,
      title: text.slice(0, 60),
      detail: text,
      projectId: forcedProjectId,
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

    const masterModel = this.#masterModel();
    const decision = await routeTask(
      this.#engine,
      this.#registry.all(),
      this.#projects.all(),
      this.#projects.defaultProject().id,
      text,
      forcedProjectId,
      masterModel,
    );
    this.#recordTokens(masterModel.tier, decision.tokens);
    this.#routingCount -= 1;

    const team = this.#registry.get(decision.teamId);
    if (!team) {
      this.#patchTask(taskId, { status: 'failed', synopsis: 'Routing failed: no team available.' });
      this.#masterStatus();
      return;
    }

    const project = this.#projects.get(decision.projectId) ?? this.#projects.defaultProject();

    if (decision.steps) {
      void this.#runChain(taskId, decision.steps, project.id, decision.title);
      this.#masterStatus();
      return;
    }

    this.#patchTask(taskId, { teamId: team.id, projectId: project.id, title: decision.title });
    this.#activity(
      'master',
      taskId,
      `routed "${decision.title}" → ${team.name} · ${project.name}${decision.fallback ? ' (keyword fallback)' : ''}`,
    );

    this.#startOrQueue(taskId, team, true);
    this.#masterStatus();
  }

  // Sequenced multi-team plan: each step runs after the previous one and
  // receives its synopsis as a handover; QA follows only the final step.
  async #runChain(firstTaskId: string, steps: PlanStep[], projectId: string, overallTitle: string): Promise<void> {
    this.#activity(
      'master',
      firstTaskId,
      `plan for "${overallTitle}": ${steps.map((step, index) => `${index + 1}. ${this.#registry.get(step.teamId)?.name ?? step.teamId}`).join(' → ')}`,
    );

    let handover: string | null = null;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!;
      const team = this.#registry.get(step.teamId);
      if (!team) break;
      const isLast = index === steps.length - 1;
      const detail = handover
        ? `${step.instruction}\n\nHandover from the previous step (${handover}`
        : step.instruction;

      const taskId = index === 0 ? firstTaskId : `t-${now().toString(36)}-${++this.#taskCounter}`;
      const record: Task = {
        id: taskId,
        title: `Step ${index + 1}/${steps.length} — ${step.title}`.slice(0, 60),
        detail,
        projectId,
        teamId: team.id,
        status: 'queued',
        progressPct: 0,
        agentIds: [],
        synopsis: null,
        tokensUsed: 0,
        createdAt: this.#bus.state.tasks[taskId]?.createdAt ?? now(),
        updatedAt: now(),
      };
      this.#publishTask(record);

      // Respect the team's concurrency cap without jumping its queue forever.
      while (this.#pausedAll || (this.#activeWorkers.get(team.id) ?? 0) >= team.maxConcurrentWorkers) {
        if (this.#stopping.has(taskId) || ['paused', 'failed'].includes(this.#bus.state.tasks[taskId]?.status ?? '')) return;
        await delay(2000);
      }
      const synopsis = await this.#runTask(taskId, team, isLast);
      if (synopsis === null) {
        this.#activity('master', taskId, `plan halted at step ${index + 1}/${steps.length}`);
        return;
      }
      handover = `${team.name} team): ${synopsis.replace(/\s+/g, ' ').slice(0, 600)}`;
    }
    this.#activity('master', null, `plan complete: ${overallTitle}`);
  }

  // The worker's context, cheapest layer first: task text, recent synopses
  // from the SAME project only, and the team's durable notes. Projects never
  // see each other's history; everything is capped so tokens stay flat.
  #buildWorkerPrompt(task: Task): string {
    const sections = [task.detail];
    const integrationBrief = this.#integrationBriefs.get(task.id);
    if (integrationBrief) sections.push('', integrationBrief);
    const history = Object.values(this.#bus.state.tasks)
      .filter((t) => t.projectId === task.projectId && t.status === 'done' && t.id !== task.id && t.synopsis && !isInternalTask(t))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3);
    const teamMemory = task.teamId ? this.#registry.readMemory(task.teamId) : '';
    if (history.length > 0 || teamMemory) {
      sections.push('---', 'Background context (not part of the task itself):');
      if (history.length > 0) {
        sections.push(
          'Recent work in this project:',
          ...history.map((t) => `- ${t.title}: ${(t.synopsis ?? '').replace(/\s+/g, ' ').slice(0, 300)}`),
        );
      }
      if (teamMemory) sections.push('Team notes:', teamMemory);
    }
    if (this.#projects.roots.length > 0) {
      const workspaceDir =
        ((task.projectId ? this.#projects.get(task.projectId) : undefined) ?? this.#projects.defaultProject())
          .workspaceDir || this.#workspaceDir;
      const rootList = this.#projects.roots.map((root) => `${root.path} (${root.label})`).join(' · ');
      sections.push(
        `File locations policy: your file tools are scoped to THIS project's workspace — ${workspaceDir} — including ALL subdirectories at any depth; recurse into them when searching. ` +
          'Other projects are off limits: never read, write or create files outside this workspace, even when a report or note mentions their paths. ' +
          `If a task needs a folder that isn't this project, stop and say so in your report — ask the owner to register it (/project add <name> <path>, inside ${rootList}) rather than reaching into it. ` +
          'NEVER kill or restart the Agent HQ hub (port 4517) — you are running INSIDE it and would kill your own task; when hub code changes need a restart, say so in your report and the owner restarts it.',
      );
    }
    if (this.#outboxDir) {
      sections.push(
        `To send a file or screenshot to the owner's phone, copy it into: ${this.#outboxDir} (it is pushed automatically and removed).`,
      );
    }
    if (this.#inboxDir) {
      sections.push(
        `Files the owner sent from their phone are in: ${this.#inboxDir} — when the task mentions a sent/attached/shared file or image, look there (newest first).`,
      );
    }
    // Text-producing teams (no shell): the words ARE the product.
    if (task.teamId && !(this.#registry.get(task.teamId)?.allowedTools.includes('bash') ?? true)) {
      sections.push(
        'Your final message IS the deliverable the owner reads: include the complete findings/answer ' +
          '(with sources and links where relevant), never just a note that you finished.',
      );
    }
    if (this.#pa) {
      sections.push(
        `Shared owner notes (facts & preferences other teams recorded) live at: ${this.#pa.paths.notes} — consult them when a task depends on the owner's context.`,
      );
      // The PA team manages the desk's stores directly — plain files; the
      // hub's own clock fires reminders/alerts, no polling needed.
      if (task.teamId && /assistant/i.test(task.teamId)) {
        const paths = this.#pa.paths;
        sections.push(
          'You run the PA desk. Its stores are plain files you edit directly (the hub clock fires reminders/event alerts automatically — never poll):\n' +
            `- Todos: ${paths.todos} — [{id, text, done, createdAt}]\n` +
            `- Reminders: ${paths.reminders} — [{id, text, atMs}] (atMs = epoch milliseconds; fired ones gain firedAt)\n` +
            `- Calendar (custom, the only calendar we use): ${paths.calendar} — [{id, title, startMs, endMs?}] ` +
            '(endMs makes an event SPAN days — use one spanning event for a trip plus per-day events for its itinerary items; the owner sees them in a calendar view)\n' +
            `- Owner notes: ${paths.notes} — durable facts/preferences, one bullet per line.\n` +
            `- Reference lists (games to play, movies, books, etc.): any ${paths.dir}\\<name>.json holding a plain ` +
            'array of strings shows up automatically in the PA tab as its own list. Create one directly when the ' +
            'owner wants something tracked as a simple reference list rather than a to-do — no code change needed, ' +
            'and no done state or tags.\n' +
            'When asked to add/complete/list/reschedule any of these, edit the files; when summarizing (agenda, open todos), read them.',
        );
      }
    }
    return sections.join('\n');
  }

  // Returns the final synopsis on success, or null if the task failed or was
  // stopped (chains use this to decide whether to continue).
  // Split plumbing (opts): `slotHeld` — the caller already counted this run's
  // worker slot; `keepSlot` — leave the slot counted afterwards (the caller
  // hands it on or frees it); `noSplit` — skip the split pass; `startPct` —
  // progress to resume from (an integration run continues its parts' 70%).
  async #runTask(taskId: string, team: Team, autoQa = true, opts: RunOptions = {}): Promise<string | null> {
    const workerSpec = this.#workerSpec(team);
    const leadSpec = this.#leadSpec(team);
    const task = this.#bus.state.tasks[taskId];
    if (!task) {
      if (opts.slotHeld && !opts.keepSlot) this.#freeSlot(team.id);
      return null;
    }
    // Must stay synchronous up to the slot increment below (callers check the
    // cap, then call) — the split pass takes over the slot the same way.
    if (!opts.noSplit && this.#shouldPlanSplit(task, team)) return this.#planAndRun(taskId, team, autoQa);
    let outcome: string | null = null;
    const project = (task.projectId ? this.#projects.get(task.projectId) : undefined) ?? this.#projects.defaultProject();
    // An internal split piece: no lead review, no sub-agents, and its tokens
    // roll up into the parent. The task's tokensUsed accumulates across runs
    // (an integration run starts from its parts' total).
    const piece = isInternalTask(task);
    const baseTokens = task.tokensUsed;

    if (!opts.slotHeld) this.#takeSlot(team.id);
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
      model: workerSpec.tier,
      taskId,
      tokensUsed: 0,
      updatedAt: now(),
    });
    this.#patchTask(taskId, { status: 'in_flight', agentIds: [`${team.id}-lead`, workerId], progressPct: opts.startPct ?? 5 });
    this.#patchAgent(`${team.id}-lead`, { status: 'working', activity: `briefing ${workerName}`, taskId });

    const controller = new AbortController();
    this.#controllers.set(taskId, controller);
    this.#runningCwds.set(taskId, project.workspaceDir || this.#workspaceDir);

    try {
      const result = await this.#engine.runWorker({
        prompt: this.#buildWorkerPrompt(task),
        team,
        model: workerSpec,
        cwd: project.workspaceDir || this.#workspaceDir,
        extraDirs: this.#extraDirs(project.workspaceDir || this.#workspaceDir),
        ...(piece ? { maxSubagents: 0 } : {}),
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
            this.#patchTask(taskId, { tokensUsed: baseTokens + totalTokens });
            const parent = task.parentTaskId ? this.#bus.state.tasks[task.parentTaskId] : undefined;
            if (parent) this.#patchTask(parent.id, { tokensUsed: parent.tokensUsed + totalTokens - previous });
            this.#recordTokens(workerSpec.tier, totalTokens - previous);
            const ledger = this.#projects.addTokens(project.id, totalTokens - previous);
            if (ledger) {
              this.#bus.publish({ type: 'project.updated', project: ledger.project });
              if (ledger.crossed75) {
                this.#activity('master', taskId, `project "${ledger.project.name}" crossed 75% of its token quota`);
              }
            }
          },
          onPermission: ({ toolName, command, reason }) => {
            const verdict = evaluatePermission(toolName, command, this.#policy.mode);
            if (verdict.decision === 'allow') return Promise.resolve('approve' as const);
            return this.#raisePermission(taskId, workerId, team, command, reason, verdict.flags);
          },
        },
      });

      if (this.#stopping.has(taskId)) {
        this.#patchTask(taskId, { status: 'paused', synopsis: 'Stopped by you.' });
        this.#patchAgent(workerId, { status: 'idle', activity: 'task stopped', taskId: null });
        return null;
      }

      // A split piece's raw report goes straight to the integration worker;
      // only the integrated whole gets the lead's review.
      if (piece) {
        const report = result.synopsis.trim().slice(0, MAX_PIECE_REPORT) || 'Finished without a written report.';
        this.#patchTask(taskId, { status: 'done', progressPct: 100, synopsis: report });
        this.#activity(`${team.id}-lead`, taskId, `part report in: ${task.title.slice(0, 50)}`);
        return report;
      }

      // Lead review: the worker's report becomes the synopsis the owner reads.
      this.#patchTask(taskId, { status: 'review', progressPct: 95 });
      this.#patchAgent(workerId, { status: 'reporting', activity: 'reporting to lead' });
      this.#patchAgent(`${team.id}-lead`, { status: 'working', activity: `reviewing: ${task.title.slice(0, 40)}` });
      const review = await reviewWorkerReport(this.#engine, team, task.title, result.synopsis, leadSpec);
      this.#recordTokens(leadSpec.tier, review.tokens);
      if (review.memoryNote) {
        this.#registry.appendMemory(team.id, review.memoryNote);
        this.#activity(`${team.id}-lead`, taskId, `noted for the team: ${review.memoryNote.slice(0, 80)}`);
      }

      this.#patchTask(taskId, { status: 'done', progressPct: 100, synopsis: review.synopsis || null });
      this.#activity(`${team.id}-lead`, taskId, `report filed: ${task.title.slice(0, 50)}`);
      outcome = review.synopsis || '';

      // Text work (research, briefs, docs): the full report is the product —
      // save it permanently and push a copy to the phone via the outbox.
      if (!team.allowedTools.includes('bash') && result.synopsis.trim().length > 300) {
        this.#deliverReport(task, team, result.synopsis, review.synopsis);
      }

      if (autoQa) this.#enqueueQa(taskId, team, review.synopsis);
      // A finished QA task gets a verdict: pass, or a remediation round.
      // Everything else gets the master's coordination pass: does the report
      // hand work to a different team?
      if (task.title.startsWith('[QA]')) void this.#handleQaOutcome(taskId, review.synopsis);
      else if (autoQa) void this.#coordinate(taskId, team, review.synopsis);
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
      this.#runningCwds.delete(taskId);
      this.#stopping.delete(taskId);
      this.#patchAgent(`${team.id}-lead`, { status: 'idle', activity: 'standing by', taskId: null });
      this.#retireWorker(workerId);
      if (!opts.keepSlot) this.#freeSlot(team.id, false);
      this.#masterStatus();
      if (!opts.keepSlot) this.#drainQueue(team.id);
    }
    return outcome;
  }

  // --- lead split pass ---------------------------------------------------
  // Big build tasks fan out: the lead plans a shared contract + disjoint
  // parts, an optional scaffold runs first, the parts run on parallel workers
  // (each a visible task), and one integration worker then merges, tests and
  // commits as the original task — so review/QA/coordination see one report.

  #shouldPlanSplit(task: Task, team: Team): boolean {
    return (
      team.allowedTools.includes('bash') &&
      team.maxConcurrentWorkers >= 2 &&
      team.id !== this.#qaTeam()?.id &&
      splitWorthChecking(task.title, task.detail)
    );
  }

  #halted(taskId: string): boolean {
    return this.#stopping.has(taskId) || ['paused', 'failed'].includes(this.#bus.state.tasks[taskId]?.status ?? '');
  }

  #takeSlot(teamId: string): void {
    this.#activeWorkers.set(teamId, (this.#activeWorkers.get(teamId) ?? 0) + 1);
  }

  #freeSlot(teamId: string, drain = true): void {
    this.#activeWorkers.set(teamId, Math.max(0, (this.#activeWorkers.get(teamId) ?? 1) - 1));
    if (drain) this.#drainQueue(teamId);
  }

  // Claims a worker slot for a split piece (counted in #activeWorkers until
  // freed). No free slot: it waits in the team's priority line, which
  // #drainQueue serves before the ordinary queue. Resolves false, holding
  // nothing, if the piece or its parent is stopped first.
  #claimSlot(taskId: string, team: Team, parentId: string): Promise<boolean> {
    if (this.#halted(taskId) || this.#halted(parentId)) return Promise.resolve(false);
    const waiters = this.#slotWaiters.get(team.id) ?? [];
    if (!this.#pausedAll && waiters.length === 0 && (this.#activeWorkers.get(team.id) ?? 0) < team.maxConcurrentWorkers) {
      this.#takeSlot(team.id);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.#slotWaiters.set(team.id, [...waiters, { taskId, parentId, resolve }]);
      this.#drainQueue(team.id); // no-op unless a slot is already free
    });
  }

  #cancelSlotWaiters(taskId: string): void {
    for (const [teamId, waiters] of this.#slotWaiters) {
      const kept = waiters.filter((waiter) => {
        if (waiter.taskId !== taskId && waiter.parentId !== taskId) return true;
        waiter.resolve(false);
        return false;
      });
      if (kept.length > 0) this.#slotWaiters.set(teamId, kept);
      else this.#slotWaiters.delete(teamId);
    }
  }

  async #planAndRun(taskId: string, team: Team, autoQa: boolean): Promise<string | null> {
    const task = this.#bus.state.tasks[taskId]!;
    const leadId = `${team.id}-lead`;
    // The split decision is a quick check (haiku by default), not a lead-model
    // call — it runs on every plausible build task.
    const checkSpec = this.#checksModel();
    // Hold the caller's slot while the lead plans so the queue can't overbook;
    // it then passes to the single worker, or through the split's pieces.
    this.#takeSlot(team.id);
    this.#patchTask(taskId, { status: 'in_flight', agentIds: [leadId], progressPct: 2 });
    this.#patchAgent(leadId, { status: 'working', activity: `planning: ${task.title.slice(0, 40)}`, taskId });
    const maxParts = Math.min(MAX_PARALLEL_PARTS, team.maxConcurrentWorkers);
    const project = (task.projectId ? this.#projects.get(task.projectId) : undefined) ?? this.#projects.defaultProject();
    const result = await planParallelSplit(
      this.#engine,
      team,
      task.title,
      task.detail,
      maxParts,
      checkSpec,
      project.workspaceDir || this.#workspaceDir,
    );
    this.#recordTokens(checkSpec.tier, result.tokens);
    if (this.#halted(taskId)) {
      this.#stopping.delete(taskId);
      this.#patchAgent(leadId, { status: 'idle', activity: 'standing by', taskId: null });
      this.#freeSlot(team.id);
      return null;
    }
    if (result.rejected) this.#activity(leadId, taskId, `split plan rejected (${result.rejected}) — running as one worker`);
    if (!result.plan) return this.#runTask(taskId, team, autoQa, { noSplit: true, slotHeld: true });
    return this.#runSplit(taskId, team, result.plan, autoQa);
  }

  // Entered holding the planning slot. The slot travels scaffold -> part 1,
  // and the last part to finish hands its slot to the integration run, so a
  // split never gives up capacity mid-flight; other parts claim slots through
  // the priority line.
  async #runSplit(taskId: string, team: Team, plan: ParallelPlan, autoQa: boolean): Promise<string | null> {
    const parent = this.#bus.state.tasks[taskId]!;
    const leadId = `${team.id}-lead`;
    const count = plan.parts.length;
    this.#activity(
      leadId,
      taskId,
      `split into ${count} parallel parts${plan.scaffold ? ' after a scaffold' : ''}: ${plan.parts.map((part) => part.title).join(' · ')}`,
    );
    this.#patchAgent(leadId, { status: 'working', activity: `coordinating ${count} parallel workers`, taskId });
    this.#patchTask(taskId, { progressPct: 5 });

    const header =
      `This is one piece of "${parent.title}", which the ${team.name} lead split across parallel workers.\n\n` +
      `Overall task: ${parent.detail.slice(0, 3000)}\n\n` +
      'Shared contract (code against it exactly; if it is wrong, work around it and say so in your report):\n' +
      (plan.contract || '(none given — follow the existing code layout)');
    const partList = plan.parts.map((part) => `${part.title} (owns ${part.owns.join(', ')})`).join('; ');
    const reports: string[] = [];
    let slotHeld = true;
    let integrating = false;

    try {
      if (plan.scaffold) {
        const scaffold = await this.#runSplitPiece(
          taskId,
          team,
          `[scaffold] ${parent.title}`,
          `${header}\n\nYour piece: build ONLY the shared skeleton the parallel parts need before they start:\n${plan.scaffold}\n\n` +
            `The parts that follow (do not build their contents): ${partList}. Commit the skeleton when it is in place.`,
          true,
        );
        if (this.#halted(taskId)) return null;
        if (scaffold.report === null) {
          this.#patchTask(taskId, { status: 'failed', synopsis: 'Failed: the scaffold step did not complete, so the parallel parts were not started.' });
          return null;
        }
        reports.push(`Scaffold: ${scaffold.report}`);
        this.#patchTask(taskId, { progressPct: 15 });
      }

      let finished = 0;
      const results = await Promise.all(
        plan.parts.map((part, index) => {
          const inherits = index === 0; // part 1 takes over the held slot
          if (inherits) slotHeld = false;
          return this.#runSplitPiece(
            taskId,
            team,
            `[part ${index + 1}/${count}] ${part.title}`,
            `${header}\n\nYour part: ${part.title}\n${part.instruction}\n\n` +
              `You exclusively own: ${part.owns.join(', ')}. Other parts, built right now by other workers ` +
              `in this same workspace: ${partList}.\n` +
              'Rules: create/edit only paths you own (read anything). Do NOT commit, reset, stash, checkout or otherwise change git state, ' +
              'and do not add dependencies or run repo-wide formatters — the integration step does that. ' +
              'Do NOT run the repo-wide test suite, full build, typecheck or linters: the other parts are still writing files, so ' +
              'those results are meaningless. At most run tests scoped to files you own; the integration step builds and runs everything.',
            inherits,
          ).then(({ report, ran }) => {
            finished += 1;
            if (ran) {
              if (finished === count && !this.#halted(taskId)) slotHeld = true; // kept for integration
              else this.#freeSlot(team.id); // siblings in the priority line get it first
            }
            if (!this.#halted(taskId)) {
              this.#patchTask(taskId, { progressPct: 15 + Math.round((55 * finished) / count) });
              // The part's own run parked the lead as idle; it's still coordinating.
              if (finished < count) this.#patchAgent(leadId, { status: 'working', activity: `coordinating ${count} parallel workers`, taskId });
            }
            return report;
          });
        }),
      );
      if (this.#halted(taskId)) return null;
      if (results.every((report) => report === null)) {
        this.#patchTask(taskId, { status: 'failed', synopsis: 'Failed: none of the parallel parts completed.' });
        return null;
      }
      results.forEach((report, index) =>
        reports.push(
          `Part ${index + 1} (${plan.parts[index]!.title}): ${report ?? 'FAILED or stopped — no report; finish or flag this part yourself.'}`,
        ),
      );

      // Integration: the original task, one worker, with every part's report.
      this.#integrationBriefs.set(
        taskId,
        `The ${team.name} lead split this task across parallel workers; their parts are now in this workspace, uncommitted. ` +
          'You are the integration step: check the parts fit together against the shared contract, fix seams and conflicts, ' +
          'finish anything a part left incomplete, build and run the tests, then commit in small logical steps. ' +
          'Report on the whole task as delivered.\n\n' +
          `Shared contract:\n${plan.contract || '(none)'}\n\nPart reports:\n${reports.join('\n\n')}`,
      );
      this.#patchAgent(leadId, { status: 'working', activity: `integrating ${count} parts`, taskId });
      // Paused mid-split: the integration is new work, so it waits in the
      // priority line for resume like any other piece.
      if (slotHeld && this.#pausedAll) {
        slotHeld = false;
        this.#freeSlot(team.id);
      }
      if (!slotHeld) {
        if (!(await this.#claimSlot(taskId, team, taskId))) return null;
        slotHeld = true;
      }
      slotHeld = false; // the integration run owns (and frees) it now
      integrating = true;
      return await this.#runTask(taskId, team, autoQa, { noSplit: true, slotHeld: true, startPct: 70 });
    } finally {
      if (slotHeld) this.#freeSlot(team.id);
      if (!integrating) this.#patchAgent(leadId, { status: 'idle', activity: 'standing by', taskId: null });
      this.#integrationBriefs.delete(taskId);
      for (const childId of this.#splitChildren.get(taskId) ?? []) {
        this.#taskDepth.delete(childId);
        this.#stopping.delete(childId);
      }
      this.#splitChildren.delete(taskId);
      this.#stopping.delete(taskId);
    }
  }

  // One scaffold/part task of a split: its own visible task and worker, no
  // QA or coordination of its own (the integrated parent gets those). With
  // `slotHeld` it runs on the caller's slot; otherwise it claims one. `ran`
  // means it finished still holding a slot, which the caller must hand on or
  // free.
  async #runSplitPiece(
    parentId: string,
    team: Team,
    title: string,
    detail: string,
    slotHeld: boolean,
  ): Promise<{ report: string | null; ran: boolean }> {
    const parent = this.#bus.state.tasks[parentId]!;
    this.#taskCounter += 1;
    const pieceId = `t-${now().toString(36)}-${this.#taskCounter}`;
    this.#splitChildren.set(parentId, [...(this.#splitChildren.get(parentId) ?? []), pieceId]);
    this.#taskDepth.set(pieceId, this.#taskDepth.get(parentId) ?? 0);
    this.#publishTask({
      id: pieceId,
      title: title.slice(0, 60),
      detail,
      projectId: parent.projectId,
      teamId: team.id,
      status: 'queued',
      progressPct: 0,
      agentIds: [],
      synopsis: null,
      tokensUsed: 0,
      createdAt: now(),
      updatedAt: now(),
      parentTaskId: parentId,
    });
    if (!slotHeld && !(await this.#claimSlot(pieceId, team, parentId))) {
      if (this.#bus.state.tasks[pieceId]?.status === 'queued') {
        this.#patchTask(pieceId, { status: 'paused', synopsis: 'Stopped with its parent task.' });
      }
      return { report: null, ran: false };
    }
    const report = await this.#runTask(pieceId, team, false, { noSplit: true, slotHeld: true, keepSlot: true });
    return { report, ran: true };
  }

  #qaTeam(): Team | null {
    return (
      this.#registry.all().find((team) => /\bqa\b|test/i.test(team.id) || /\bqa\b|test/i.test(team.name)) ?? null
    );
  }

  // Completed code work always gets a QA pass: real tests, the real app in
  // its real environment, correctness AND performance.
  #enqueueQa(sourceTaskId: string, sourceTeam: Team, synopsis: string): void {
    const qa = this.#qaTeam();
    const source = this.#bus.state.tasks[sourceTaskId];
    if (!qa || !source) return;
    if (sourceTeam.id === qa.id || source.title.startsWith('[QA]')) return;
    // QA runs REAL tests in a real environment — that only makes sense for
    // teams that build/run things (bash). Research, docs, and assistant work
    // (read/edit/web) produces text, not testable systems: no QA follow-up.
    if (!sourceTeam.allowedTools.includes('bash')) return;

    this.#taskCounter += 1;
    const taskId = `t-${now().toString(36)}-${this.#taskCounter}`;
    this.#publishTask({
      id: taskId,
      title: `[QA] ${source.title}`.slice(0, 60),
      detail:
        `QA the completed task "${source.title}" in this project. What was reported done: ${synopsis || '(no synopsis)'}\n\n` +
        "Run the project's REAL tests, and where applicable actually run the app in its proper environment " +
        '(build it, launch it, exercise the changed feature). Verify correctness and edge cases, hunt for bugs, ' +
        'and ALWAYS check performance. Report pass/fail with concrete findings.',
      projectId: source.projectId,
      teamId: qa.id,
      status: 'queued',
      progressPct: 0,
      agentIds: [],
      synopsis: null,
      tokensUsed: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    this.#activity('master', taskId, `QA follow-up queued for: ${source.title.slice(0, 45)}`);

    this.#qaSource.set(taskId, sourceTaskId);
    this.#taskDepth.set(taskId, (this.#taskDepth.get(sourceTaskId) ?? 0) + 1);
    this.#startOrQueue(taskId, qa, false);
  }

  // Respect the team's cap: run now or join the FIFO queue (and maybe ask
  // the owner for an extra worker).
  #startOrQueue(taskId: string, team: Team, autoQa: boolean): void {
    if (this.#pausedAll || (this.#activeWorkers.get(team.id) ?? 0) >= team.maxConcurrentWorkers) {
      this.#patchTask(taskId, { status: 'queued' });
      const queue = this.#queues.get(team.id) ?? [];
      queue.push(taskId);
      this.#queues.set(team.id, queue);
      this.#maybeAskToScale(team);
    } else {
      void this.#runTask(taskId, team, autoQa);
    }
  }

  // Two leads huddle in the Meeting room for a moment while a handover or
  // remediation is arranged; the office renders whoever is in a meeting.
  #holdMeeting(leadIds: string[], topic: string): void {
    const meeting = `meeting: ${topic}`;
    for (const leadId of leadIds) this.#patchAgent(leadId, { status: 'reporting', activity: meeting });
    setTimeout(() => {
      for (const leadId of leadIds) {
        const lead = this.#bus.state.agents[leadId];
        if (lead && lead.activity.startsWith('meeting:')) {
          this.#patchAgent(leadId, { status: 'idle', activity: 'standing by' });
        }
      }
    }, 10_000);
  }

  // The master's interdisciplinary pass, run on every completed task report:
  // if the report explicitly hands work to a different team, the two leads
  // meet and the master dispatches a follow-up task there. Depth-capped so
  // follow-ups of follow-ups can't cascade forever.
  async #coordinate(taskId: string, team: Team, synopsis: string): Promise<void> {
    if (!synopsis) return;
    const depth = this.#taskDepth.get(taskId) ?? 0;
    if (depth >= 2) return;
    const task = this.#bus.state.tasks[taskId];
    if (!task) return;

    const checksModel = this.#checksModel();
    const { dispatch, tokens } = await coordinateFollowUp(
      this.#engine,
      this.#registry.all(),
      team,
      task.title,
      synopsis,
      checksModel,
    );
    this.#recordTokens(checksModel.tier, tokens);

    for (const item of dispatch) {
      const target = this.#registry.get(item.teamId);
      if (!target || target.id === team.id) continue;

      this.#holdMeeting(
        [`${team.id}-lead`, `${target.id}-lead`],
        `handover: ${item.title.slice(0, 32)}`,
      );
      this.#activity('master', taskId, `${team.name} and ${target.name} leads are meeting over a handover`);

      this.#taskCounter += 1;
      const followId = `t-${now().toString(36)}-${this.#taskCounter}`;
      this.#taskDepth.set(followId, depth + 1);
      this.#publishTask({
        id: followId,
        title: item.title.slice(0, 60),
        detail:
          `${item.instruction}\n\n` +
          `Handover from the ${team.name} ("${task.title}"): ${synopsis.replace(/\s+/g, ' ').slice(0, 600)}`,
        projectId: task.projectId,
        teamId: target.id,
        status: 'queued',
        progressPct: 0,
        agentIds: [],
        synopsis: null,
        tokensUsed: 0,
        createdAt: now(),
        updatedAt: now(),
      });
      this.#activity('master', followId, `follow-up dispatched to ${target.name}: ${item.title.slice(0, 45)}`);
      this.#startOrQueue(followId, target, true);
    }
  }

  // QA verdict -> Meeting Room huddle -> [fix] task back to the source team.
  // Fixes get re-QA'd; after two failed rounds it escalates to the owner.
  async #handleQaOutcome(qaTaskId: string, qaSynopsis: string): Promise<void> {
    const sourceId = this.#qaSource.get(qaTaskId);
    this.#qaSource.delete(qaTaskId);
    const source = sourceId ? this.#bus.state.tasks[sourceId] : undefined;
    if (!source) return;
    // Freelancer-sourced work has no registry team — the freelance desk
    // stands in, and remediation goes back to the SAME terminal session.
    const isFreelance = !source.teamId && source.title.includes('[FL ');
    const sourceTeam = isFreelance ? FREELANCE_DESK : source.teamId ? this.#registry.get(source.teamId) : undefined;
    const qa = this.#qaTeam();
    if (!sourceTeam || !qa) return;

    const checksModel = this.#checksModel();
    const evaluation = await evaluateQaReport(this.#engine, qaSynopsis, checksModel);
    this.#recordTokens(checksModel.tier, evaluation.tokens);
    if (evaluation.verdict === 'pass') {
      this.#activity('master', qaTaskId, `QA verdict: pass — ${source.title.slice(0, 45)}`);
      return;
    }

    const rootTitle = source.title.replace(/^\[fix\d*\]\s*/, '');
    const roundMatch = source.title.match(/^\[fix(\d*)\]/);
    const round = roundMatch ? (roundMatch[1] ? Number(roundMatch[1]) : 1) : 0;
    if (round >= 2) {
      this.#activity(
        'master',
        qaTaskId,
        `QA still failing after ${round} fix rounds — needs your attention: ${rootTitle.slice(0, 45)}`,
      );
      return;
    }

    // The leads huddle in the meeting room while the handover happens.
    this.#holdMeeting([`${qa.id}-lead`, `${sourceTeam.id}-lead`], `QA findings on "${rootTitle.slice(0, 32)}"`);
    this.#activity('master', qaTaskId, `${qa.name} and ${sourceTeam.name} leads are meeting over QA findings`);

    const fixTitle = (round === 0 ? `[fix] ${rootTitle}` : `[fix${round + 1}] ${rootTitle}`).slice(0, 60);

    // Freelancer remediation: the fix instruction resumes the SAME session
    // (which re-enters the normal flow, so the fix gets re-QA'd too).
    if (isFreelance) {
      const freelancerId = source.agentIds[0];
      if (!freelancerId) return;
      this.#activity('master', qaTaskId, `remediation sent back to freelancer: ${fixTitle.slice(0, 45)}`);
      void this.#runFreelancerTask(
        freelancerId,
        `QA found issues in your earlier work ("${rootTitle.slice(0, 50)}"). Fix them now; the work will be re-checked.\n\nIssues:\n${evaluation.summary || qaSynopsis}`,
        fixTitle,
      );
      return;
    }

    this.#taskCounter += 1;
    const fixId = `t-${now().toString(36)}-${this.#taskCounter}`;
    this.#publishTask({
      id: fixId,
      title: fixTitle,
      detail:
        `QA found issues in "${rootTitle}". Fix them; the work will be re-QA'd.\n\n` +
        `Issues from QA:\n${evaluation.summary || qaSynopsis}\n\n` +
        `Original work summary: ${source.synopsis ?? '(none)'}`,
      projectId: source.projectId,
      teamId: sourceTeam.id,
      status: 'queued',
      progressPct: 0,
      agentIds: [],
      synopsis: null,
      tokensUsed: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    this.#activity('master', fixId, `remediation assigned to ${sourceTeam.name}: ${fixTitle.slice(0, 45)}`);
    this.#taskDepth.set(fixId, (this.#taskDepth.get(qaTaskId) ?? 1) + 1);
    this.#startOrQueue(fixId, sourceTeam, true);
  }

  // The findings themselves must reach the owner: full report to
  // data/reports/ (permanent) and a copy into the outbox (auto-pushed to the
  // phone), announced in the activity feed.
  #deliverReport(task: Task, team: Team, workerReport: string, leadSynopsis: string): void {
    if (!this.#outboxDir) return;
    try {
      const reportsDir = join(this.#outboxDir, '..', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const slug =
        task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || task.id;
      const name = `${slug}.md`;
      const body =
        `# ${task.title}\n\n` +
        `_${team.name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · task ${task.id}_\n\n` +
        `${leadSynopsis ? `**Lead's summary:** ${leadSynopsis}\n\n---\n\n` : ''}` +
        `${workerReport.trim()}\n`;
      writeFileSync(join(reportsDir, `${Date.now().toString(36)}-${name}`), body);
      writeFileSync(join(this.#outboxDir, `report-${name}`), body); // watcher pushes + removes
      this.#activity('master', task.id, `full report saved to data/reports and sent to your phone: ${name}`);
    } catch (error) {
      this.#activity('master', task.id, `report delivery failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Backed-up team -> an approval card (reaches the phone too): approve to
  // raise the team's worker cap by one.
  #maybeAskToScale(team: Team): void {
    const queue = this.#queues.get(team.id) ?? [];
    if (queue.length < 2 || this.#scaleAsked.has(team.id)) return;
    this.#scaleAsked.add(team.id);
    const request: PermissionRequest = {
      id: `scale-${team.id}-${now().toString(36)}`,
      taskId: queue[0] ?? '',
      agentId: 'master',
      teamId: team.id,
      command: `add a temporary worker to ${team.name} (${queue.length} tasks queued)`,
      flags: ['team scaling'],
      reason: `${team.name} is at its cap of ${team.maxConcurrentWorkers} concurrent worker(s) with a growing queue. Approving raises the cap by one.`,
      status: 'pending',
      scope: 'once',
      requestedAt: now(),
      resolvedAt: null,
    };
    this.#bus.publish({ type: 'permission.updated', request });
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
    if (this.#pausedAll) return;
    const team = this.#registry.get(teamId);
    // Split pieces first: they belong to work that has already started.
    const waiters = this.#slotWaiters.get(teamId) ?? [];
    while (waiters.length > 0 && (!team || (this.#activeWorkers.get(teamId) ?? 0) < team.maxConcurrentWorkers)) {
      const waiter = waiters.shift()!;
      const claimed = !!team && !this.#halted(waiter.taskId) && !this.#halted(waiter.parentId);
      if (claimed) this.#takeSlot(teamId);
      waiter.resolve(claimed);
    }
    if (waiters.length === 0) this.#slotWaiters.delete(teamId);
    const queue = this.#queues.get(teamId) ?? [];
    if (queue.length === 0) this.#scaleAsked.delete(teamId); // eligible to ask again next backlog
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
    flags: string[] = [],
  ): Promise<'approve' | 'deny'> {
    const requestId = `perm-${now().toString(36)}-${workerId}`;
    const request: PermissionRequest = {
      id: requestId,
      taskId,
      agentId: workerId,
      teamId: team.id,
      command,
      flags,
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
    // Master's scale-up ask: no worker is waiting on this — approving raises
    // the team's worker cap by one and drains its queue.
    if (requestId.startsWith('scale-') && request.teamId) {
      if (decision === 'approve') {
        const team = this.#registry.get(request.teamId);
        const updated = team
          ? this.#registry.update({ teamId: team.id, maxConcurrentWorkers: team.maxConcurrentWorkers + 1 })
          : null;
        if (updated) {
          this.#bus.publish({ type: 'team.updated', team: updated });
          this.#activity(
            'master',
            null,
            `${updated.name} scaled up to ${updated.maxConcurrentWorkers} concurrent workers`,
          );
          this.#drainQueue(updated.id);
        }
      }
      return;
    }
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
    mcpServers?: Record<string, unknown>;
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
      model: this.#leadSpec(team).tier,
      taskId: null,
      tokensUsed: 0,
      updatedAt: now(),
    });
    this.#activity('master', null, `new team created: ${team.name}`);
  }

  updateTeam(input: {
    teamId: string;
    maxConcurrentWorkers?: number;
    workerModel?: ModelTier;
    quotaSharePct?: number;
    charter?: string;
    mcpServers?: Record<string, unknown>;
  }): void {
    const team = this.#registry.update(input);
    if (!team) return;
    this.#bus.publish({ type: 'team.updated', team });
    this.#activity(
      'master',
      null,
      `team updated: ${team.name} — up to ${team.maxConcurrentWorkers} worker${team.maxConcurrentWorkers > 1 ? 's' : ''}, ${team.workerModel} tier`,
    );
    this.#drainQueue(team.id); // a raised cap can unblock queued tasks
  }

  removeTeam(teamId: string): void {
    const team = this.#registry.get(teamId);
    if (!team) return;
    const busy = Object.values(this.#bus.state.tasks).some(
      (task) => task.teamId === teamId && !['done', 'failed', 'paused'].includes(task.status),
    );
    if (busy) {
      this.#activity('master', null, `cannot remove ${team.name} — it still has active tasks (stop them first)`);
      return;
    }
    this.#registry.remove(teamId);
    this.#bus.publish({ type: 'team.removed', teamId });
    this.#bus.publish({ type: 'agent.removed', agentId: `${teamId}-lead` });
    this.#activity('master', null, `team removed: ${team.name}`);
  }

  registerProject(input: { name: string; workspaceDir: string; description?: string; quotaTokens?: number }): void {
    try {
      const project = this.#projects.register(input);
      this.#bus.publish({ type: 'project.updated', project });
      this.#activity('master', null, `project registered: ${project.name} → ${project.workspaceDir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#activity('master', null, `project "${input.name}" ${message}`);
    }
  }

  sendFile(name: string, mimeType: string, bytesB64: string, from = 'desktop'): void {
    try {
      const bytes = Buffer.from(bytesB64, 'base64');
      // Phone -> PC: land the file in the inbox on disk for teams to use.
      if (from === 'phone' && this.#inboxDir) {
        saveIncomingFile(this.#bus, this.#inboxDir, { name, bytes });
        return;
      }
      // Desktop -> phone: broadcast over the link (existing direction).
      shareFile(this.#bus, { name, mimeType, bytes, from: 'desktop' });
    } catch (error) {
      this.#activity('master', null, `file "${name}" could not be shared: ${error instanceof Error ? error.message : error}`);
    }
  }

  captureScreen(): void {
    void capturePcScreen(this.#bus);
  }

  // The PA desk (deterministic assistant stores + clock) is created by the
  // hub and attached here so its commands flow through the normal channel.
  #pa: PaDeskLike | null = null;

  attachPa(desk: PaDeskLike): void {
    this.#pa = desk;
  }

  paSet(enabled: boolean): void {
    this.#pa?.setEnabled(enabled);
  }

  paAdd(kind: 'todo' | 'reminder' | 'event' | 'note', text: string, atMs?: number, endMs?: number): void {
    this.#pa?.add(kind, text, atMs, endMs);
  }

  paToggle(id: string): void {
    this.#pa?.toggleTodo(id);
  }

  paRemove(kind: 'todo' | 'reminder' | 'event', id: string): void {
    this.#pa?.remove(kind, id);
  }

  paListAdd(list: string, text: string): void {
    this.#pa?.listAdd(list, text);
  }

  paListRemove(list: string, index: number): void {
    this.#pa?.listRemove(list, index);
  }

  // Global task controls: pause holds everything new (running work finishes
  // and then queues); resume drains; killall stops running work too.
  tasksControl(action: 'pause' | 'resume' | 'killall'): void {
    if (action === 'pause') {
      if (this.#pausedAll) return;
      this.#pausedAll = true;
      this.#activity('master', null, 'ALL TASKS PAUSED — running work finishes, nothing new starts until resume');
      return;
    }
    if (action === 'resume') {
      if (!this.#pausedAll) return;
      this.#pausedAll = false;
      this.#activity('master', null, 'tasks resumed — draining queues');
      for (const teamId of new Set([...this.#slotWaiters.keys(), ...this.#queues.keys()])) this.#drainQueue(teamId);
      return;
    }
    // killall: stop every non-terminal task (aborts workers, expires cards,
    // empties queues) and kill any freelancer sidecars.
    const active = Object.values(this.#bus.state.tasks).filter(
      (task) => !['done', 'failed', 'paused'].includes(task.status),
    );
    for (const task of active) this.stopTask(task.id);
    this.#queues.clear();
    this.#freelancers?.killAll?.();
    this.#activity('master', null, `KILL ALL — stopped ${active.length} task(s); queues cleared`);
  }

  // The freelancer manager is created alongside the hub and attached here so
  // "message a freelancer" flows through the normal command channel.
  #freelancers: FreelancerRunner | null = null;

  attachFreelancers(manager: FreelancerRunner): void {
    this.#freelancers = manager;
  }

  // A freelancer instruction is a real task: the terminal session is the
  // worker, the freelance desk lead reviews its report into a synopsis, and
  // the normal machinery follows — auto-QA in the freelancer's own project,
  // coordination, history, reports. Only the worker differs.
  freelancerSend(agentId: string, text: string): void {
    void this.#runFreelancerTask(agentId, text);
  }

  async #runFreelancerTask(agentId: string, text: string, titleOverride?: string): Promise<void> {
    const manager = this.#freelancers;
    if (!manager) return;
    const who = manager.describe(agentId);
    if (!who) {
      this.#activity('master', null, `freelancer message failed — session not found (${agentId})`);
      return;
    }

    // QA has to run where the freelancer works: reuse a registered project
    // covering that folder, or register it (workspace-roots still enforced).
    let project = this.#projects
      .all()
      .find((candidate) => who.cwd.toLowerCase().startsWith(candidate.workspaceDir.toLowerCase()) && candidate.workspaceDir);
    if (!project && who.cwd) {
      try {
        project = this.#projects.register({ name: who.cwd.split(/[\\/]/).pop() || who.name, workspaceDir: who.cwd });
        this.#bus.publish({ type: 'project.updated', project });
        this.#activity('master', null, `project registered from freelancer session: ${project.name} → ${who.cwd}`);
      } catch {
        project = undefined; // outside the workspace roots — task still runs, QA is skipped
      }
    }

    this.#taskCounter += 1;
    const taskId = `t-${now().toString(36)}-${this.#taskCounter}`;
    this.#publishTask({
      id: taskId,
      title: (titleOverride ?? `[FL ${who.name}] ${text}`).slice(0, 60),
      detail: text,
      projectId: project?.id ?? null,
      teamId: null,
      status: 'in_flight',
      progressPct: 10,
      agentIds: [agentId],
      synopsis: null,
      tokensUsed: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    this.#activity(agentId, taskId, `instruction sent to freelancer ${who.name}: ${text.slice(0, 45)}`);

    const result = await manager.runInstruction(agentId, text);
    if (!result.ok) {
      this.#patchTask(taskId, { status: 'failed', synopsis: `Freelancer ${result.name}: ${result.error}` });
      this.#activity(agentId, taskId, `freelancer ${result.name} instruction failed: ${result.error.slice(0, 70)}`);
      this.#masterStatus();
      return;
    }

    // Same review the teams get; the freelance desk is a synthetic team so
    // the standard prompts, QA gate, and coordination all apply unchanged.
    this.#patchTask(taskId, { status: 'review', progressPct: 90 });
    const task = this.#bus.state.tasks[taskId];
    const deskLead = this.#leadSpec(FREELANCE_DESK);
    const review = await reviewWorkerReport(this.#engine, FREELANCE_DESK, task?.title ?? text, result.reply, deskLead);
    this.#recordTokens(deskLead.tier, review.tokens);
    this.#patchTask(taskId, { status: 'done', progressPct: 100, synopsis: review.synopsis || result.reply.slice(0, 400) });
    this.#activity(agentId, taskId, `freelancer ${result.name} replied — full reply sent to your phone`);

    if (project) {
      this.#enqueueQa(taskId, FREELANCE_DESK, review.synopsis || result.reply.slice(0, 400));
    } else {
      this.#activity('master', taskId, `QA skipped — ${who.cwd || 'this session'} is outside the workspace roots`);
    }
    void this.#coordinate(taskId, FREELANCE_DESK, review.synopsis || '');
    this.#masterStatus();
  }

  // --- model choices -------------------------------------------------------

  configureModels(initial: ModelOverrides, onChange: (overrides: ModelOverrides) => void): void {
    this.#models = initial;
    this.#onModelsChange = onChange;
  }

  #masterModel(): ModelSpec {
    return resolveModel(MODEL_DEFAULTS.master, this.#models.master);
  }

  #checksModel(): ModelSpec {
    return resolveModel(MODEL_DEFAULTS.checks, this.#models.checks);
  }

  // Team records are never mutated by model choices, so clearing the
  // overrides restores exactly each team's defaults.
  #leadSpec(team: Team): ModelSpec {
    return resolveModel(team.leadModel, this.#models.teams[team.id]?.lead, this.#models.lead);
  }

  #workerSpec(team: Team): ModelSpec {
    return resolveModel(team.workerModel, this.#models.teams[team.id]?.worker, this.#models.worker);
  }

  setModels(overrides: ModelOverrides): void {
    this.#models = overrides;
    this.#onModelsChange(overrides);
    for (const team of this.#registry.all()) {
      this.#patchAgent(`${team.id}-lead`, { model: this.#leadSpec(team).tier });
    }
    this.#patchAgent('master', { model: this.#masterModel().tier });
    const choices = [
      overrides.master,
      overrides.checks,
      overrides.lead,
      overrides.worker,
      ...Object.values(overrides.teams).flatMap((choice) => [choice.lead, choice.worker]),
    ];
    const custom = choices.reduce((sum, choice) => sum + (choice?.model ? 1 : 0) + (choice?.effort ? 1 : 0), 0);
    this.#activity(
      'master',
      null,
      custom === 0
        ? 'models reset to defaults'
        : `model settings updated — ${custom} custom choice${custom > 1 ? 's' : ''}; applies to work that starts from now`,
    );
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.#policy.mode === mode) return;
    this.#policy.mode = mode;
    this.#onPermissionModeChange(mode);
    this.#activity(
      'master',
      null,
      mode === 'auto'
        ? 'permissions: auto — routine work runs; installs, network, pushes, and destructive commands still ask'
        : 'permissions: strict — every gated tool asks',
    );
  }

  removeProject(projectId: string): void {
    const project = this.#projects.get(projectId) ?? this.#projects.find(projectId);
    if (!project) return;
    const busy = Object.values(this.#bus.state.tasks).some(
      (task) => task.projectId === project.id && !['done', 'failed', 'paused'].includes(task.status),
    );
    if (busy) {
      this.#activity('master', null, `cannot remove ${project.name} — it still has active tasks`);
      return;
    }
    if (!this.#projects.remove(project.id)) {
      this.#activity('master', null, `cannot remove ${project.name} — the hub workspace stays registered`);
      return;
    }
    this.#bus.publish({ type: 'project.removed', projectId: project.id });
    this.#activity('master', null, `project removed: ${project.name} (its folder is untouched)`);
  }
}
