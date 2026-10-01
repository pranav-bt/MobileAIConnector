import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_DEFAULTS, isInternalTask, resolveModel, rulesFor, toolName, type Agent, type ModelOverrides, type ModelSpec, type ModelTier, type PermissionRequest, type Project, type Task, type Team, type Usage } from '@agent-hq/shared';
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
  type RoutingThread,
  explainPermission,
  plainPermissionSummary,
  type PermissionContext,
  detectRuleConflicts,
  type RuleConflict,
  planRecovery,
  type RecoveryPlan,
  type StuckContext,
} from './master.js';
import { MASTER_SECTIONS } from './rules-file.js';
import { capturePcScreen, saveIncomingFile, shareFile } from '../files.js';
import { evaluatePermission } from './policy.js';
import { delay, isInside, type LockedDir } from './util.js';
import type { PermissionMode } from '../config.js';
import { parseRules, type ParsedRules, type TeamRegistry } from './teams.js';
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
  // Team rules (RULES.md) vs project CLAUDE.md: rule-set versions already
  // checked and settled, checks in flight (parallel parts share one), and
  // the file stamps the watcher compares to republish hand edits.
  #rulesSettled = new Set<string>();
  #rulesChecks = new Map<string, Promise<void>>();
  #rulesStamps = new Map<string, string>();
  #rulesTimer: NodeJS.Timeout | null = null;
  #onInfoChange: () => void = () => {};
  #mcpCatalog: () => Record<string, unknown> = () => ({});
  // Stuck tasks the master already ran a recovery pass for (one per task).
  #recoveryAsked = new Set<string>();
  // Tasks a recovery spawned (and their QA/fix/handover descendants) -> 1.
  #recoveryRound = new Map<string, number>();

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

  // Every team record goes out with its RULES.md, so clients show the rules
  // the workers actually get. The stamp keeps the watcher from re-sending.
  #publishTeam(team: Team): void {
    this.#rulesStamps.set(team.id, this.#registry.rulesStamp(team.id));
    this.#bus.publish({ type: 'team.updated', team: this.#registry.withRules(team) });
  }

  // Hand edits to RULES.md (any editor) reach the clients within ~3 s; a
  // stat per team per tick, the file is only read when it changed.
  #watchRules(): void {
    if (this.#rulesTimer) return;
    this.#rulesStamps.set('master', this.#registry.rulesStamp('master'));
    this.#rulesTimer = setInterval(() => {
      for (const team of this.#registry.all()) {
        if (this.#registry.rulesStamp(team.id) !== this.#rulesStamps.get(team.id)) this.#publishTeam(team);
      }
      if (this.#registry.rulesStamp('master') !== this.#rulesStamps.get('master')) this.#publishMasterRules();
    }, 3000);
    this.#rulesTimer.unref();
  }

  stopRulesWatch(): void {
    if (this.#rulesTimer) clearInterval(this.#rulesTimer);
    this.#rulesTimer = null;
  }

  // The master's rules reach clients on HubInfo (hub.updated).
  #publishMasterRules(): void {
    this.#rulesStamps.set('master', this.#registry.rulesStamp('master'));
    this.#onInfoChange();
  }

  masterRulesText(): string {
    return this.#registry.readRules('master');
  }

  // The owner's master rules for one kind of decision (see MASTER_SECTIONS).
  #masterRules(...sections: string[]): string[] {
    return rulesFor(parseRules(this.#registry.readRules('master')), sections);
  }

  // Team records with their RULES.md, so master prompts can see each team's tools.
  #teamsWithRules(): Team[] {
    return this.#registry.all().map((team) => this.#registry.withRules(team));
  }

  // "coding", "coding-team", "Coding team", "Cod" — exact id first.
  #findTeam(ref: string): Team | undefined {
    const key = ref.trim().toLowerCase();
    const teams = this.#registry.all();
    return (
      this.#registry.get(key) ??
      this.#registry.get(`${key}-team`) ??
      teams.find((team) => team.name.toLowerCase() === key) ??
      teams.find((team) => team.name.toLowerCase().startsWith(key) || team.id.startsWith(key))
    );
  }

  // A rules-file target: "master" (or "the master") is the master's own file.
  #rulesTarget(ref: string): { id: string; name: string; team: Team | null } | null {
    if (/^(the\s+)?master$/i.test(ref.trim())) return { id: 'master', name: 'Master', team: null };
    const team = this.#findTeam(ref);
    return team ? { id: team.id, name: team.name, team } : null;
  }

  #publishRules(target: { id: string; team: Team | null }): void {
    if (target.team) this.#publishTeam(target.team);
    else this.#publishMasterRules();
  }

  setTeamRules(teamRef: string, markdown: string): void {
    const target = this.#rulesTarget(teamRef);
    if (!target) {
      this.#activity('master', null, `no team called "${teamRef}" — rules not saved`);
      return;
    }
    this.#registry.setRules(target.id, markdown);
    this.#publishRules(target);
    const { rules, tools } = parseRules(markdown);
    this.#activity(
      'master',
      null,
      `${target.name} rules saved — ${rules.length} rule${rules.length === 1 ? '' : 's'}${tools.length ? `, ${tools.length} tool${tools.length === 1 ? '' : 's'}` : ''}`,
    );
  }

  addTeamRule(teamRef: string, rule: string, section?: string): void {
    const target = this.#rulesTarget(teamRef);
    if (!target || !this.#registry.addRule(target.id, rule, section)) {
      this.#activity('master', null, `no team called "${teamRef}" — rule not added`);
      return;
    }
    this.#publishRules(target);
    this.#activity('master', null, `${section ? `${section} ` : ''}rule added for ${target.name}: ${rule.slice(0, 80)}`);
  }

  // MCP connections by name from the PC's catalog (engine-provided). A team
  // gets exactly these; names not in the catalog are refused, never guessed.
  configureMcpCatalog(read: () => Record<string, unknown>): void {
    this.#mcpCatalog = read;
  }

  mcpCatalogNames(): string[] {
    return Object.keys(this.#mcpCatalog()).sort();
  }

  setTeamMcp(teamRef: string, names: string[]): void {
    const team = this.#findTeam(teamRef);
    if (!team) {
      this.#activity('master', null, `no team called "${teamRef}" — connections unchanged`);
      return;
    }
    const catalog = this.#mcpCatalog();
    const wanted = [...new Set(names)];
    const unknown = wanted.filter((name) => !(name in catalog) && !(name in team.mcpServers));
    // A grant already on the record (e.g. set up by tools/setup-teams.mjs)
    // may stay even when it isn't in the catalog; new ones must be in it.
    const mcpServers = Object.fromEntries(
      wanted
        .filter((name) => name in catalog || name in team.mcpServers)
        .map((name) => [name, name in catalog ? catalog[name] : team.mcpServers[name]]),
    );
    const updated = this.#registry.update({ teamId: team.id, mcpServers });
    if (!updated) return;
    this.#publishTeam(updated);
    const granted = Object.keys(mcpServers);
    this.#activity(
      'master',
      null,
      `${team.name} connections: ${granted.length ? granted.join(', ') : 'none'}` +
        (unknown.length ? ` (not configured on this PC: ${unknown.join(', ')})` : ''),
    );
  }

  onInfoChange(publish: () => void): void {
    this.#onInfoChange = publish;
  }

  init(): void {
    this.#watchRules();
    for (const project of this.#projects.all()) {
      this.#bus.publish({ type: 'project.updated', project });
    }
    for (const team of this.#registry.all()) {
      this.#publishTeam(team);
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
  #extraDirs(cwd: string, team?: Team): string[] {
    const paDir = team && this.#isPaTeam(team) && this.#pa ? this.#pa.paths.dir : '';
    const extras = [this.#outboxDir, this.#inboxDir, paDir].filter(Boolean);
    return [...new Set(extras)].filter((dir) => existsSync(dir) && !isInside(dir, cwd));
  }

  // Agent HQ's own data dir is never writable by workers — it holds the
  // pairing keys, secrets, config and every RULES.md, and sits inside the hub
  // project's workspace. Open: generated art, the phone inbox/outbox, and the
  // PA desk for the PA team.
  #lockedData(team?: Team): LockedDir {
    const dataDir = this.#registry.dataDir;
    const paDir = team && this.#isPaTeam(team) && this.#pa ? this.#pa.paths.dir : '';
    return { dir: dataDir, open: [join(dataDir, 'art'), this.#inboxDir, this.#outboxDir, paDir].filter(Boolean) };
  }

  #isPaTeam(team: Pick<Team, 'id'>): boolean {
    return /assistant/i.test(team.id);
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

  stopTask(taskId: string, by: 'owner' | 'killall' = 'owner'): void {
    const task = this.#bus.state.tasks[taskId];
    if (!task || ['done', 'failed', 'paused'].includes(task.status)) return;
    this.#stopping.add(taskId);
    this.#patchTask(taskId, { stoppedBy: by }); // decides whether the ask stays in the thread

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
    for (const childId of this.#splitChildren.get(taskId) ?? []) this.stopTask(childId, by);
    // If the task was queued, drop it from its team's queue.
    if (task.teamId) {
      const queue = this.#queues.get(task.teamId);
      if (queue) this.#queues.set(task.teamId, queue.filter((queued) => queued !== taskId));
    }
    this.#activity('master', taskId, `task stopped by you: ${task.title.slice(0, 50)}`);
  }

  // The owner's conversation so far: the project of their latest ask (what an
  // unnamed follow-up inherits) and their last few asks as routing context.
  // A task the owner stopped doesn't count — a misrouted task they killed must
  // not drag the next ask into the same wrong project. KILL ALL and a hub
  // restart are not verdicts on the project, so those asks keep the thread.
  #routingThread(excludeTaskId: string): RoutingThread {
    const counts = (task: Task) =>
      task.status !== 'paused' || task.stoppedBy === 'killall' || task.stoppedBy === 'restart';
    const asks = Object.values(this.#bus.state.tasks)
      .filter((task) => task.ownerAsk && task.projectId && task.id !== excludeTaskId && counts(task))
      .sort((a, b) => a.createdAt - b.createdAt);
    return {
      projectId: asks[asks.length - 1]?.projectId ?? null,
      recent: asks.slice(-4).map((task) => `"${task.ownerAsk!.replace(/\s+/g, ' ').slice(0, 200)}" → ${task.title}`),
    };
  }

  async #intake(rawText: string): Promise<void> {
    // "@<project> do something" pins the task to a project explicitly.
    let text = rawText.trim();
    let forcedProjectId: string | null = null;
    const atMatch = text.match(/^@(\S+)\s+([\s\S]+)$/);
    let unknownPin: string | null = null;
    if (atMatch && atMatch[1] && atMatch[2]) {
      const forced = this.#projects.find(atMatch[1]);
      if (forced) {
        forcedProjectId = forced.id;
        text = atMatch[2].trim();
      } else {
        unknownPin = atMatch[1];
      }
    }

    this.#taskCounter += 1;
    const taskId = `t-${now().toString(36)}-${this.#taskCounter}`;

    // A pin to a project that isn't registered must not quietly run somewhere
    // else: nothing runs, and the owner is told what to do instead.
    if (unknownPin) {
      const known = this.#projects
        .all()
        .map((project) => `@${project.id}`)
        .join(', ');
      this.#publishTask({
        id: taskId,
        title: text.slice(0, 60),
        detail: text,
        projectId: null,
        teamId: null,
        ownerAsk: null, // never joins the thread
        status: 'failed',
        progressPct: 0,
        agentIds: [],
        synopsis:
          `Not run: no project "@${unknownPin}" is registered, so there is nowhere safe to run this. ` +
          `Register it with /project add ${unknownPin} <path>, or resend with one of: ${known}.`,
        tokensUsed: 0,
        createdAt: now(),
        updatedAt: now(),
      });
      this.#activity('master', taskId, `refused "@${unknownPin}" — no such project is registered (known: ${known})`);
      return;
    }

    this.#publishTask({
      id: taskId,
      title: text.slice(0, 60),
      detail: text,
      projectId: forcedProjectId,
      teamId: null,
      ownerAsk: text,
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
    const thread = this.#routingThread(taskId);
    const decision = await routeTask(
      this.#engine,
      this.#teamsWithRules(),
      this.#projects.all(),
      this.#projects.defaultProject().id,
      text,
      forcedProjectId,
      masterModel,
      thread,
      this.#masterRules(MASTER_SECTIONS.routing, 'plan'),
    );
    this.#recordTokens(masterModel.tier, decision.tokens);
    this.#routingCount -= 1;

    const team = this.#registry.get(decision.teamId);
    if (!team) {
      this.#patchTask(taskId, { status: 'failed', synopsis: 'Routing failed: no team available.' });
      this.#masterStatus();
      return;
    }

    let project = this.#projects.get(decision.projectId) ?? this.#projects.defaultProject();
    let basis: string = {
      pinned: '@pin',
      named: 'named in your ask',
      thread: 'continues your thread',
      default: 'no thread yet — default project',
    }[decision.projectBasis];

    // Naming a project in passing ("make PancakeStack look like CastleWars")
    // must not silently hand another repo to a worker with write access:
    // leaving the thread's project takes the owner's OK. Denied keeps it home.
    const threadProject = thread.projectId ? this.#projects.get(thread.projectId) : undefined;
    if (decision.projectBasis === 'named' && threadProject && project.id !== threadProject.id) {
      this.#patchTask(taskId, { teamId: team.id, title: decision.title });
      const switchOk = (await this.#confirmProjectSwitch(taskId, team, project, threadProject)) === 'approve';
      if (this.#halted(taskId)) {
        this.#stopping.delete(taskId);
        this.#masterStatus();
        return;
      }
      if (!switchOk) project = threadProject;
      basis = switchOk ? `you approved leaving ${threadProject.name}` : 'kept in your thread — switch declined';
    }
    if (this.#halted(taskId)) {
      // Stopped while routing: don't let the chain/queue below revive it.
      this.#stopping.delete(taskId);
      this.#masterStatus();
      return;
    }

    if (decision.steps) {
      this.#activity('master', taskId, `project: ${project.name} (${basis})`);
      void this.#runChain(taskId, decision.steps, project.id, decision.title);
      this.#masterStatus();
      return;
    }

    this.#patchTask(taskId, { teamId: team.id, projectId: project.id, title: decision.title, status: 'queued' });
    this.#activity(
      'master',
      taskId,
      `routed "${decision.title}" → ${team.name} · ${project.name} (${basis})${decision.fallback ? ' (keyword fallback)' : ''}`,
    );

    this.#startOrQueue(taskId, team, true);
    this.#masterStatus();
  }

  // Sequenced multi-team plan: each step runs after the previous one and
  // receives its synopsis as a handover; QA follows only the final step.
  async #runChain(firstTaskId: string, steps: PlanStep[], projectId: string, overallTitle: string, recoveryRound = 0): Promise<void> {
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
      if (recoveryRound) this.#recoveryRound.set(taskId, recoveryRound);
      const record: Task = {
        id: taskId,
        title: `Step ${index + 1}/${steps.length} — ${step.title}`.slice(0, 60),
        detail,
        projectId,
        teamId: team.id,
        ownerAsk: index === 0 ? this.#bus.state.tasks[taskId]?.ownerAsk ?? null : null,
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
    // The owner's standing rules for this team; the project's CLAUDE.md (the
    // SDK loads it for the worker) adds on top. Only this project's decided
    // conflicts are shown — never another project's.
    if (task.teamId) {
      const { rules, tools, resolutions } = parseRules(this.#registry.readRules(task.teamId));
      if ((rules.length > 0 || tools.length > 0) && history.length === 0 && !teamMemory) sections.push('---');
      // The team's tools: what to reach for, for which job. Guidance only —
      // every command still goes through the normal permission checks.
      if (tools.length > 0) {
        sections.push(
          "Tools your team has (from the owner) — use them for the jobs they're listed for:",
          ...tools.map((tool) => `- ${tool}`),
          '',
        );
      }
      if (rules.length > 0) {
        const decided = this.#projectResolutions(resolutions, task.projectId ?? this.#projects.defaultProject().id);
        sections.push(
          'Team rules from the owner — follow them in every project:',
          ...rules.map((rule) => `- ${rule}`),
          '',
          "This project's own CLAUDE.md (already loaded for you) adds on top of these rules.",
        );
        if (decided.length > 0) {
          sections.push(
            'Conflicts the owner already decided for this project (these override both rule sets):',
            ...decided.map((line) => `- ${line}`),
            '',
          );
        }
        sections.push(
          "If a team rule and this project's CLAUDE.md contradict and nothing above settles it, don't pick one yourself: " +
            'do the rest of the task and describe the conflict in your report so the owner can decide.',
        );
      }
    }
    if (this.#projects.roots.length > 0) {
      const workspaceDir =
        ((task.projectId ? this.#projects.get(task.projectId) : undefined) ?? this.#projects.defaultProject())
          .workspaceDir || this.#workspaceDir;
      const rootList = this.#projects.roots.map((root) => `${root.path} (${root.label})`).join(' · ');
      sections.push(
        `File locations policy: you may READ and SEARCH anywhere under these roots, including ALL subdirectories at any depth — recurse into them when searching: ${rootList}. ` +
          `You may WRITE (create, edit, move or delete files) only inside THIS project's workspace — ${workspaceDir}${
            task.teamId && this.#isPaTeam({ id: task.teamId }) && this.#pa ? ` — and the PA desk at ${this.#pa.paths.dir}` : ''
          } — plus the phone inbox/outbox named below; writes anywhere else are refused. ` +
          'Reading another project for reference is fine; changing it is not. If a task needs changes in a folder that is not this project, stop and say so in your report — ask the owner to register it (/project add <name> <path>) rather than writing into it. ' +
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
    // Everything this worker may touch, decided once: the file tools are
    // scoped to it by the SDK, and the policy gates shell writes that leave it.
    const scope = {
      cwd: project.workspaceDir || this.#workspaceDir,
      extraDirs: this.#extraDirs(project.workspaceDir || this.#workspaceDir, team),
      locked: this.#lockedData(team),
    };
    this.#runningCwds.set(taskId, scope.cwd);

    try {
      // Team rules vs this project's CLAUDE.md: the owner settles genuine
      // conflicts before the worker starts (the prompt is built after, so it
      // carries the answers).
      await this.#settleRuleConflicts(taskId, team, project, workerId);
      if (this.#stopping.has(taskId)) throw new Error('stopped while settling rules');
      const result = await this.#engine.runWorker({
        prompt: this.#buildWorkerPrompt(this.#bus.state.tasks[taskId] ?? task),
        team,
        model: workerSpec,
        cwd: scope.cwd,
        extraDirs: scope.extraDirs,
        locked: scope.locked,
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
            // The shell is not confined by the SDK's directory grants, so the
            // policy gets the worker's scope and gates writes that leave it.
            const verdict = evaluatePermission(toolName, command, this.#policy.mode, scope);
            if (verdict.decision === 'allow') return Promise.resolve('approve' as const);
            return this.#raisePermission(taskId, workerId, team, toolName, command, reason, verdict.flags);
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
      const review = await reviewWorkerReport(
        this.#engine,
        team,
        task.title,
        result.synopsis,
        leadSpec,
        parseRules(this.#registry.readRules(team.id)).rules,
      );
      this.#recordTokens(leadSpec.tier, review.tokens);
      if (review.memoryNote) {
        this.#registry.appendMemory(team.id, review.memoryNote);
        this.#activity(`${team.id}-lead`, taskId, `noted for the team: ${review.memoryNote.slice(0, 80)}`);
      }

      // The lead says the worker couldn't finish: the task is stuck — no QA,
      // no handover pass; the master proposes a way forward instead.
      if (review.stuck) {
        const synopsis = `Stuck — ${review.stuck}\n${review.synopsis || ''}`.trim();
        this.#patchTask(taskId, { status: 'failed', progressPct: 100, synopsis });
        this.#activity(`${team.id}-lead`, taskId, `stuck: ${review.stuck.slice(0, 80)}`);
        if (!team.allowedTools.includes('bash') && result.synopsis.trim().length > 300) {
          this.#deliverReport(task, team, result.synopsis, synopsis);
        }
        void this.#recoverStuck(taskId, team, 'blocked', review.stuck);
        return null;
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
        // A split piece's failure is its parent's to handle.
        if (!piece) void this.#recoverStuck(taskId, team, 'failed', message);
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
      this.#masterRules(MASTER_SECTIONS.splitting, 'split'),
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
    this.#carryRecovery(parentId, pieceId);
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
    this.#carryRecovery(sourceTaskId, taskId);
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
      this.#teamsWithRules(),
      team,
      task.title,
      synopsis,
      checksModel,
      this.#masterRules(MASTER_SECTIONS.handover),
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
      this.#carryRecovery(taskId, followId);
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

  // --- stuck tasks ------------------------------------------------------
  // A run failed, the lead says the worker couldn't finish, or QA still
  // fails after two fix rounds: the master proposes ONE way forward (retry /
  // handover / split) from the owner's master rules and the team's charters
  // and tools, then asks — unless those rules explicitly let it act alone.
  // Work a recovery spawned (and everything descending from it: QA, fixes,
  // handovers) is never auto-recovered again; it escalates to the owner.

  // Pass the recovery round to tasks spawned from `fromId`.
  #carryRecovery(fromId: string, toId: string): void {
    const round = this.#recoveryRound.get(fromId);
    if (round) this.#recoveryRound.set(toId, round);
  }

  async #recoverStuck(
    taskId: string,
    team: Team,
    kind: StuckContext['kind'],
    problem: string,
    opts: { allowRetry?: boolean } = {},
  ): Promise<void> {
    const task = this.#bus.state.tasks[taskId];
    if (!task || isInternalTask(task) || this.#recoveryAsked.has(taskId)) return;
    this.#recoveryAsked.add(taskId);
    if ((this.#recoveryRound.get(taskId) ?? 0) >= 1) {
      this.#activity('master', taskId, `still stuck after a recovery — needs you: ${task.title.slice(0, 50)}`);
      return;
    }
    const model = this.#checksModel();
    this.#patchAgent('master', { status: 'working', activity: `finding a way past: ${task.title.slice(0, 40)}` });
    const { plan, tokens } = await planRecovery(
      this.#engine,
      this.#teamsWithRules(),
      { team, taskTitle: task.title, taskDetail: task.detail, problem, kind, allowRetry: opts.allowRetry ?? true },
      this.#masterRules('stuck', MASTER_SECTIONS.handover, MASTER_SECTIONS.splitting),
      model,
    );
    this.#recordTokens(model.tier, tokens);
    this.#masterStatus();
    if (!plan || plan.action === 'ask') {
      this.#activity('master', taskId, `stuck: ${task.title.slice(0, 45)} — needs you${plan ? `: ${plan.why}` : ''}`);
      return;
    }
    const description = this.#describeRecovery(plan, team);
    if (plan.auto) {
      this.#activity('master', taskId, `stuck: ${task.title.slice(0, 45)} — ${description} (your master rules allow it without asking)`);
      this.#runRecovery(taskId, team, plan, problem);
      return;
    }
    if ((await this.#askRecovery(task, team, plan, problem, description)) === 'approve') {
      this.#runRecovery(taskId, team, plan, problem);
    } else {
      this.#activity('master', taskId, `left as is: ${task.title.slice(0, 50)}`);
    }
  }

  #describeRecovery(plan: RecoveryPlan, team: Team): string {
    if (plan.action === 'retry') return `try again on the ${team.name} with a different approach`;
    if (plan.action === 'handover') return `hand it to the ${this.#registry.get(plan.teamId ?? '')?.name ?? plan.teamId}`;
    const route = plan.steps.map((step) => this.#registry.get(step.teamId)?.name ?? step.teamId).join(' → ');
    return `split it into ${plan.steps.length} steps (${route})`;
  }

  // A master card with two answers; approve runs the proposal.
  #askRecovery(task: Task, team: Team, plan: RecoveryPlan, problem: string, description: string): Promise<'approve' | 'deny'> {
    const requestId = `stuck-${task.id}`;
    const details =
      plan.action === 'split'
        ? plan.steps.map((step, index) => `${index + 1}. ${this.#registry.get(step.teamId)?.name ?? step.teamId}: ${step.title} — ${step.instruction}`).join('\n')
        : plan.instruction;
    this.#bus.publish({
      type: 'permission.updated',
      request: {
        id: requestId,
        taskId: task.id,
        agentId: 'master',
        teamId: team.id,
        command: `Proposal: ${description}\n${details}`,
        summary:
          `${team.name} got stuck on "${task.title.slice(0, 60)}": ${problem.replace(/\s+/g, ' ').slice(0, 160)}. ` +
          `The master suggests: ${description}. ${plan.why}`,
        choices: ['Do it', 'Leave it'],
        flags: ['stuck'],
        reason: plan.why,
        status: 'pending',
        scope: 'once',
        requestedAt: now(),
        resolvedAt: null,
      },
    });
    this.#activity('master', task.id, `stuck: ${task.title.slice(0, 45)} — suggesting: ${description}`);
    return new Promise((resolve) => this.#pendingResolvers.set(requestId, resolve));
  }

  #runRecovery(taskId: string, team: Team, plan: RecoveryPlan, problem: string): void {
    const task = this.#bus.state.tasks[taskId];
    if (!task) return;
    const round = (this.#recoveryRound.get(taskId) ?? 0) + 1;
    const baseTitle = task.title.replace(/^\[(retry|handover)\]\s*/i, '');
    const context =
      `This continues a stuck task ("${task.title}", ${team.name}). What stopped it: ${problem.replace(/\s+/g, ' ').slice(0, 600)}\n\n` +
      `The original ask: ${task.detail.slice(0, 1500)}`;
    if (plan.action === 'split') {
      const firstId = `t-${now().toString(36)}-${++this.#taskCounter}`;
      this.#recoveryRound.set(firstId, round);
      const steps = plan.steps.map((step, index) => (index === 0 ? { ...step, instruction: `${step.instruction}\n\n${context}` } : step));
      void this.#runChain(firstId, steps, task.projectId ?? this.#projects.defaultProject().id, baseTitle, round);
      return;
    }
    const target = this.#registry.get(plan.teamId ?? '');
    if (!target) return;
    if (target.id !== team.id) {
      this.#holdMeeting([`${team.id}-lead`, `${target.id}-lead`], `stuck: ${baseTitle.slice(0, 32)}`);
    }
    const followId = `t-${now().toString(36)}-${++this.#taskCounter}`;
    this.#taskDepth.set(followId, (this.#taskDepth.get(taskId) ?? 0) + 1);
    this.#recoveryRound.set(followId, round);
    this.#publishTask({
      id: followId,
      title: `[${plan.action}] ${baseTitle}`.slice(0, 60),
      detail: `${plan.instruction}\n\n${context}`,
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
    this.#activity('master', followId, `${plan.action === 'retry' ? 'retrying' : 'handed over'} on ${target.name}: ${baseTitle.slice(0, 45)}`);
    this.#startOrQueue(followId, target, true);
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
        `QA still failing after ${round} fix rounds: ${rootTitle.slice(0, 45)}`,
      );
      // Stuck: the same team already tried twice, so no plain retry.
      void this.#recoverStuck(source.id, sourceTeam, 'qa', evaluation.summary || qaSynopsis, { allowRetry: false });
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
    this.#carryRecovery(qaTaskId, fixId);
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
      summary: `${team.name} has ${queue.length} tasks waiting in line. Approving lets it run one more worker at the same time, so the backlog clears faster but uses your limits faster.`,
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

  // --- team rules vs project rules ---------------------------------------

  // The project's own rules file, as its workers' SDK session loads it.
  #projectRulesMd(project: Project): string {
    const dir = project.workspaceDir || this.#workspaceDir;
    for (const path of [join(dir, 'CLAUDE.md'), join(dir, '.claude', 'CLAUDE.md')]) {
      try {
        if (existsSync(path)) return readFileSync(path, 'utf8').slice(0, 8000);
      } catch {
        // unreadable: treated as no project rules
      }
    }
    return '';
  }

  // Resolutions are recorded as "[<projectId>] …"; a project only sees its own.
  #projectResolutions(resolutions: string[], projectId: string): string[] {
    const prefix = `[${projectId}] `;
    return resolutions.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
  }

  #rulesKey(teamId: string, project: Project, parsed: ParsedRules, projectMd: string): string {
    const digest = createHash('sha1')
      .update(parsed.rules.join('\n'))
      .update('\0')
      .update(this.#projectResolutions(parsed.resolutions, project.id).join('\n'))
      .update('\0')
      .update(projectMd)
      .digest('hex');
    return `${teamId}|${project.id}|${digest}`;
  }

  // Zero cost unless the team has rules AND the project has a CLAUDE.md;
  // then one quick check per version of the two, shared by parallel runs.
  async #settleRuleConflicts(taskId: string, team: Team, project: Project, workerId: string): Promise<void> {
    const parsed = parseRules(this.#registry.readRules(team.id));
    if (parsed.rules.length === 0) return;
    const projectMd = this.#projectRulesMd(project);
    if (!projectMd.trim()) return;
    const key = this.#rulesKey(team.id, project, parsed, projectMd);
    if (this.#rulesSettled.has(key)) return;
    let check = this.#rulesChecks.get(key);
    if (!check) {
      check = this.#checkRuleConflicts(taskId, team, project, parsed, projectMd, workerId, key).finally(() =>
        this.#rulesChecks.delete(key),
      );
      this.#rulesChecks.set(key, check);
    }
    await check;
  }

  async #checkRuleConflicts(
    taskId: string,
    team: Team,
    project: Project,
    parsed: ParsedRules,
    projectMd: string,
    workerId: string,
    key: string,
  ): Promise<void> {
    this.#patchAgent(workerId, { activity: `checking team rules against ${project.name}` });
    const model = this.#checksModel();
    const result = await detectRuleConflicts(
      this.#engine,
      {
        teamName: team.name,
        projectName: project.name,
        teamRules: parsed.rules,
        resolutions: this.#projectResolutions(parsed.resolutions, project.id),
        projectMd,
      },
      model,
    );
    this.#recordTokens(model.tier, result.tokens);
    if (!result.ok) {
      // Not settled: the worker is told to report conflicts, and the next run checks again.
      this.#activity('master', taskId, `couldn't check ${team.name} rules against ${project.name} — the worker will flag any conflict`);
      return;
    }
    for (const [index, conflict] of result.conflicts.entries()) {
      const winner = await this.#askRuleConflict(taskId, team, project, conflict, workerId, index);
      if (!winner) return; // stopped before answering: nothing recorded, asked again next time
      const rule = winner === 'project' ? `${project.name}'s rule` : 'the team rule';
      this.#registry.recordResolution(
        team.id,
        `[${project.id}] ${conflict.topic}: follow ${rule} — team: "${conflict.teamRule}" / ${project.name}: "${conflict.projectRule}" (decided ${new Date().toISOString().slice(0, 10)})`,
      );
      this.#publishTeam(team);
      this.#activity('master', taskId, `${team.name} in ${project.name}: ${conflict.topic} → following ${rule} (saved to the team's rules)`);
    }
    this.#rulesSettled.add(key);
    // Recording answers changed the file; that version is settled too.
    const after = parseRules(this.#registry.readRules(team.id));
    this.#rulesSettled.add(this.#rulesKey(team.id, project, after, projectMd));
  }

  // A master card with two answers: approve = the project's rule wins, deny =
  // the team's rule wins (the signed decision stays approve/deny). Resolves
  // null when the card expired instead (the task was stopped).
  async #askRuleConflict(
    taskId: string,
    team: Team,
    project: Project,
    conflict: RuleConflict,
    workerId: string,
    index: number,
  ): Promise<'project' | 'team' | null> {
    const requestId = `rules-${team.id}-${project.id}-${now().toString(36)}-${index}`;
    const teamLabel = team.name.replace(/ team$/i, '');
    this.#bus.publish({
      type: 'permission.updated',
      request: {
        id: requestId,
        taskId,
        agentId: 'master',
        teamId: team.id,
        command: `${team.name} rule: "${conflict.teamRule}"\n${project.name} CLAUDE.md: "${conflict.projectRule}"`,
        summary:
          `${team.name}'s rules say "${conflict.teamRule}", but ${project.name}'s CLAUDE.md says "${conflict.projectRule}". ` +
          `Which should ${teamLabel} follow in ${project.name}? Your choice is saved to the team's rules.`,
        choices: [`Follow ${project.name}`, `Follow ${teamLabel} rules`],
        flags: ['rule conflict'],
        reason: `Rule conflict on ${conflict.topic}. Approve = ${project.name}'s CLAUDE.md wins; deny = the ${team.name} rule wins.`,
        status: 'pending',
        scope: 'once',
        requestedAt: now(),
        resolvedAt: null,
      },
    });
    this.#patchAgent(workerId, { status: 'waiting_permission', activity: 'waiting on your rule choice' });
    this.#patchAgent('master', { status: 'waiting_permission', activity: `asking which ${conflict.topic} rule wins` });
    this.#patchTask(taskId, { status: 'awaiting_permission' });
    this.#activity('master', taskId, `${team.name} rules and ${project.name}'s CLAUDE.md disagree on ${conflict.topic} — asking you`);
    const decision = await new Promise<'approve' | 'deny'>((resolve) => this.#pendingResolvers.set(requestId, resolve));
    this.#masterStatus();
    if (this.#bus.state.permissions[requestId]?.status === 'expired') return null;
    // Restore only this task (a parallel part may share the answer).
    if (this.#bus.state.tasks[taskId]?.status === 'awaiting_permission') this.#patchTask(taskId, { status: 'in_flight' });
    this.#patchAgent(workerId, { status: 'working', activity: 'rules settled — starting' });
    return decision === 'approve' ? 'project' : 'team';
  }

  #raisePermission(
    taskId: string,
    workerId: string,
    team: Team,
    toolName: string,
    command: string,
    reason: string,
    flags: string[] = [],
  ): Promise<'approve' | 'deny'> {
    const requestId = `perm-${now().toString(36)}-${workerId}`;
    const context: PermissionContext = {
      teamName: team.name,
      taskTitle: this.#bus.state.tasks[taskId]?.title ?? 'its task',
      toolName,
      command,
      flags,
    };
    const request: PermissionRequest = {
      id: requestId,
      taskId,
      agentId: workerId,
      teamId: team.id,
      command,
      summary: plainPermissionSummary(context),
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
    void this.#explainCard(requestId, context);
    return new Promise((resolve) => this.#pendingResolvers.set(requestId, resolve));
  }

  // Swap the rule-based summary for the master's explanation — only while
  // the card is still pending, so a late answer never reopens a decided card.
  async #explainCard(requestId: string, context: PermissionContext): Promise<void> {
    const model = this.#checksModel();
    const { summary, tokens } = await explainPermission(this.#engine, context, model);
    this.#recordTokens(model.tier, tokens);
    const current = this.#bus.state.permissions[requestId];
    if (summary && current && current.status === 'pending') {
      this.#bus.publish({ type: 'permission.updated', request: { ...current, summary } });
    }
  }

  // The master's card for an ask that names a project other than the one the
  // conversation is in. No worker exists yet; intake waits on the answer.
  #confirmProjectSwitch(taskId: string, team: Team, target: Project, current: Project): Promise<'approve' | 'deny'> {
    const requestId = `route-${taskId}`;
    this.#bus.publish({
      type: 'permission.updated',
      request: {
        id: requestId,
        taskId,
        agentId: 'master',
        teamId: team.id,
        command: `Run this in ${target.name} instead of ${current.name}?`,
        summary: `Your message mentions ${target.name}, but you've been working in ${current.name}. Approve to run this task in ${target.name}; deny keeps it in ${current.name}.`,
        flags: ['leaves your current project'],
        reason:
          `Your ask names ${target.name}, but your conversation is in ${current.name}. ` +
          `Approve to run it in ${target.name} (its workers can write there); deny keeps it in ${current.name}. ` +
          `Prefix @${target.id} to skip this check.`,
        status: 'pending',
        scope: 'once',
        requestedAt: now(),
        resolvedAt: null,
      },
    });
    this.#patchAgent('master', { status: 'waiting_permission', activity: `asking before moving to ${target.name}` });
    this.#patchTask(taskId, { status: 'awaiting_permission' });
    this.#activity('master', taskId, `your ask names ${target.name} but the thread is ${current.name} — asking first`);
    return new Promise((resolve) => this.#pendingResolvers.set(requestId, resolve));
  }

  respondPermission(requestId: string, decision: 'approve' | 'deny'): void {
    const request = this.#bus.state.permissions[requestId];
    if (!request || request.status !== 'pending') return;
    this.#bus.publish({
      type: 'permission.updated',
      request: { ...request, status: decision === 'approve' ? 'approved' : 'denied', resolvedAt: now() },
    });
    // Master's project-switch card: intake is waiting and sets the task's
    // status and project itself. Rule-conflict cards: the run waiting on the
    // answer records it and restores the task's status.
    if (requestId.startsWith('route-') || requestId.startsWith('rules-') || requestId.startsWith('stuck-')) {
      const resolve = this.#pendingResolvers.get(requestId);
      this.#pendingResolvers.delete(requestId);
      resolve?.(decision);
      return;
    }
    // Master's scale-up ask: no worker is waiting on this — approving raises
    // the team's worker cap by one and drains its queue.
    if (requestId.startsWith('scale-') && request.teamId) {
      if (decision === 'approve') {
        const team = this.#registry.get(request.teamId);
        const updated = team
          ? this.#registry.update({ teamId: team.id, maxConcurrentWorkers: team.maxConcurrentWorkers + 1 })
          : null;
        if (updated) {
          this.#publishTeam(updated);
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
    this.#publishTeam(team);
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
    this.#publishTeam(team);
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
    for (const task of active) this.stopTask(task.id, 'killall');
    this.#queues.clear();
    this.#freelancers?.killAll?.();
    // The thread survives a kill (it isn't a verdict on the project) — say
    // where the next unnamed ask will go so nothing lands somewhere surprising.
    const threadId = this.#routingThread('').projectId;
    const threadName = threadId ? (this.#projects.get(threadId)?.name ?? threadId) : null;
    this.#activity(
      'master',
      null,
      `KILL ALL — stopped ${active.length} task(s); queues cleared. ` +
        (threadName
          ? `Your next unnamed ask still continues in ${threadName} (prefix @project to change).`
          : 'No conversation thread yet — the next unnamed ask goes to the default project.'),
    );
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
