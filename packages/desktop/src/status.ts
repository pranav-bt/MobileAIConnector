import type { Agent, AgentStatus, HubState } from '@agent-hq/shared';

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

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export const TASK_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  intake: { label: 'intake', color: 'var(--faint)' },
  routing: { label: 'routing', color: 'var(--accent)' },
  queued: { label: 'queued', color: 'var(--faint)' },
  in_flight: { label: 'in flight', color: 'var(--green)' },
  awaiting_permission: { label: 'awaiting you', color: 'var(--amber)' },
  review: { label: 'lead review', color: 'var(--violet)' },
  done: { label: 'done', color: 'var(--green)' },
  failed: { label: 'failed', color: 'var(--red)' },
  paused: { label: 'paused', color: 'var(--faint)' },
};

export function usageColor(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--amber)';
  return 'var(--accent-solid)';
}

export function formatResetTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatResetDay(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function isActive(agent: Agent): boolean {
  return agent.status === 'working' || agent.status === 'waiting_permission' || agent.status === 'reporting';
}

// An agent's display name — also for agents already gone from the office
// (retired workers and pair seats keep showing up in logs and consoles):
// "<team>-w3" → "Worker C-3", -r reviewer, -p planner, -d debater.
const SEAT_KINDS: Record<string, string> = { w: 'Worker', r: 'Reviewer', p: 'Planner', d: 'Debater' };
export function agentLabel(state: HubState, agentId: string): string {
  const live = state.agents[agentId]?.name;
  if (live) return live;
  if (agentId === 'master') return 'Master';
  const lead = agentId.match(/^(.+)-lead$/);
  if (lead?.[1]) return `${state.teams[lead[1]]?.name ?? lead[1]} lead`;
  const seat = agentId.match(/^(.+)-([wrpd])(\d+)$/);
  if (seat?.[1] && seat[2] && seat[3]) {
    const initial = (state.teams[seat[1]]?.name ?? seat[1])[0]?.toUpperCase() ?? 'X';
    return `${SEAT_KINDS[seat[2]]} ${initial}-${seat[3]}`;
  }
  return agentId;
}
