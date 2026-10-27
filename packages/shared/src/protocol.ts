import { z } from 'zod';
import {
  ModelOverridesSchema,
  AccessGrantSchema,
  HubEventSchema,
  ModelTierSchema,
  PairModeSchema,
  PermissionDecisionSchema,
  PermissionScopeSchema,
  type HubEvent,
} from './schema.js';

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_HUB_PORT = 4517;

// Hub -> client frames. One envelope per event.
export const EventEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  ts: z.number(),
  event: HubEventSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// Client -> hub commands.
export const ClientCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    client: z.enum(['desktop', 'mobile', 'cli']),
    name: z.string(),
  }),
  z.object({
    type: z.literal('task.submit'),
    text: z.string().min(1),
    projectId: z.string().nullable().optional(),
    // Pair mode for this task (true) or solo (false); omitted = the team's
    // default. "/pair " and "/solo " prefixes on the text do the same.
    pair: z.boolean().optional(),
    // With pair: 'review' (default) or 'split' (plan together, then split
    // the parts between the two engines). "/pair split …" does the same.
    pairMode: PairModeSchema.optional(),
    // A QA pass for this ask even if its team isn't under "## QA" in the
    // master's rules ("/qa …" on the text does the same).
    qa: z.boolean().optional(),
  }),
  // The master drafts routing-table rules ("keywords → Team") from the asks
  // it has routed; you get a card to add them (a match then routes with no
  // model call).
  z.object({ type: z.literal('rules.suggest') }),
  z.object({
    type: z.literal('task.stop'),
    taskId: z.string(),
  }),
  // Task console: open (backfill + live rows to this client only; `before` =
  // an older page ending before that time), close, and talk to the task —
  // into the running conversation, or continuing it after it finished.
  z.object({ type: z.literal('task.watch'), taskId: z.string(), before: z.number().optional() }),
  z.object({ type: z.literal('task.unwatch'), taskId: z.string() }),
  z.object({ type: z.literal('task.message'), taskId: z.string(), text: z.string().min(1).max(20000) }),
  z.object({
    type: z.literal('permission.respond'),
    requestId: z.string(),
    decision: PermissionDecisionSchema,
    scope: PermissionScopeSchema,
    // Phone approvals are signed with the device key; the hub verifies
    // the signature before acting. Absent for desktop (local trust).
    signatureB64: z.string().optional(),
    // The picked option on a pick-one card (PermissionRequest.options);
    // signed along with the decision: `${decision}:${requestId}#${choice}`.
    choice: z.number().int().min(0).max(3).optional(),
  }),
  z.object({
    type: z.literal('team.create'),
    name: z.string().min(1),
    charter: z.string(),
    allowedTools: z.array(z.string()),
    blockedTools: z.array(z.string()),
    workerModel: ModelTierSchema.optional(),
    quotaSharePct: z.number().min(0).max(100).optional(),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
  }),
  // Scaling a team's subagents up/down is one command: change the cap.
  z.object({
    type: z.literal('team.update'),
    teamId: z.string(),
    maxConcurrentWorkers: z.number().int().min(1).max(8).optional(),
    workerModel: ModelTierSchema.optional(),
    quotaSharePct: z.number().min(0).max(100).optional(),
    charter: z.string().optional(),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('team.remove'), teamId: z.string() }),
  // The owner's rules files (RULES.md): replace the whole file from an
  // editor, or append one rule (optionally under a section, e.g. "tools" or
  // "stuck"). teamId may be an id, a team name, or "master".
  z.object({ type: z.literal('team.rules.set'), teamId: z.string().min(1), markdown: z.string().max(20000) }),
  z.object({
    type: z.literal('team.rules.add'),
    teamId: z.string().min(1),
    rule: z.string().min(1).max(500),
    section: z.string().min(1).max(40).optional(),
  }),
  // Replace a team's notes (MEMORY.md) from the Teams page editor.
  z.object({ type: z.literal('team.notes.set'), teamId: z.string().min(1), markdown: z.string().max(40000) }),
  // Grant a team MCP connections by name, from the servers configured on
  // this PC (HubInfo.mcpCatalog). Full replace; [] removes them all. Local
  // clients only — a connection is a program the hub will start.
  z.object({ type: z.literal('team.mcp.set'), teamId: z.string().min(1), servers: z.array(z.string().min(1)).max(20) }),
  z.object({
    type: z.literal('project.register'),
    name: z.string().min(1),
    workspaceDir: z.string().min(1),
    description: z.string().optional(),
    quotaTokens: z.number().positive().optional(),
  }),
  z.object({ type: z.literal('project.remove'), projectId: z.string() }),
  z.object({ type: z.literal('permissions.set'), mode: z.enum(['auto', 'strict']) }),
  // Owner's model choices (full replace; { teams: {} } = back to defaults).
  z.object({ type: z.literal('models.set'), overrides: ModelOverridesSchema }),
  // The folders every worker may read / write (local clients only: a device
  // session can't open folders to agents).
  z.object({ type: z.literal('access.set'), grants: z.array(AccessGrantSchema).max(50) }),
  // Desktop apps teams can use (Settings > Apps). Local clients only — an
  // app is a program the hub starts. A team gets one with team.mcp.set (its id).
  z.object({
    type: z.literal('app.add'),
    name: z.string().min(1).max(60),
    exePath: z.string().min(1).max(500),
    args: z.array(z.string().max(500)).max(20).optional(),
    visible: z.boolean().optional(),
    idleMinutes: z.number().int().min(1).max(240).optional(),
    notes: z.string().max(1000).optional(),
  }),
  z.object({
    type: z.literal('app.update'),
    appId: z.string().min(1),
    name: z.string().min(1).max(60).optional(),
    exePath: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(500)).max(20).optional(),
    visible: z.boolean().optional(),
    idleMinutes: z.number().int().min(1).max(240).optional(),
    notes: z.string().max(1000).optional(),
  }),
  z.object({ type: z.literal('app.remove'), appId: z.string().min(1) }),
  // Move a file across the link. From the desktop (default) it broadcasts
  // out to the phone; from: 'phone' routes it INTO the hub's inbox on disk,
  // where workers can pick it up.
  z.object({
    type: z.literal('file.send'),
    name: z.string().min(1),
    mimeType: z.string(),
    bytesB64: z.string().min(1),
    from: z.string().max(40).optional(),
  }),
  // Phone asks the hub for a screenshot of the PC screen.
  z.object({ type: z.literal('screen.capture') }),
  // Message a freelancer: the hub resumes that terminal session's
  // conversation headlessly and returns the reply.
  z.object({ type: z.literal('freelancer.send'), agentId: z.string().min(1), text: z.string().min(1) }),
  // PA desk: one switch gates all assistant machinery (reminders, alerts)…
  z.object({ type: z.literal('pa.set'), enabled: z.boolean() }),
  // …and deterministic capture into its stores (atMs for reminder/event).
  z.object({
    type: z.literal('pa.add'),
    kind: z.enum(['todo', 'reminder', 'event', 'note']),
    text: z.string().min(1),
    atMs: z.number().optional(),
    endMs: z.number().optional(), // events only: multi-day span (trips)
  }),
  // PA tab interactions: tick a todo, remove an item.
  z.object({ type: z.literal('pa.toggle'), id: z.string().min(1) }),
  z.object({ type: z.literal('pa.remove'), kind: z.enum(['todo', 'reminder', 'event']), id: z.string().min(1) }),
  // Reference lists: append (creates the list/file if new) or remove by index.
  z.object({ type: z.literal('pa.list.add'), list: z.string().min(1).max(40), text: z.string().min(1) }),
  z.object({ type: z.literal('pa.list.remove'), list: z.string().min(1).max(40), index: z.number().int().nonnegative() }),
  // Global task controls: pause (nothing new starts; running work finishes),
  // resume (queues drain), killall (stop everything now).
  z.object({ type: z.literal('tasks.control'), action: z.enum(['pause', 'resume', 'killall']) }),
  // Security commands — the hub only honors these from trusted local
  // clients, never from a device session.
  z.object({ type: z.literal('pairing.start') }),
  z.object({ type: z.literal('pairing.cancel') }),
  z.object({ type: z.literal('device.revoke') }),
  z.object({ type: z.literal('connection.kill') }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export function encodeEvent(event: HubEvent): string {
  const envelope: EventEnvelope = { v: PROTOCOL_VERSION, ts: Date.now(), event };
  return JSON.stringify(envelope);
}

export function decodeEvent(raw: string): HubEvent | null {
  try {
    const parsed = EventEnvelopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.event : null;
  } catch {
    return null;
  }
}

export function encodeCommand(command: ClientCommand): string {
  return JSON.stringify(command);
}

export function decodeCommand(raw: string): ClientCommand | null {
  try {
    const parsed = ClientCommandSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
