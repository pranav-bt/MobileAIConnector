import { z } from 'zod';
import {
  HubEventSchema,
  ModelTierSchema,
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
  }),
  z.object({
    type: z.literal('task.stop'),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal('permission.respond'),
    requestId: z.string(),
    decision: PermissionDecisionSchema,
    scope: PermissionScopeSchema,
    // Phone approvals are signed with the device key; the hub verifies
    // the signature before acting. Absent for desktop (local trust).
    signatureB64: z.string().optional(),
  }),
  z.object({
    type: z.literal('team.create'),
    name: z.string().min(1),
    charter: z.string(),
    allowedTools: z.array(z.string()),
    blockedTools: z.array(z.string()),
    workerModel: ModelTierSchema.optional(),
    quotaSharePct: z.number().min(0).max(100).optional(),
  }),
  // Scaling a team's subagents up/down is one command: change the cap.
  z.object({
    type: z.literal('team.update'),
    teamId: z.string(),
    maxConcurrentWorkers: z.number().int().min(1).max(8).optional(),
    workerModel: ModelTierSchema.optional(),
    quotaSharePct: z.number().min(0).max(100).optional(),
    charter: z.string().optional(),
  }),
  z.object({ type: z.literal('team.remove'), teamId: z.string() }),
  z.object({
    type: z.literal('project.register'),
    name: z.string().min(1),
    workspaceDir: z.string().min(1),
    description: z.string().optional(),
    quotaTokens: z.number().positive().optional(),
  }),
  z.object({ type: z.literal('project.remove'), projectId: z.string() }),
  z.object({ type: z.literal('permissions.set'), mode: z.enum(['auto', 'strict']) }),
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
