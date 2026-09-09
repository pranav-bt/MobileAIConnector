import type { Agent, AgentStatus } from '@agent-hq/shared';

export const STATUS_COLORS: Record<AgentStatus, string> = {
  working: '#46C08A',
  waiting_permission: '#E8B44A',
  reporting: '#9D8CFF',
  blocked: '#E5685C',
  idle: '#454F60',
  offline: '#2A3444',
};

export function ringColor(agent: Agent): string {
  if (agent.role === 'master') return '#4FD8C4';
  return STATUS_COLORS[agent.status];
}

export function initialsOf(agent: Agent): string {
  if (agent.role === 'master') return 'M';
  // "Worker C-1" -> "C1"; codes beat initials for scanability.
  const lastToken = agent.name.trim().split(/\s+/).at(-1) ?? '';
  const code = lastToken.match(/^([A-Za-z])-?(\d+)$/);
  if (code) return `${code[1].toUpperCase()}${code[2]}`;
  const letters = agent.name
    .split(/[\s-]+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  return letters.slice(0, 2) || '?';
}

export function isActive(agent: Agent): boolean {
  return agent.status === 'working' || agent.status === 'waiting_permission' || agent.status === 'reporting';
}
