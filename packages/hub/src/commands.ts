import type { ClientCommand } from '@agent-hq/shared';

// The server parses wire frames into ClientCommands and hands them here.
// The demo driver and the orchestrator each provide an implementation.
// Security commands (pairing.*, device.revoke, connection.kill) never reach
// these handlers — the server routes them to the SecurityController.
export interface CommandHandlers {
  submitTask(text: string, projectId: string | null): void;
  respondPermission(requestId: string, decision: 'approve' | 'deny', scope: 'once' | 'task'): void;
  createTeam(input: {
    name: string;
    charter: string;
    allowedTools: string[];
    blockedTools: string[];
    workerModel?: 'opus' | 'sonnet' | 'haiku';
    quotaSharePct?: number;
  }): void;
}

export function dispatchCommand(handlers: CommandHandlers, command: ClientCommand): void {
  switch (command.type) {
    case 'hello':
      return; // connection bookkeeping happens in the server
    case 'task.submit':
      return handlers.submitTask(command.text, command.projectId ?? null);
    case 'permission.respond':
      return handlers.respondPermission(command.requestId, command.decision, command.scope);
    case 'team.create':
      return handlers.createTeam(command);
    case 'pairing.start':
    case 'pairing.cancel':
    case 'device.revoke':
    case 'connection.kill':
      return; // handled by the server's security layer
  }
}
