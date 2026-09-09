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
});
export type Task = z.infer<typeof TaskSchema>;

export const PermissionRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  teamId: z.string().nullable(),
  command: z.string(),
  flags: z.array(z.string()),
  reason: z.string(),
  status: PermissionStatusSchema,
  scope: PermissionScopeSchema,
  requestedAt: z.number(),
  resolvedAt: z.number().nullable(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

// Quotas are token shares of the subscription limits — never dollars.
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
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

export const SnapshotSchema = z.object({
  agents: z.array(AgentSchema),
  teams: z.array(TeamSchema),
  tasks: z.array(TaskSchema),
  permissions: z.array(PermissionRequestSchema),
  projects: z.array(ProjectSchema),
  usage: UsageSchema,
  security: SecurityStateSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const HubEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: SnapshotSchema }),
  z.object({ type: z.literal('agent.updated'), agent: AgentSchema }),
  z.object({ type: z.literal('agent.removed'), agentId: z.string() }),
  z.object({ type: z.literal('team.updated'), team: TeamSchema }),
  z.object({ type: z.literal('task.updated'), task: TaskSchema }),
  z.object({ type: z.literal('permission.updated'), request: PermissionRequestSchema }),
  z.object({ type: z.literal('project.updated'), project: ProjectSchema }),
  z.object({ type: z.literal('usage.updated'), usage: UsageSchema }),
  z.object({ type: z.literal('security.updated'), security: SecurityStateSchema }),
  z.object({ type: z.literal('activity'), entry: ActivityEntrySchema }),
]);
export type HubEvent = z.infer<typeof HubEventSchema>;
