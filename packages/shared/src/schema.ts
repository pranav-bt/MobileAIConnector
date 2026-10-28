import { z } from 'zod';

// The provider-agnostic vocabulary of Agent HQ. Everything the hub, the
// desktop app, and the phone exchange is defined here. A Codex adapter (or
// any other engine) plugs in by emitting these same events.

// Model family — the bucket usage meters and office chips use. 'codex' is
// every OpenAI Codex model (a second engine, see MODEL_CATALOG.engine).
export const ModelTierSchema = z.enum(['opus', 'sonnet', 'haiku', 'codex']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

// Tier -> concrete model id. Only the engine layer reads this.
export const MODEL_IDS: Record<ModelTier, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-5-5',
  codex: 'gpt-6.1-sol',
};

// Pair mode's default reviewer, by the AUTHOR's engine: the other engine's
// flagship (the owner's reviewer choices layer over this).
export const PAIR_REVIEWER_DEFAULT: Record<'claude' | 'codex', string> = {
  claude: 'gpt-6.1-sol',
  codex: 'claude-opus-5-5',
};

// Which engine runs a model. The event vocabulary is the same for both.
export const EngineIdSchema = z.enum(['claude', 'codex']);
export type EngineId = z.infer<typeof EngineIdSchema>;

export const AgentRoleSchema = z.enum(['master', 'lead', 'worker', 'freelancer']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentStatusSchema = z.enum([
  'idle',
  'working',
  'waiting_permission',
  'reporting',
  'blocked',
  'offline',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const TaskStatusSchema = z.enum([
  'intake',
  'routing',
  'queued',
  'in_flight',
  'awaiting_permission',
  'review',
  'done',
  'failed',
  'paused',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PermissionDecisionSchema = z.enum(['approve', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionScopeSchema = z.enum(['once', 'task']);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

export const PermissionStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: AgentRoleSchema,
  teamId: z.string().nullable(),
  status: AgentStatusSchema,
  activity: z.string(),
  model: ModelTierSchema,
  // The exact model it runs (catalog id) — chips show its label.
  modelId: z.string().optional(),
  taskId: z.string().nullable(),
  tokensUsed: z.number(),
  updatedAt: z.number(),
});
export type Agent = z.infer<typeof AgentSchema>;

// A team is pure config — creating one is inserting this record.
export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  charter: z.string(),
  allowedTools: z.array(z.string()),
  blockedTools: z.array(z.string()),
  leadModel: ModelTierSchema,
  workerModel: ModelTierSchema,
  maxConcurrentWorkers: z.number().int().positive(),
  quotaSharePct: z.number().min(0).max(100),
  memoryDir: z.string(),
  // Per-team MCP server grants (name -> SDK server config): the team's
  // workers get exactly these connections (e.g. Roblox Studio for QA).
  mcpServers: z.record(z.string(), z.unknown()).default({}),
  // The owner's standing rules for this team (RULES.md in memoryDir), mirrored
  // so clients can show and edit them. A project's CLAUDE.md adds on top.
  rules: z.string().optional(),
  // The team's notes (MEMORY.md in memoryDir): lessons its workers wrote down
  // so the next one doesn't work them out again. Mirrored like rules.
  notes: z.string().optional(),
  createdAt: z.number(),
});
export type Team = z.infer<typeof TeamSchema>;

// 'ultra' exists only on some Codex models; each catalog entry lists its own.
export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

// One role's choice: model and effort are independent, so "all workers:
// effort low" composes with "Coding workers: Opus 5.5". Missing = default.
export const ModelChoiceSchema = z.object({
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

export const PairModeSchema = z.enum(['review', 'split', 'debate']);
export type PairMode = z.infer<typeof PairModeSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  projectId: z.string().nullable(),
  teamId: z.string().nullable(),
  status: TaskStatusSchema,
  progressPct: z.number().min(0).max(100),
  agentIds: z.array(z.string()),
  synopsis: z.string().nullable(),
  tokensUsed: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // Set on internal split pieces ([scaffold]/[part k/n]): the id of the
  // user-facing task they build. They show while running, but never in
  // finished lists or project history — the parent's report covers them.
  parentTaskId: z.string().nullable().optional(),
  // One window per ask: a STEP of the owner's ask — a QA pass, a handover to
  // another team, a recovery move, a later step of a plan, a split piece —
  // carries the ask's task id. Clients fold steps into the ask's card, and
  // the ask's console carries every step's rows (`stepTaskId` on them).
  rootTaskId: z.string().nullable().optional(),
  // The owner's own words, set only on tasks the owner submitted (never on
  // QA/fix/follow-up/split tasks). Routing reads these to follow the
  // conversation thread instead of guessing a project from topic words.
  ownerAsk: z.string().nullable().optional(),
  // Why a paused task stopped. Only 'owner' (stopping that one task) drops an
  // ask from the thread; KILL ALL and a hub restart keep the conversation.
  stoppedBy: z.enum(['owner', 'killall', 'restart']).nullable().optional(),
  // The worker's conversation (Claude session / Codex thread), so the task
  // can be continued from its console with full memory — even after a restart.
  session: z.object({ engine: EngineIdSchema, id: z.string() }).nullable().optional(),
  // The model this task's worker runs on, when it isn't the team's worker
  // seat (a pair split's part runs on the engine that agreed to build it).
  seat: ModelChoiceSchema.nullable().optional(),
  // The owner asked for a QA pass on this ask ("/qa …", or `qa` on
  // task.submit), whatever the "## QA" rules say for its team.
  qa: z.boolean().optional(),
  // The Roblox Studio window this ask's workers may drive (its place name,
  // or the placeId) — `studio:<name>` in the ask, or `studio` on task.submit.
  // Steps of the ask use the ask's. Any other open Studio is the owner's.
  studio: z.string().nullable().optional(),
  // Pair mode: two workers on two engines. 'review' = second opinion — the
  // author does the work, the reviewer (read-only) checks the actual result,
  // rounds repeat until the reviewer agrees (or the round cap asks the owner).
  // 'split' = they agree a plan first, split the parts between them, each
  // part is reviewed by the other model, and the integrated whole once more.
  // 'debate' = both draft independently, then critique and revise each
  // other's drafts until one accepts the other's.
  pair: z
    .object({
      mode: PairModeSchema,
      maxRounds: z.number().int().min(1),
      round: z.number().int().min(0),
      state: z.enum(['working', 'reviewing', 'agreed', 'disagreed']).optional(),
      rounds: z
        .array(
          z.object({
            round: z.number().int(),
            author: z.string(), // the author's report, capped
            agree: z.boolean(),
            blocking: z.array(z.string()),
            minor: z.array(z.string()),
            summary: z.string(),
            version: z.string().optional(), // the reviewed state of the work
          }),
        )
        .default([]),
      reviewerSession: z.object({ engine: EngineIdSchema, id: z.string() }).nullable().optional(),
      reviewerModel: z.string().optional(), // catalog id of the reviewer seat
      authorModel: z.string().optional(), // catalog id of the author (worker) seat
      // This task's reviewer, when set by the pair itself (a split part is
      // reviewed by the OTHER builder); else the owner's reviewer choices.
      reviewer: ModelChoiceSchema.optional(),
      // 'split': the plan both models agreed (who builds what) and its rounds.
      plan: z
        .object({
          rounds: z.number().int(),
          agreed: z.boolean(),
          contract: z.string(),
          scaffold: z.string().nullable(),
          parts: z.array(
            z.object({ title: z.string(), owns: z.array(z.string()), builder: z.enum(['author', 'partner']), taskId: z.string().optional() }),
          ),
        })
        .nullable()
        .optional(),
      // The author's planning / debate conversation.
      plannerSession: z.object({ engine: EngineIdSchema, id: z.string() }).nullable().optional(),
      // 'debate': the latest drafts and the last exchange.
      debate: z
        .object({
          rounds: z.number().int(), // round 1 = the independent drafts
          drafts: z.object({ author: z.string(), partner: z.string() }),
          accepted: z.enum(['author', 'partner']).nullable(),
          last: z
            .object({
              round: z.number().int(),
              authorAccepts: z.boolean(),
              partnerAccepts: z.boolean(),
              authorCritique: z.array(z.string()),
              partnerCritique: z.array(z.string()),
            })
            .nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// One row of a task's console transcript — the same shape whichever engine
// ran it. Rows are upserted by id (a tool row starts 'running' and is
// replaced with its output when done). Stored per task under
// data/transcripts/, never in the global event log; only clients watching
// that task receive them.
export const TranscriptEntrySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  at: z.number(),
  role: z.enum(['owner', 'worker', 'lead', 'master', 'system']),
  agentId: z.string().nullable().optional(),
  kind: z.enum(['message', 'thinking', 'tool', 'diff', 'card', 'status']),
  text: z.string(),
  detail: z.string().optional(), // tool output / diff body (capped)
  tool: z.string().optional(),
  state: z.enum(['running', 'ok', 'error']).optional(),
  requestId: z.string().optional(), // a card row: the PermissionRequest it shows
  linkTaskId: z.string().optional(), // a status row about another task (QA, fix, handover)
  stepTaskId: z.string().optional(), // a row mirrored from a step of this ask (QA, a handover…)
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// A folder the owner opened to every worker, in every project: 'write' =
// read and write there without a card (Agent HQ's own data stays locked);
// 'read' = named to workers as readable (reading never asks anyway, except
// credential-like files).
export const AccessGrantSchema = z.object({
  path: z.string().min(1).max(500),
  // full = read & write + deleting there needs no card (the owner's scratch
  // and hand-over space for workers, e.g. D:\Work\Bots).
  access: z.enum(['read', 'write', 'full']),
});
export type AccessGrant = z.infer<typeof AccessGrantSchema>;

// A desktop app the owner added (Settings > Apps) that teams can be granted
// like an MCP connection: Agent HQ's app bridge (packages/hub/apps) serves it
// to the worker — open (its window) / close / run (as a command-line tool),
// and for Blender a live Python (bpy) session, renders and a scene summary.
// It opens when a worker needs it and closes when the worker says so, after
// idleMinutes, or when the worker's session ends; it only ever closes what it
// opened. The id is the connection name teams are granted.
export const AppKindSchema = z.enum(['blender', 'generic']);
export const AppSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(60),
  exePath: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(20).default([]), // always passed first
  kind: AppKindSchema,
  visible: z.boolean().default(true), // false = Blender runs in the background (-b), other apps hidden
  idleMinutes: z.number().int().min(1).max(240).default(10),
  notes: z.string().max(1000).default(''), // shown to the worker with the tools
  createdAt: z.number(),
});
export type App = z.infer<typeof AppSchema>;
// An install found on this PC that isn't added yet (offered with an Add button).
export const AppSuggestionSchema = z.object({ name: z.string(), exePath: z.string(), kind: AppKindSchema });
export type AppSuggestion = z.infer<typeof AppSuggestionSchema>;

export function isInternalTask(task: Pick<Task, 'parentTaskId'>): boolean {
  return !!task.parentTaskId;
}

export const PermissionRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  teamId: z.string().nullable(),
  command: z.string(),
  // What the agent is trying to do, in plain English (1-2 sentences) — what
  // the owner reads first; the raw command stays one tap away. Rule-based at
  // first, then replaced by the master's explanation while still pending.
  summary: z.string().optional(),
  // Custom labels for the [approve, deny] buttons when the card is a question
  // rather than a permission (e.g. which rule wins). The signed decision is
  // still approve/deny, so phone signatures are unchanged.
  choices: z.tuple([z.string(), z.string()]).optional(),
  // A pick-one question (e.g. "which project is this for?"): one button per
  // option, each an approve carrying its index (`choice`), plus a deny
  // ("none of these"). Phone signatures then cover `${decision}:${id}#${choice}`.
  options: z.array(z.string()).min(1).max(4).optional(),
  flags: z.array(z.string()),
  reason: z.string(),
  status: PermissionStatusSchema,
  scope: PermissionScopeSchema,
  requestedAt: z.number(),
  resolvedAt: z.number().nullable(),
  // Decided by Away (the owner was away and didn't answer in time): what it
  // did and why. Away only ever takes the safe answer.
  auto: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

// A project = a workspace + a ledger. Workers run inside workspaceDir and
// only see that project's files and history. Quotas are token shares of the
// subscription limits — never dollars.
// The bots' worktree of a git project: a separate checkout on its own branch
// (agent-hq/<base>) cut from the owner's branch. Workers run there, so
// nothing they do touches the owner's folder or branch until the owner
// merges it (which removes the worktree) or discards it.
export const WorktreeSchema = z.object({
  root: z.string(), // the worktree's top folder (git worktree path)
  dir: z.string(), // where workers run: the project's folder inside it
  branch: z.string(), // agent-hq/<base>
  base: z.string(), // the owner's branch it was cut from and merges into
  ahead: z.number(), // commits on the bots' branch the owner's doesn't have
  behind: z.number(), // the owner's commits since (merged in when clean)
  changedFiles: z.number(),
  dirty: z.boolean(), // uncommitted changes in the worktree right now
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), at: z.number() })),
  note: z.string().nullable().optional(), // the last merge/catch-up problem, for the owner
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  workspaceDir: z.string(),
  quotaTokens: z.number(),
  usedTokens: z.number(),
  alerted75: z.boolean(),
  worktree: WorktreeSchema.nullable().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const UsageSchema = z.object({
  windowPct: z.number(),
  windowResetsAt: z.number(),
  weeklyPct: z.number(),
  weeklyResetsAt: z.number(),
  tokensToday: z.number(),
  // Of those, tokens re-read from the prompt cache (counted in tokensToday too).
  cachedTokensToday: z.number().default(0),
  modelMixPct: z.object({
    opus: z.number(),
    sonnet: z.number(),
    haiku: z.number(),
    codex: z.number().default(0),
  }),
  overageEnabled: z.boolean(),
  // The Codex (ChatGPT) plan's own limits, when Codex is in use. Plans differ
  // in which windows they report, so each is optional.
  codex: z
    .object({
      plan: z.string().nullable(),
      windowPct: z.number().nullable(),
      windowResetsAt: z.number().nullable(),
      weeklyPct: z.number().nullable(),
      weeklyResetsAt: z.number().nullable(),
    })
    .optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

// Live security posture: shown on the desktop Security page and the rail.
export const SecurityStateSchema = z.object({
  fingerprint: z.string(),
  pairedDevice: z.object({ name: z.string(), pairedAt: z.number() }).nullable(),
  // JSON payload rendered as a QR while pairing mode is active; null otherwise.
  pairingQr: z.string().nullable(),
  deviceSessions: z.number(),
});
export type SecurityState = z.infer<typeof SecurityStateSchema>;

export const ActivityEntrySchema = z.object({
  agentId: z.string(),
  taskId: z.string().nullable(),
  message: z.string(),
  at: z.number(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

// A file pushed to clients (phone foremost): a PC screenshot, a file sent
// from the desktop, or something a worker dropped into the outbox. Transient
// — never part of state or the event log.
export const SharedFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  bytesB64: z.string(),
  from: z.enum(['desktop', 'worker', 'pc-screen']),
  taskId: z.string().nullable(),
  at: z.number(),
});
export type SharedFile = z.infer<typeof SharedFileSchema>;
export const MAX_SHARED_FILE_BYTES = 6 * 1024 * 1024;

// Clients keep the most recent activity entries in state (capped) so task
// detail views and history have something to show.
export const ACTIVITY_LOG_CAP = 200;

export const WorkspaceRootSchema = z.object({
  key: z.string(),
  path: z.string(),
  label: z.string(),
});
export type WorkspaceRoot = z.infer<typeof WorkspaceRootSchema>;

// The models Settings > Models offers. Every id was verified to run through
// the hub's Agent SDK (packages/hub/test/probe-models.ts --live), and
// defaultEffort is the level Claude Code actually applied when the hub sent
// none (packages/hub/test/probe-effort-defaults.ts, re-measured 2026-10-26 on
// SDK 0.3.284) — re-run both after an SDK update. 'tier' is the family
// bucket the usage meters and office chips use (Fable counts as top tier).
export interface CatalogModel {
  id: string;
  label: string;
  engine: EngineId;
  tier: ModelTier;
  description: string;
  efforts: EffortLevel[]; // empty = no effort control
  defaultEffort: EffortLevel | null;
}
const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', engine: 'claude', tier: 'opus', description: 'Best for everyday, complex tasks', efforts: ALL_EFFORTS, defaultEffort: 'xhigh' },
  { id: 'claude-opus-5', label: 'Opus 5', engine: 'claude', tier: 'opus', description: 'Best for everyday, complex tasks', efforts: ALL_EFFORTS, defaultEffort: 'high' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', engine: 'claude', tier: 'opus', description: 'Most capable, for the hardest and longest-running tasks; heaviest on usage limits', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', engine: 'claude', tier: 'sonnet', description: 'Efficient for routine tasks', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', engine: 'claude', tier: 'sonnet', description: 'Efficient for routine tasks', efforts: ALL_EFFORTS, defaultEffort: 'xhigh' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', engine: 'claude', tier: 'haiku', description: 'Fastest for quick answers', efforts: ALL_EFFORTS, defaultEffort: 'high' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', engine: 'claude', tier: 'haiku', description: 'Fastest for quick answers; no effort control', efforts: [], defaultEffort: null },
  // Codex (ChatGPT plan): ids, efforts and defaults from the account's
  // model/list, each verified to run a turn (test/probe-codex-models.ts
  // --live, 2026-10-15) — re-run after a Codex update.
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', engine: 'codex', tier: 'codex', description: 'Codex · latest workhorse model for coding and everyday work', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', engine: 'codex', tier: 'codex', description: 'Codex · frontier intelligence for the most demanding work', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', engine: 'codex', tier: 'codex', description: 'Codex · previous generation workhorse model', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', engine: 'codex', tier: 'codex', description: 'Codex · fast and affordable, for easier tasks', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', engine: 'codex', tier: 'codex', description: 'Codex · older generation workhorse model', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', engine: 'codex', tier: 'codex', description: 'Codex · older balanced model for straightforward work', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', engine: 'codex', tier: 'codex', description: 'Codex · older fast and efficient model', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
];
export const catalogModel = (id: string): CatalogModel | undefined => MODEL_CATALOG.find((model) => model.id === id);

// The owner's model choices — an override LAYER over the built-in defaults
// and each team record's leadModel/workerModel (which are never mutated, so
// clearing the layer restores exactly the defaults). Precedence per field:
// per-team > all-leads/all-workers > team record / built-in default.
export const ModelOverridesSchema = z.object({
  master: ModelChoiceSchema.optional(), // routes every task
  checks: ModelChoiceSchema.optional(), // master's quick checks: handovers + QA verdicts
  lead: ModelChoiceSchema.optional(), // every team lead's review
  worker: ModelChoiceSchema.optional(), // every team's workers
  // Pair mode's second worker (the reviewer). Default: the other engine
  // from the worker's (Claude worker → GPT-6.1-Sol, Codex worker → Opus 5.5).
  reviewer: ModelChoiceSchema.optional(),
  // Owner's opt-in: a plan at >= 90% of its 5-hour or weekly window hands
  // its seats to the other engine's flagship (both nearly out: no change).
  failover: z.boolean().optional(),
  teams: z
    .record(
      z.string(),
      z.object({
        lead: ModelChoiceSchema.optional(),
        worker: ModelChoiceSchema.optional(),
        reviewer: ModelChoiceSchema.optional(),
        pairByDefault: z.boolean().optional(), // this team's tasks run in pair mode unless /solo
      }),
    )
    .default({}),
});
export type ModelOverrides = z.infer<typeof ModelOverridesSchema>;
export const MODEL_DEFAULTS = { master: 'opus', checks: 'haiku' } as const;

// What the engine runs: a concrete id, an optional effort, the family, and
// which engine runs it.
export interface ModelSpec {
  id: string;
  tier: ModelTier;
  engine: EngineId;
  effort?: EffortLevel;
}

// Resolve a role's model. Layers are most-specific first and each field
// resolves on its own; an effort the final model can't take is dropped
// (e.g. any effort on Haiku 4.5), so the model runs at its own default.
export function resolveModel(fallbackTier: ModelTier, ...layers: (ModelChoice | undefined)[]): ModelSpec {
  const id = layers.find((layer) => layer?.model)?.model ?? MODEL_IDS[fallbackTier];
  const entry = catalogModel(id);
  const requested = layers.find((layer) => layer?.effort)?.effort;
  const effort = requested && entry?.efforts.includes(requested) ? requested : undefined;
  return { id, tier: entry?.tier ?? fallbackTier, engine: entry?.engine ?? engineOf(id), ...(effort ? { effort } : {}) };
}

// Ids outside the catalog: Claude's are "claude-…", anything else is Codex.
export function engineOf(id: string): EngineId {
  return catalogModel(id)?.engine ?? (/^claude-/i.test(id) ? 'claude' : 'codex');
}

export const HubInfoSchema = z.object({
  mode: z.enum(['demo', 'claude', 'mock']),
  workspaceDir: z.string(),
  dataDir: z.string(),
  version: z.string(),
  // The only places projects/files may live; registration outside is refused.
  workspaceRoots: z.array(WorkspaceRootSchema),
  // auto: routine work runs, only installs/network/destructive/pushes ask.
  // strict: every gated tool asks.
  permissionMode: z.enum(['auto', 'strict']),
  modelOverrides: ModelOverridesSchema.default({ teams: {} }),
  // The owner's rules for the master (data/master/RULES.md): routing,
  // handovers, splitting, what to do when a task is stuck.
  masterRules: z.string().optional(),
  // MCP servers configured on this PC (names only) — what a team can be
  // granted. Workers get exactly their team's grants, nothing else.
  mcpCatalog: z.array(z.string()).optional(),
  // Folders the owner opened to every worker (Settings > Hub).
  accessGrants: z.array(AccessGrantSchema).optional(),
  // Desktop apps teams can be granted (their ids are in mcpCatalog too).
  apps: z.array(AppSchema).optional(),
  appSuggestions: z.array(AppSuggestionSchema).optional(),
  // Roblox Studio windows open on this PC (studios.list refreshes it), for
  // picking a task's Studio.
  studios: z.array(z.object({ name: z.string(), placeId: z.string().nullable() })).optional(),
  // Away: while on, a card left unanswered for `minutes` gets its safe answer
  // (worker requests are declined; master cards keep the work going) so
  // nothing waits all night.
  away: z.object({ on: z.boolean(), since: z.number().nullable(), minutes: z.number() }).optional(),
});
export type HubInfo = z.infer<typeof HubInfoSchema>;

// Everything the PA desk maintains, mirrored to clients so both apps can
// render a PA tab straight from state (files stay the source of truth).
export const PaStateSchema = z.object({
  enabled: z.boolean(),
  todos: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean(), createdAt: z.number() })),
  reminders: z.array(z.object({ id: z.string(), text: z.string(), atMs: z.number(), firedAt: z.number().optional() })),
  // endMs makes an event span days (a trip); per-day itinerary items are
  // just more events inside that span.
  events: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      startMs: z.number(),
      endMs: z.number().optional(),
      remindedAt: z.number().optional(),
    }),
  ),
  notes: z.string(),
  // Reference lists (games to play, movies, books, …) — plain string arrays,
  // one per data/pa/<name>.json file, keyed by name. Not to-dos: no done
  // state. New files dropped in that directory show up here automatically.
  lists: z.record(z.string(), z.array(z.string())).default({}),
});
export type PaState = z.infer<typeof PaStateSchema>;

export const SnapshotSchema = z.object({
  agents: z.array(AgentSchema),
  teams: z.array(TeamSchema),
  tasks: z.array(TaskSchema),
  permissions: z.array(PermissionRequestSchema),
  projects: z.array(ProjectSchema),
  usage: UsageSchema,
  security: SecurityStateSchema,
  activityLog: z.array(ActivityEntrySchema),
  pa: PaStateSchema.optional(), // absent in snapshots from older hubs
  info: HubInfoSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const HubEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: SnapshotSchema }),
  z.object({ type: z.literal('agent.updated'), agent: AgentSchema }),
  z.object({ type: z.literal('agent.removed'), agentId: z.string() }),
  z.object({ type: z.literal('team.updated'), team: TeamSchema }),
  z.object({ type: z.literal('team.removed'), teamId: z.string() }),
  z.object({ type: z.literal('task.updated'), task: TaskSchema }),
  z.object({ type: z.literal('permission.updated'), request: PermissionRequestSchema }),
  z.object({ type: z.literal('project.updated'), project: ProjectSchema }),
  z.object({ type: z.literal('project.removed'), projectId: z.string() }),
  z.object({ type: z.literal('usage.updated'), usage: UsageSchema }),
  z.object({ type: z.literal('pa.updated'), pa: PaStateSchema }),
  z.object({ type: z.literal('security.updated'), security: SecurityStateSchema }),
  z.object({ type: z.literal('hub.updated'), info: HubInfoSchema }),
  z.object({ type: z.literal('activity'), entry: ActivityEntrySchema }),
  z.object({ type: z.literal('file.shared'), file: SharedFileSchema }),
  // A task console's rows — sent only to clients watching that task
  // (task.watch), never logged. `backfill` = history on open (or an older
  // page); `more` = there are older rows to page in.
  z.object({
    type: z.literal('task.transcript'),
    taskId: z.string(),
    entries: z.array(TranscriptEntrySchema),
    backfill: z.boolean().optional(),
    more: z.boolean().optional(),
  }),
]);
export type HubEvent = z.infer<typeof HubEventSchema>;
