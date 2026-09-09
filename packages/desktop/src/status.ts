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
  const compact = agent.name.replace(/[^A-Za-z0-9]/g, '');
  const letters = agent.name
    .split(/[\s-]+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  return (letters.length >= 2 ? letters.slice(0, 2) : compact.slice(0, 2).toUpperCase()) || '?';
}

export function isActive(agent: Agent): boolean {
  return agent.status === 'working' || agent.status === 'waiting_permission' || agent.status === 'reporting';
}
