import { useState } from 'react';
import { foldAsks, isInternalTask, type AskView, type ClientCommand, type HubState, type Task } from '@agent-hq/shared';
import { TASK_STATUS_LABELS, agentLabel, formatTokens } from '../status';
import { StepLine } from './StepLine';

const CURRENT_STATUSES = ['routing', 'intake', 'queued', 'in_flight', 'awaiting_permission', 'review'];
const STOPPABLE = ['routing', 'queued', 'in_flight', 'awaiting_permission', 'review'];

function TaskRow(props: {
  state: HubState;
  task: Task | AskView;
  expanded: boolean;
  onToggle: () => void;
  send: (command: ClientCommand) => void;
  onOpenConsole: (taskId: string) => void;
}): JSX.Element {
  const { state, task } = props;
  const status = TASK_STATUS_LABELS[task.status] ?? { label: task.status, color: 'var(--muted)' };
  const team = task.teamId ? state.teams[task.teamId]?.name ?? task.teamId : 'unrouted';
  const project = task.projectId ? state.projects[task.projectId]?.name ?? task.projectId : null;
  // The ask's activity includes its steps' (QA, handovers…).
  const stepIds = new Set(('steps' in task ? task.steps : []).map((step) => step.id));
  const activity = state.activityLog.filter((entry) => entry.taskId === task.id || (entry.taskId !== null && stepIds.has(entry.taskId))).slice(-12);

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
      <StepLine state={state} task={task} />
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
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 8, whiteSpace: 'pre-line' }}>
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
              <span style={{ color: 'var(--faint)', flexShrink: 0 }}>{agentLabel(state, entry.agentId)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.message}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button className="console-btn" onClick={() => props.onOpenConsole(task.id)}>
              Open console
            </button>
          {STOPPABLE.includes(task.status) && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
        </div>
      )}
    </div>
  );
}

export function TasksPage(props: {
  state: HubState;
  send: (command: ClientCommand) => void;
  onOpenConsole: (taskId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  // One row per ask: its steps (QA, handovers, parts…) fold into it.
  const tasks = foldAsks(Object.values(props.state.tasks)).sort((a, b) => b.updatedAt - a.updatedAt);
  const current = tasks.filter((task) => CURRENT_STATUSES.includes(task.status));
  const recent = tasks.filter((task) => !CURRENT_STATUSES.includes(task.status) && !isInternalTask(task)).slice(0, 5);

  const controlBtn: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid var(--line-chip)',
    borderRadius: 8,
    color: 'var(--muted)',
    cursor: 'pointer',
    fontSize: 11,
    padding: '5px 10px',
  };

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div className="sect" style={{ flexGrow: 1 }}>Current · {current.length}</div>
        <button
          style={controlBtn}
          title="Running work finishes; nothing new starts until resume"
          onClick={() => props.send({ type: 'tasks.control', action: 'pause' })}
        >
          ⏸ Pause all
        </button>
        <button
          style={{ ...controlBtn, color: 'var(--accent)' }}
          title="Drain the queues and start working again"
          onClick={() => props.send({ type: 'tasks.control', action: 'resume' })}
        >
          ▶ Resume
        </button>
        <button
          style={{ ...controlBtn, color: 'var(--red)', borderColor: 'rgba(232,90,90,0.45)' }}
          title="Stop every running task and clear all queues"
          onClick={() => props.send({ type: 'tasks.control', action: 'killall' })}
        >
          ■ Kill all
        </button>
      </div>
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
            onOpenConsole={props.onOpenConsole}
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
            onOpenConsole={props.onOpenConsole}
          />
        ))}
      </div>
    </div>
  );
}
