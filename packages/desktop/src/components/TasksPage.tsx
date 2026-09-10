import { useState } from 'react';
import type { ClientCommand, HubState, Task } from '@agent-hq/shared';
import { TASK_STATUS_LABELS, formatTokens } from '../status';

const CURRENT_STATUSES = ['routing', 'intake', 'queued', 'in_flight', 'awaiting_permission', 'review'];
const STOPPABLE = ['routing', 'queued', 'in_flight', 'awaiting_permission', 'review'];

function TaskRow(props: {
  state: HubState;
  task: Task;
  expanded: boolean;
  onToggle: () => void;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const { state, task } = props;
  const status = TASK_STATUS_LABELS[task.status] ?? { label: task.status, color: 'var(--muted)' };
  const team = task.teamId ? state.teams[task.teamId]?.name ?? task.teamId : 'unrouted';
  const project = task.projectId ? state.projects[task.projectId]?.name ?? task.projectId : null;
  const activity = state.activityLog.filter((entry) => entry.taskId === task.id).slice(-12);

  return (
    <div className="tcard" style={{ cursor: 'pointer' }} onClick={props.onToggle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flexGrow: 1 }}>{task.title}</span>
        <span className="act" style={{ color: status.color }}>{status.label}</span>
      </div>
      <div className="act" style={{ marginTop: 3 }}>
        {team}{project ? ` · ${project}` : ''} · {formatTokens(task.tokensUsed)} tokens · started{' '}
        {new Date(task.createdAt).toLocaleTimeString()}
      </div>
      {['in_flight', 'awaiting_permission', 'review'].includes(task.status) && (
        <div className="track">
          <div className="fill" style={{ width: `${task.progressPct}%` }} />
        </div>
      )}

      {props.expanded && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }} onClick={(e) => e.stopPropagation()}>
          {task.detail !== task.title && (
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 8 }}>{task.detail}</div>
          )}
          {task.synopsis && (
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 8 }}>
              <span className="sect" style={{ display: 'block' }}>Synopsis</span>
              {task.synopsis}
            </div>
          )}
          <div className="sect">Activity</div>
          {activity.length === 0 && <span className="empty-note">nothing logged yet</span>}
          {activity.map((entry, index) => (
            <div key={index} className="act" style={{ display: 'flex', gap: 8, lineHeight: 1.6 }}>
              <span style={{ color: 'var(--ghost)', flexShrink: 0 }}>
                {new Date(entry.at).toLocaleTimeString()}
              </span>
              <span style={{ color: 'var(--faint)', flexShrink: 0 }}>{state.agents[entry.agentId]?.name ?? entry.agentId}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.message}</span>
            </div>
          ))}
          {STOPPABLE.includes(task.status) && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <button
                className="btn deny"
                style={{ flexGrow: 0, padding: '7px 16px', borderColor: 'rgba(229,104,92,0.5)', color: 'var(--red)' }}
                onClick={() => props.send({ type: 'task.stop', taskId: task.id })}
              >
                Stop task
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TasksPage(props: {
  state: HubState;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  const tasks = Object.values(props.state.tasks).sort((a, b) => b.updatedAt - a.updatedAt);
  const current = tasks.filter((task) => CURRENT_STATUSES.includes(task.status));
  const recent = tasks.filter((task) => !CURRENT_STATUSES.includes(task.status)).slice(0, 5);

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', overflowY: 'auto' }}>
      <div className="sect">Current · {current.length}</div>
      {current.length === 0 && <span className="empty-note">nothing running — give the master agent a task above</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {current.map((task) => (
          <TaskRow
            key={task.id}
            state={props.state}
            task={task}
            expanded={expanded === task.id}
            onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
            send={props.send}
          />
        ))}
      </div>

      <div className="sect" style={{ marginTop: 20 }}>Recently finished</div>
      {recent.length === 0 && <span className="empty-note">no finished tasks yet — see History once there are</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {recent.map((task) => (
          <TaskRow
            key={task.id}
            state={props.state}
            task={task}
            expanded={expanded === task.id}
            onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
            send={props.send}
          />
        ))}
      </div>
    </div>
  );
}
