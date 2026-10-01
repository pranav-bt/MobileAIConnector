import { z } from 'zod';

// The provider-agnostic vocabulary of Agent HQ. Everything the hub, the
// desktop app, and the phone exchange is defined here. A Codex adapter (or
// any other engine) plugs in by emitting these same events.

export const ModelTierSchema = z.enum(['opus', 'sonnet', 'haiku']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

// Tier -> concrete model id. Only the engine layer reads this.
export const MODEL_IDS: Record<ModelTier, string> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

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
  createdAt: z.number(),
});
export type Team = z.infer<typeof TeamSchema>;

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
  // The owner's own words, set only on tasks the owner submitted (never on
  // QA/fix/follow-up/split tasks). Routing reads these to follow the
  // conversation thread instead of guessing a project from topic words.
  ownerAsk: z.string().nullable().optional(),
  // Why a paused task stopped. Only 'owner' (stopping that one task) drops an
  // ask from the thread; KILL ALL and a hub restart keep the conversation.
  stoppedBy: z.enum(['owner', 'killall', 'restart']).nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

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
  flags: z.array(z.string()),
  reason: z.string(),
  status: PermissionStatusSchema,
  scope: PermissionScopeSchema,
  requestedAt: z.number(),
  resolvedAt: z.number().nullable(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

// A project = a workspace + a ledger. Workers run inside workspaceDir and
// only see that project's files and history. Quotas are token shares of the
// subscription limits — never dollars.
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  workspaceDir: z.string(),
  quotaTokens: z.number(),
  usedTokens: z.number(),
  alerted75: z.boolean(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const UsageSchema = z.object({
  windowPct: z.number(),
  windowResetsAt: z.number(),
  weeklyPct: z.number(),
  weeklyResetsAt: z.number(),
  tokensToday: z.number(),
  modelMixPct: z.object({
    opus: z.number(),
    sonnet: z.number(),
    haiku: z.number(),
  }),
  overageEnabled: z.boolean(),
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

export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

// The models Settings > Models offers. Every id was verified to run through
// the hub's Agent SDK (packages/hub/test/probe-models.ts --live), and
// defaultEffort is the level Claude Code actually applied when the hub sent
// none (packages/hub/test/probe-effort-defaults.ts, measured 2026-09-28 on
// SDK 0.3.284) — re-run both after an SDK update. 'tier' is the family
// bucket the usage meters and office chips use (Fable counts as top tier).
export interface CatalogModel {
  id: string;
  label: string;
  tier: ModelTier;
  description: string;
  efforts: EffortLevel[]; // empty = no effort control
  defaultEffort: EffortLevel | null;
}
const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', description: 'Best for everyday, complex tasks', efforts: ALL_EFFORTS, defaultEffort: 'high' },
  { id: 'claude-opus-5', label: 'Opus 5', tier: 'opus', description: 'Best for everyday, complex tasks', efforts: ALL_EFFORTS, defaultEffort: 'high' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', tier: 'opus', description: 'Most capable, for the hardest and longest-running tasks; heaviest on usage limits', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'sonnet', description: 'Efficient for routine tasks', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', tier: 'sonnet', description: 'Efficient for routine tasks', efforts: ALL_EFFORTS, defaultEffort: 'xhigh' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', tier: 'haiku', description: 'Fastest for quick answers; no effort control', efforts: [], defaultEffort: null },
];
export const catalogModel = (id: string): CatalogModel | undefined => MODEL_CATALOG.find((model) => model.id === id);

// One role's choice: model and effort are independent, so "all workers:
// effort low" composes with "Coding workers: Opus 5.5". Missing = default.
export const ModelChoiceSchema = z.object({
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

// The owner's model choices — an override LAYER over the built-in defaults
// and each team record's leadModel/workerModel (which are never mutated, so
// clearing the layer restores exactly the defaults). Precedence per field:
// per-team > all-leads/all-workers > team record / built-in default.
export const ModelOverridesSchema = z.object({
  master: ModelChoiceSchema.optional(), // routes every task
  checks: ModelChoiceSchema.optional(), // master's quick checks: handovers + QA verdicts
  lead: ModelChoiceSchema.optional(), // every team lead's review
  worker: ModelChoiceSchema.optional(), // every team's workers
  teams: z
    .record(z.string(), z.object({ lead: ModelChoiceSchema.optional(), worker: ModelChoiceSchema.optional() }))
    .default({}),
});
export type ModelOverrides = z.infer<typeof ModelOverridesSchema>;
export const MODEL_DEFAULTS = { master: 'opus', checks: 'haiku' } as const;

// What the engine runs: a concrete id, an optional effort, and the family.
export interface ModelSpec {
  id: string;
  tier: ModelTier;
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
  return { id, tier: entry?.tier ?? fallbackTier, ...(effort ? { effort } : {}) };
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
]);
export type HubEvent = z.infer<typeof HubEventSchema>;
