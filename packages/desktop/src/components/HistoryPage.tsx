import type { HubState, Task } from '@agent-hq/shared';
import { TASK_STATUS_LABELS, formatTokens } from '../status';

function duration(task: Task): string {
  const ms = task.updatedAt - task.createdAt;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function HistoryPage(props: { state: HubState }): JSX.Element {
  const finished = Object.values(props.state.tasks)
    .filter((task) => ['done', 'failed', 'paused'].includes(task.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', overflowY: 'auto' }}>
      <div className="sect">History · {finished.length}</div>
      {finished.length === 0 && (
        <span className="empty-note">nothing finished yet — completed tasks and their synopses land here (and survive hub restarts)</span>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {finished.map((task) => {
          const status = TASK_STATUS_LABELS[task.status] ?? { label: task.status, color: 'var(--muted)' };
          const teamName = task.teamId ? props.state.teams[task.teamId]?.name ?? task.teamId : 'unrouted';
          const projectName = task.projectId ? props.state.projects[task.projectId]?.name ?? task.projectId : null;
          const team = projectName ? `${teamName} · ${projectName}` : teamName;
          return (
            <div key={task.id} className="tcard">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, flexGrow: 1 }}>{task.title}</span>
                <span className="act" style={{ color: status.color }}>{status.label}</span>
              </div>
              <div className="act" style={{ marginTop: 3 }}>
                {team} · {duration(task)} · {formatTokens(task.tokensUsed)} tokens ·{' '}
                {new Date(task.updatedAt).toLocaleString()}
              </div>
              {task.synopsis && (
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 7 }}>{task.synopsis}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
