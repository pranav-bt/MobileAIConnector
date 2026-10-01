import { useState } from 'react';
import { isInternalTask, type ClientCommand, type HubState, type PermissionRequest, type Task } from '@agent-hq/shared';
import { formatResetDay, formatResetTime, formatTokens, usageColor } from '../status';

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
        <div className="act" style={{ marginTop: 6, color: 'var(--text-2)', whiteSpace: 'pre-line', lineHeight: 1.55 }}>{task.synopsis}</div>
      )}
    </div>
  );
}

// Plain words first: what the agent wants to do and why it needs a yes.
// The risk tags come from rules (never the model); the raw command is one
// click away for when you want to check the exact action.
function ApprovalCard(props: { state: HubState; request: PermissionRequest; send: (command: ClientCommand) => void }): JSX.Element {
  const { state, request, send } = props;
  const [showCommand, setShowCommand] = useState(false);
  const respond = (decision: 'approve' | 'deny') =>
    send({ type: 'permission.respond', requestId: request.id, decision, scope: 'once' });
  return (
    <div className="tcard awaiting">
      <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>{request.summary ?? request.command}</div>
      {request.flags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
          {request.flags.map((flag) => (
            <span
              key={flag}
              className="act"
              style={{ color: 'var(--amber)', border: '1px solid rgba(232,180,74,0.45)', borderRadius: 5, padding: '1px 6px' }}
            >
              {flag}
            </span>
          ))}
        </div>
      )}
      <div className="act" style={{ marginTop: 6 }}>
        {teamName(state, request.teamId)} · {state.agents[request.agentId]?.name ?? request.agentId}
        {' · '}
        <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setShowCommand(!showCommand)}>
          {showCommand ? 'hide command' : 'show command'}
        </span>
      </div>
      {showCommand && (
        <div style={{ marginTop: 6 }}>
          <div
            className="mono"
            style={{ fontSize: 11.5, color: '#F0D9A5', background: 'var(--panel-2)', borderRadius: 6, padding: '6px 8px', overflowWrap: 'anywhere' }}
          >
            {request.command}
          </div>
          {request.reason && (
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.45, marginTop: 5 }}>{request.reason}</div>
          )}
        </div>
      )}
      <div className="btn-row">
        <button className="btn approve" onClick={() => respond('approve')}>
          {request.choices?.[0] ?? 'Approve'}
        </button>
        <button className="btn deny" onClick={() => respond('deny')}>
          {request.choices?.[1] ?? 'Deny'}
        </button>
      </div>
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
  // Internal split pieces show while running; finished, the parent's report covers them.
  const done = tasks.filter((task) => task.status === 'done' && !isInternalTask(task)).slice(0, 3);
  const failed = tasks.filter((task) => task.status === 'failed' && !isInternalTask(task)).slice(0, 2);

  const usage = state.usage;
  const limitsKnown = usage.windowResetsAt > 0 || usage.weeklyResetsAt > 0;

  return (
    <aside className="today">
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.4 }}>Today</div>

      <div>
        <div className="sect" style={{ color: pending.length > 0 ? 'var(--amber)' : undefined }}>
          Awaiting you · {pending.length}
        </div>
        {pending.length === 0 && <span className="empty-note">nothing needs you right now</span>}
        {pending.map((request) => (
          <ApprovalCard key={request.id} state={state} request={request} send={send} />
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
        <div className="sect" style={{ marginBottom: 6 }}>Usage — whole account</div>
        {limitsKnown ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12 }}>session (5h)</span>
              <span className="act">
                {Math.round(usage.windowPct)}%{usage.windowResetsAt > 0 && ` · resets ${formatResetTime(usage.windowResetsAt)}`}
              </span>
            </div>
            <div className="track" style={{ marginTop: 4 }}>
              <div className="fill" style={{ width: `${usage.windowPct}%`, background: usageColor(usage.windowPct) }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8 }}>
              <span style={{ fontSize: 12 }}>weekly</span>
              <span className="act">
                {Math.round(usage.weeklyPct)}%{usage.weeklyResetsAt > 0 && ` · resets ${formatResetDay(usage.weeklyResetsAt)}`}
              </span>
            </div>
            <div className="track" style={{ marginTop: 4 }}>
              <div className="fill" style={{ width: `${usage.weeklyPct}%`, background: usageColor(usage.weeklyPct) }} />
            </div>
            <div className="act" style={{ marginTop: 7, color: 'var(--faint)' }}>
              {formatTokens(usage.tokensToday)} tokens of that by HQ agents
            </div>
          </>
        ) : (
          <div className="act">
            limit data unavailable · {formatTokens(usage.tokensToday)} tokens by HQ agents
          </div>
        )}
      </div>
    </aside>
  );
}
