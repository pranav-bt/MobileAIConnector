import type {
  ActivityEntry,
  Agent,
  HubEvent,
  HubInfo,
  PermissionRequest,
  Project,
  SecurityState,
  Snapshot,
  Task,
  Team,
  Usage,
} from './schema.js';
import { ACTIVITY_LOG_CAP } from './schema.js';

// One reducer, used verbatim by the hub (authoritative) and by every client
// (replica). A client that applies the same events holds the same state.

export interface HubState {
  agents: Record<string, Agent>;
  teams: Record<string, Team>;
  tasks: Record<string, Task>;
  permissions: Record<string, PermissionRequest>;
  projects: Record<string, Project>;
  usage: Usage;
  security: SecurityState;
  activityLog: ActivityEntry[];
  info: HubInfo;
}

export function emptySecurity(): SecurityState {
  return { fingerprint: '', pairedDevice: null, pairingQr: null, deviceSessions: 0 };
}

export function emptyInfo(): HubInfo {
  return { mode: 'demo', workspaceDir: '', dataDir: '', version: '', workspaceRoots: [], permissionMode: 'auto' };
}

export function emptyUsage(): Usage {
  return {
    windowPct: 0,
    windowResetsAt: 0,
    weeklyPct: 0,
    weeklyResetsAt: 0,
    tokensToday: 0,
    modelMixPct: { opus: 0, sonnet: 0, haiku: 0 },
    overageEnabled: false,
  };
}

export function emptyState(): HubState {
  return {
    agents: {},
    teams: {},
    tasks: {},
    permissions: {},
    projects: {},
    usage: emptyUsage(),
    security: emptySecurity(),
    activityLog: [],
    info: emptyInfo(),
  };
}

export function toSnapshot(state: HubState): Snapshot {
  return {
    agents: Object.values(state.agents),
    teams: Object.values(state.teams),
    tasks: Object.values(state.tasks),
    permissions: Object.values(state.permissions),
    projects: Object.values(state.projects),
    usage: state.usage,
    security: state.security,
    activityLog: state.activityLog,
    info: state.info,
  };
}

export function fromSnapshot(snapshot: Snapshot): HubState {
  const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
    Object.fromEntries(items.map((item) => [item.id, item]));
  return {
    agents: byId(snapshot.agents),
    teams: byId(snapshot.teams),
    tasks: byId(snapshot.tasks),
    permissions: byId(snapshot.permissions),
    projects: byId(snapshot.projects),
    usage: snapshot.usage,
    security: snapshot.security,
    activityLog: snapshot.activityLog,
    info: snapshot.info,
  };
}

// Pure: returns a new state object so UI frameworks can diff by identity.
export function applyEvent(state: HubState, event: HubEvent): HubState {
  switch (event.type) {
    case 'snapshot':
      return fromSnapshot(event.snapshot);
    case 'agent.updated':
      return { ...state, agents: { ...state.agents, [event.agent.id]: event.agent } };
    case 'agent.removed': {
      const agents = { ...state.agents };
      delete agents[event.agentId];
      return { ...state, agents };
    }
    case 'team.updated':
      return { ...state, teams: { ...state.teams, [event.team.id]: event.team } };
    case 'team.removed': {
      const teams = { ...state.teams };
      delete teams[event.teamId];
      return { ...state, teams };
    }
    case 'task.updated':
      return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } };
    case 'permission.updated':
      return {
        ...state,
        permissions: { ...state.permissions, [event.request.id]: event.request },
      };
    case 'project.updated':
      return { ...state, projects: { ...state.projects, [event.project.id]: event.project } };
    case 'project.removed': {
      const projects = { ...state.projects };
      delete projects[event.projectId];
      return { ...state, projects };
    }
    case 'usage.updated':
      return { ...state, usage: event.usage };
    case 'security.updated':
      return { ...state, security: event.security };
    case 'hub.updated':
      return { ...state, info: event.info };
    case 'activity':
      return { ...state, activityLog: [...state.activityLog, event.entry].slice(-ACTIVITY_LOG_CAP) };
    default:
      return state;
  }
}
