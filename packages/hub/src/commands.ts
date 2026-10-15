import type { ClientCommand, ModelOverrides, ModelTier } from '@agent-hq/shared';

// The server parses wire frames into ClientCommands and hands them here.
// The demo driver and the orchestrator each provide an implementation.
// Security commands (pairing.*, device.revoke, connection.kill) never reach
// these handlers — the server routes them to the SecurityController.
export interface CommandHandlers {
  submitTask(text: string, projectId: string | null): void;
  stopTask(taskId: string): void;
  // Task console: talk to a task (the demo hub has no consoles).
  messageTask?(taskId: string, text: string): void;
  respondPermission(requestId: string, decision: 'approve' | 'deny', scope: 'once' | 'task', choice?: number): void;
  createTeam(input: {
    name: string;
    charter: string;
    allowedTools: string[];
    blockedTools: string[];
    workerModel?: ModelTier;
    quotaSharePct?: number;
    mcpServers?: Record<string, unknown>;
  }): void;
  updateTeam(input: {
    teamId: string;
    maxConcurrentWorkers?: number;
    workerModel?: ModelTier;
    quotaSharePct?: number;
    charter?: string;
    mcpServers?: Record<string, unknown>;
  }): void;
  removeTeam(teamId: string): void;
  // Per-team RULES.md (the demo hub has none, so these are optional).
  setTeamRules?(teamRef: string, markdown: string): void;
  addTeamRule?(teamRef: string, rule: string, section?: string): void;
  setTeamMcp?(teamRef: string, servers: string[]): void;
  registerProject(input: { name: string; workspaceDir: string; description?: string; quotaTokens?: number }): void;
  removeProject(projectId: string): void;
  setPermissionMode(mode: 'auto' | 'strict'): void;
  sendFile(name: string, mimeType: string, bytesB64: string, from?: string): void;
  captureScreen(): void;
  freelancerSend(agentId: string, text: string): void;
  paSet(enabled: boolean): void;
  paAdd(kind: 'todo' | 'reminder' | 'event' | 'note', text: string, atMs?: number, endMs?: number): void;
  paToggle(id: string): void;
  paRemove(kind: 'todo' | 'reminder' | 'event', id: string): void;
  paListAdd(list: string, text: string): void;
  paListRemove(list: string, index: number): void;
  tasksControl(action: 'pause' | 'resume' | 'killall'): void;
  setModels(overrides: ModelOverrides): void;
}

export function dispatchCommand(handlers: CommandHandlers, command: ClientCommand): void {
  switch (command.type) {
    case 'hello':
      return; // connection bookkeeping happens in the server
    case 'task.submit':
      return handlers.submitTask(command.text, command.projectId ?? null);
    case 'task.stop':
      return handlers.stopTask(command.taskId);
    case 'task.message':
      return handlers.messageTask?.(command.taskId, command.text);
    case 'task.watch':
    case 'task.unwatch':
      return; // per-connection: handled by the server
    case 'permission.respond':
      return handlers.respondPermission(command.requestId, command.decision, command.scope, command.choice);
    case 'team.create':
      return handlers.createTeam(command);
    case 'team.update':
      return handlers.updateTeam(command);
    case 'team.remove':
      return handlers.removeTeam(command.teamId);
    case 'team.rules.set':
      return handlers.setTeamRules?.(command.teamId, command.markdown);
    case 'team.rules.add':
      return handlers.addTeamRule?.(command.teamId, command.rule, command.section);
    case 'team.mcp.set':
      return handlers.setTeamMcp?.(command.teamId, command.servers);
    case 'project.register':
      return handlers.registerProject(command);
    case 'project.remove':
      return handlers.removeProject(command.projectId);
    case 'permissions.set':
      return handlers.setPermissionMode(command.mode);
    case 'file.send':
      return handlers.sendFile(command.name, command.mimeType, command.bytesB64, command.from);
    case 'screen.capture':
      return handlers.captureScreen();
    case 'freelancer.send':
      return handlers.freelancerSend(command.agentId, command.text);
    case 'pa.set':
      return handlers.paSet(command.enabled);
    case 'pa.add':
      return handlers.paAdd(command.kind, command.text, command.atMs, command.endMs);
    case 'pa.toggle':
      return handlers.paToggle(command.id);
    case 'pa.remove':
      return handlers.paRemove(command.kind, command.id);
    case 'pa.list.add':
      return handlers.paListAdd(command.list, command.text);
    case 'pa.list.remove':
      return handlers.paListRemove(command.list, command.index);
    case 'tasks.control':
      return handlers.tasksControl(command.action);
    case 'models.set':
      return handlers.setModels(command.overrides);
    case 'pairing.start':
    case 'pairing.cancel':
    case 'device.revoke':
    case 'connection.kill':
      return; // handled by the server's security layer
  }
}
