import { existsSync } from 'node:fs';
import type { Agent, ModelTier, PermissionRequest, Task, Team, Usage } from '@agent-hq/shared';
import type { HubBus } from '../bus.js';
import type { CommandHandlers } from '../commands.js';
import type { OrchestratorEngine } from '../engine/types.js';
import { coordinateFollowUp, evaluateQaReport, reviewWorkerReport, routeTask, type PlanStep } from './master.js';
import { capturePcScreen, saveIncomingFile, shareFile } from '../files.js';
import { evaluatePermission } from './policy.js';
import { delay } from './util.js';
import type { PermissionMode } from '../config.js';
import type { TeamRegistry } from './teams.js';
import type { ProjectRegistry } from './projects.js';

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
  #qaSource = new Map<string, string>(); // [QA] taskId -> source taskId
  #scaleAsked = new Set<string>(); // teams with an open scale-up card
  // Follow-up generation per task (0 = user-submitted). QA passes, fixes,
  // and master-dispatched handovers each add one; past MAX the master stops
  // spawning and escalates to the owner instead of looping.
  #taskDepth = new Map<string, number>();
  #routingCount = 0;
  #tokensByModel: Record<ModelTier, number> = { opus: 0, sonnet: 0, haiku: 0 };

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

  // Workspace roots (minus the one the worker is already inside) become
  // additional tool directories, so cross-project searches see full trees.
  #extraDirs(cwd: string): string[] {
    return this.#projects.roots
      .map((root) => root.path)
      .filter((path) => existsSync(path) && !cwd.toLowerCase().startsWith(path.toLowerCase()));
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

    const decision = await routeTask(
      this.#engine,
      this.#registry.all(),
      this.#projects.all(),
      this.#projects.defaultProject().id,
      text,
      forcedProjectId,
    );
    this.#recordTokens('opus', decision.tokens);
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

    const active = this.#activeWorkers.get(team.id) ?? 0;
    if (active >= team.maxConcurrentWorkers) {
      this.#patchTask(taskId, { status: 'queued' });
      const queue = this.#queues.get(team.id) ?? [];
      queue.push(taskId);
      this.#queues.set(team.id, queue);
      this.#maybeAskToScale(team);
    } else {
      void this.#runTask(taskId, team);
    }
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
      while ((this.#activeWorkers.get(team.id) ?? 0) >= team.maxConcurrentWorkers) {
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
    const history = Object.values(this.#bus.state.tasks)
      .filter((t) => t.projectId === task.projectId && t.status === 'done' && t.id !== task.id && t.synopsis)
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
      const rootList = this.#projects.roots.map((root) => `${root.path} (${root.label})`).join(' · ');
      sections.push(
        `File locations policy: you have full READ/SEARCH access to everything under these roots, including ALL subdirectories at any depth — recurse into them when searching: ${rootList}. ` +
          "Keep all new files inside this project's workspace; brand-new projects or standalone tools belong only under those roots.",
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
    return sections.join('\n');
  }

  // Returns the final synopsis on success, or null if the task failed or was
  // stopped (chains use this to decide whether to continue).
  async #runTask(taskId: string, team: Team, autoQa = true): Promise<string | null> {
    const task = this.#bus.state.tasks[taskId];
    if (!task) return null;
    let outcome: string | null = null;
    const project = (task.projectId ? this.#projects.get(task.projectId) : undefined) ?? this.#projects.defaultProject();

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
        prompt: this.#buildWorkerPrompt(task),
        team,
        model: team.workerModel,
        cwd: project.workspaceDir || this.#workspaceDir,
        extraDirs: this.#extraDirs(project.workspaceDir || this.#workspaceDir),
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
            const ledger = this.#projects.addTokens(project.id, totalTokens - previous);
            if (ledger) {
              this.#bus.publish({ type: 'project.updated', project: ledger.project });
              if (ledger.crossed75) {
                this.#activity('master', taskId, `project "${ledger.project.name}" crossed 75% of its token quota`);
              }
            }
          },
          onPermission: ({ toolName, command, reason }) => {
            const verdict = evaluatePermission(toolName, command, this.#policy.mode, team.allowedTools);
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

      // Lead review: the worker's report becomes the synopsis the owner reads.
      this.#patchTask(taskId, { status: 'review', progressPct: 95 });
      this.#patchAgent(workerId, { status: 'reporting', activity: 'reporting to lead' });
      this.#patchAgent(`${team.id}-lead`, { status: 'working', activity: `reviewing: ${task.title.slice(0, 40)}` });
      const review = await reviewWorkerReport(this.#engine, team, task.title, result.synopsis);
      this.#recordTokens(team.leadModel, review.tokens);
      if (review.memoryNote) {
        this.#registry.appendMemory(team.id, review.memoryNote);
        this.#activity(`${team.id}-lead`, taskId, `noted for the team: ${review.memoryNote.slice(0, 80)}`);
      }

      this.#patchTask(taskId, { status: 'done', progressPct: 100, synopsis: review.synopsis || null });
      this.#activity(`${team.id}-lead`, taskId, `report filed: ${task.title.slice(0, 50)}`);
      outcome = review.synopsis || '';

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
      this.#stopping.delete(taskId);
      this.#patchAgent(`${team.id}-lead`, { status: 'idle', activity: 'standing by', taskId: null });
      this.#retireWorker(workerId);
      this.#activeWorkers.set(team.id, Math.max(0, (this.#activeWorkers.get(team.id) ?? 1) - 1));
      this.#masterStatus();
      this.#drainQueue(team.id);
    }
    return outcome;
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
    // Only work that can have touched code/system state needs QA.
    if (!sourceTeam.allowedTools.some((tool) => tool === 'edit' || tool === 'bash')) return;

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
    if ((this.#activeWorkers.get(team.id) ?? 0) >= team.maxConcurrentWorkers) {
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

    const { dispatch, tokens } = await coordinateFollowUp(
      this.#engine,
      this.#registry.all(),
      team,
      task.title,
      synopsis,
    );
    this.#recordTokens('haiku', tokens);

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
    if (!source || !source.teamId) return;
    const sourceTeam = this.#registry.get(source.teamId);
    const qa = this.#qaTeam();
    if (!sourceTeam || !qa) return;

    const evaluation = await evaluateQaReport(this.#engine, qaSynopsis);
    this.#recordTokens('haiku', evaluation.tokens);
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

    this.#taskCounter += 1;
    const fixId = `t-${now().toString(36)}-${this.#taskCounter}`;
    const fixTitle = (round === 0 ? `[fix] ${rootTitle}` : `[fix${round + 1}] ${rootTitle}`).slice(0, 60);
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
    const team = this.#registry.get(teamId);
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
      model: team.leadModel,
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
