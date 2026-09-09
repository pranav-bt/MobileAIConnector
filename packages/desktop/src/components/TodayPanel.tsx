import type { ClientCommand, HubState, Task } from '@agent-hq/shared';

function teamName(state: HubState, teamId: string | null): string {
  return (teamId && state.teams[teamId]?.name) || 'Unassigned';
}

function TaskCard(props: { state: HubState; task: Task; showProgress?: boolean }): JSX.Element {
  const { task } = props;
  return (
    <div className="tcard" style={task.status === 'queued' || task.status === 'routing' ? { opacity: 0.8 } : undefined}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{task.title}</div>
      <div className="act" style={{ marginTop: 3 }}>
        {teamName(props.state, task.teamId)} · {task.agentIds.length > 0 ? `${task.agentIds.length} agent${task.agentIds.length > 1 ? 's' : ''}` : task.status}
      </div>
      {props.showProgress && (
        <div className="track">
          <div className="fill" style={{ width: `${task.progressPct}%` }} />
        </div>
      )}
      {task.status === 'done' && task.synopsis && (
        <div className="act" style={{ marginTop: 6, color: 'var(--text-2)' }}>{task.synopsis}</div>
      )}
    </div>
  );
}

export function TodayPanel(props: {
  state: HubState;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const { state, send } = props;
  const tasks = Object.values(state.tasks).sort((a, b) => b.updatedAt - a.updatedAt);
  const pending = Object.values(state.permissions).filter((request) => request.status === 'pending');
  const inFlight = tasks.filter((task) => ['in_flight', 'awaiting_permission', 'review'].includes(task.status));
  const queued = tasks.filter((task) => ['queued', 'routing', 'intake'].includes(task.status));
  const done = tasks.filter((task) => task.status === 'done').slice(0, 3);
  const failed = tasks.filter((task) => task.status === 'failed').slice(0, 2);

  const usage = state.usage;
  const resetsDay = usage.weeklyResetsAt
    ? new Date(usage.weeklyResetsAt).toLocaleDateString(undefined, { weekday: 'short' })
    : '—';

  return (
    <aside className="today">
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.4 }}>Today</div>

      <div>
        <div className="sect" style={{ color: pending.length > 0 ? 'var(--amber)' : undefined }}>
          Awaiting you · {pending.length}
        </div>
        {pending.length === 0 && <span className="empty-note">nothing needs you right now</span>}
        {pending.map((request) => (
          <div key={request.id} className="tcard awaiting">
            <div className="mono" style={{ fontSize: 12, color: '#F0D9A5' }}>{request.command}</div>
            <div className="act" style={{ marginTop: 4 }}>
              {teamName(state, request.teamId)} · {state.agents[request.agentId]?.name ?? request.agentId}
            </div>
            {request.reason && (
              <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.45, marginTop: 6 }}>
                “{request.reason}”
              </div>
            )}
            <div className="btn-row">
              <button
                className="btn approve"
                onClick={() => send({ type: 'permission.respond', requestId: request.id, decision: 'approve', scope: 'once' })}
              >
                Approve
              </button>
              <button
                className="btn deny"
                onClick={() => send({ type: 'permission.respond', requestId: request.id, decision: 'deny', scope: 'once' })}
              >
                Deny
              </button>
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="sect">In flight · {inFlight.length}</div>
        {inFlight.length === 0 && <span className="empty-note">no tasks running</span>}
        {inFlight.map((task) => (
          <TaskCard key={task.id} state={state} task={task} showProgress />
        ))}
      </div>

      {queued.length > 0 && (
        <div>
          <div className="sect">Queued · {queued.length}</div>
          {queued.map((task) => (
            <TaskCard key={task.id} state={state} task={task} />
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div>
          <div className="sect" style={{ color: 'var(--red)' }}>Failed · {failed.length}</div>
          {failed.map((task) => (
            <TaskCard key={task.id} state={state} task={task} />
          ))}
        </div>
      )}

      <div>
        <div className="sect">Done today · {done.length}</div>
        {done.length === 0 && <span className="empty-note">nothing finished yet</span>}
        {done.map((task) => (
          <TaskCard key={task.id} state={state} task={task} />
        ))}
      </div>

      <div style={{ flexGrow: 1 }} />

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div className="sect" style={{ marginBottom: 6 }}>Usage</div>
          <div className="act">
            {Math.round(usage.weeklyPct)}% of weekly · resets {resetsDay}
          </div>
        </div>
        <div className="track" style={{ marginTop: 0 }}>
          <div className="fill" style={{ width: `${usage.weeklyPct}%`, background: usage.weeklyPct >= 75 ? 'var(--amber)' : 'var(--faint)' }} />
        </div>
      </div>
    </aside>
  );
}
