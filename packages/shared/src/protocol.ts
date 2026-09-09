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
