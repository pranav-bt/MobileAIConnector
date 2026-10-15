import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { catalogModel, parseVerdict, type ClientCommand, type HubState, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { useTranscript } from '../hub';
import { TASK_STATUS_LABELS, formatTokens } from '../status';
import { ApprovalCard } from './TodayPanel';

// A task's console: the whole story of one task in order — your ask, where
// the master routed it, the worker's messages and every command/edit (with
// output), cards inline, the lead's review, QA/fix/handover links — plus a
// message box. Sending while it works goes into the running conversation;
// sending after it finished (or was stopped) continues the SAME conversation.

const RUNNING = ['in_flight', 'awaiting_permission', 'review'];
const STOPPABLE = ['routing', 'queued', 'in_flight', 'awaiting_permission', 'review'];

const roleLabel = (state: HubState, entry: TranscriptEntry): string => {
  if (entry.role === 'owner') return 'You';
  if (entry.role === 'lead') return state.agents[entry.agentId ?? '']?.name ?? 'Lead';
  if (entry.role === 'master') return 'Master';
  if (entry.role === 'worker') return state.agents[entry.agentId ?? '']?.name ?? (isReviewer(entry) ? 'Reviewer' : 'Worker');
  return 'Agent HQ';
};

// Pair mode's reviewer seat ("<team>-r<n>").
const isReviewer = (entry: TranscriptEntry): boolean => /-r\d+$/.test(entry.agentId ?? '');

const PAIR_STATE: Record<string, { label: string; color: string }> = {
  working: { label: 'author working', color: 'var(--amber)' },
  reviewing: { label: 'reviewer checking', color: 'var(--amber)' },
  agreed: { label: 'agreed', color: 'var(--green)' },
  disagreed: { label: 'went with it — still disagreed', color: 'var(--amber)' },
};

// "Pair · round 2/3 · Opus 5.5 ⇄ GPT-6.1-Sol · agreed on a1b2c3d4"
function PairLine(props: { task: Task; authorModel: string | null }): JSX.Element | null {
  const pair = props.task.pair;
  if (!pair) return null;
  const state = PAIR_STATE[pair.state ?? 'working'] ?? PAIR_STATE.working!;
  const reviewer = pair.reviewerModel ? catalogModel(pair.reviewerModel)?.label ?? pair.reviewerModel : 'the other engine';
  const author = pair.authorModel ? catalogModel(pair.authorModel)?.label ?? pair.authorModel : props.authorModel ?? 'author';
  const agreedOn = pair.state === 'agreed' ? pair.rounds.at(-1)?.version : undefined;
  return (
    <div className="act" style={{ marginTop: 2 }} title="Pair mode: the author does the work, the reviewer checks the actual result (read-only) until it agrees; the lead chairs">
      <span style={{ color: 'var(--accent)' }}>Pair</span> · round {pair.round}/{pair.maxRounds} · {author} ⇄ {reviewer} ·{' '}
      <span style={{ color: state.color }}>{state.label}</span>
      {agreedOn ? <span className="mono"> on {agreedOn}</span> : null}
    </div>
  );
}

// A reviewer's reply, shown as its verdict (the raw text stays one click away).
function VerdictBody(props: { text: string }): JSX.Element {
  const verdict = parseVerdict(props.text);
  const [raw, setRaw] = useState(false);
  if (!verdict || raw) {
    return <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{props.text}</div>;
  }
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text)' }}>
      <div>
        <span style={{ color: verdict.agree ? 'var(--green)' : 'var(--amber)', fontWeight: 600 }}>{verdict.agree ? '✓ Agrees' : '✗ Not yet'}</span> — {verdict.summary}
      </div>
      {verdict.blocking.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {verdict.blocking.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
      {verdict.minor.length > 0 && (
        <div className="act" style={{ marginTop: 4, color: 'var(--faint)' }}>
          minor: {verdict.minor.join(' · ')}
        </div>
      )}
      <div className="act" style={{ marginTop: 4, color: 'var(--ghost)', cursor: 'pointer' }} onClick={() => setRaw(true)}>
        show reply
      </div>
    </div>
  );
}

const stateMark = (entry: TranscriptEntry) =>
  entry.state === 'running' ? { mark: '●', color: 'var(--amber)' } : entry.state === 'error' ? { mark: '✗', color: 'var(--red)' } : { mark: '✓', color: 'var(--green)' };

function ToolRow(props: { entry: TranscriptEntry }): JSX.Element {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const { mark, color } = stateMark(entry);
  return (
    <div style={{ margin: '3px 0' }}>
      <div
        className="mono"
        onClick={() => entry.detail && setOpen(!open)}
        style={{ display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--text-2)', cursor: entry.detail ? 'pointer' : 'default', alignItems: 'baseline' }}
        title={entry.detail ? (open ? 'hide output' : 'show output') : undefined}
      >
        <span style={{ color, flexShrink: 0 }}>{mark}</span>
        <span style={{ color: 'var(--faint)', flexShrink: 0 }}>{entry.kind === 'diff' ? 'edit' : entry.tool ?? 'tool'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: open ? 'pre-wrap' : 'nowrap', overflowWrap: 'anywhere' }}>{entry.text}</span>
        {entry.detail && <span style={{ color: 'var(--ghost)', flexShrink: 0 }}>{open ? '▾' : '▸'}</span>}
      </div>
      {open && entry.detail && (
        <pre
          className="mono"
          style={{ margin: '4px 0 6px 18px', padding: '8px 10px', background: 'var(--panel-2)', borderRadius: 6, fontSize: 11, lineHeight: 1.45, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {entry.kind === 'diff'
            ? entry.detail.split('\n').map((line, index) => (
                <div key={index} style={{ color: line.startsWith('+') ? 'var(--green)' : line.startsWith('-') ? 'var(--red)' : 'var(--text-2)' }}>
                  {line || ' '}
                </div>
              ))
            : entry.detail}
        </pre>
      )}
    </div>
  );
}

function Row(props: { state: HubState; entry: TranscriptEntry; send: (command: ClientCommand) => void; onOpenTask: (taskId: string) => void }): JSX.Element {
  const { state, entry } = props;
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (entry.kind === 'tool' || entry.kind === 'diff') return <ToolRow entry={entry} />;
  if (entry.kind === 'card') {
    const request = entry.requestId ? state.permissions[entry.requestId] : undefined;
    if (request && request.status === 'pending') {
      return (
        <div style={{ margin: '8px 0' }}>
          <ApprovalCard state={state} request={request} send={props.send} />
        </div>
      );
    }
    const resolved = request?.status ?? (entry.state === 'ok' ? 'approved' : entry.state === 'error' ? 'denied' : 'answered');
    return (
      <div className="act" style={{ margin: '6px 0', color: 'var(--faint)' }}>
        <span style={{ color: resolved === 'approved' ? 'var(--green)' : 'var(--amber)' }}>card {resolved}</span> · {entry.text}
      </div>
    );
  }
  if (entry.kind === 'status') {
    return (
      <div className="act" style={{ margin: '4px 0', color: 'var(--faint)', display: 'flex', gap: 8 }}>
        <span style={{ color: 'var(--ghost)', flexShrink: 0 }}>{time}</span>
        <span style={{ flexShrink: 0 }}>{roleLabel(state, entry)}</span>
        <span style={{ color: 'var(--text-2)', overflowWrap: 'anywhere' }}>{entry.text}</span>
        {entry.linkTaskId && (
          <span style={{ color: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} onClick={() => props.onOpenTask(entry.linkTaskId!)}>
            open ›
          </span>
        )}
      </div>
    );
  }
  if (entry.kind === 'thinking') return <Thinking entry={entry} />;
  // Messages: yours on the right, the team's on the left.
  const mine = entry.role === 'owner';
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', margin: '10px 0' }}>
      <div
        style={{
          maxWidth: '86%',
          background: mine ? 'rgba(79,216,196,0.08)' : 'var(--panel-2)',
          border: `1px solid ${mine ? 'rgba(79,216,196,0.35)' : entry.role === 'lead' ? 'rgba(157,140,255,0.35)' : 'var(--line-soft)'}`,
          borderRadius: 10,
          padding: '8px 11px',
        }}
      >
        <div className="act" style={{ color: entry.role === 'lead' ? 'var(--violet)' : 'var(--faint)', marginBottom: 3 }}>
          {roleLabel(state, entry)}
          {entry.role === 'lead' ? ' · review' : ''} · {time}
        </div>
        {isReviewer(entry) ? (
          <VerdictBody text={entry.text} />
        ) : (
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.text}</div>
        )}
      </div>
    </div>
  );
}

function Thinking(props: { entry: TranscriptEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="act" style={{ margin: '4px 0', color: 'var(--ghost)', cursor: 'pointer', fontStyle: 'italic' }} onClick={() => setOpen(!open)}>
      {open ? <span style={{ whiteSpace: 'pre-wrap' }}>{props.entry.text}</span> : 'thinking… ▸'}
    </div>
  );
}

export function TaskConsole(props: {
  state: HubState;
  taskId: string;
  send: (command: ClientCommand) => void;
  onClose?: () => void;
  onOpenTask: (taskId: string) => void;
  onPopOut?: () => void;
}): JSX.Element {
  const { state, taskId, send } = props;
  const view = useTranscript(taskId);
  const task = state.tasks[taskId];
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow new rows while scrolled to the bottom

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [view.entries.length, view.entries.at(-1)?.text, view.entries.at(-1)?.state]);
  useEffect(() => {
    pinned.current = true;
    setDraft('');
  }, [taskId]);

  if (!task) {
    return (
      <div className="console">
        <div className="console-head">
          <span className="empty-note" style={{ flexGrow: 1 }}>task not found (yet)</span>
          {props.onClose && <button className="console-btn" onClick={props.onClose}>Close</button>}
        </div>
      </div>
    );
  }

  const status = TASK_STATUS_LABELS[task.status] ?? { label: task.status, color: 'var(--muted)' };
  const team = task.teamId ? state.teams[task.teamId]?.name ?? task.teamId : 'unrouted';
  const project = task.projectId ? state.projects[task.projectId]?.name ?? task.projectId : null;
  const workers = Object.values(state.agents).filter((agent) => agent.taskId === taskId && agent.role === 'worker');
  const worker = workers.find((agent) => !/-r\d+$/.test(agent.id)) ?? workers[0];
  const model = worker?.modelId ? catalogModel(worker.modelId)?.label ?? worker.modelId : task.session ? (task.session.engine === 'codex' ? 'Codex' : 'Claude') : null;
  const running = RUNNING.includes(task.status);
  const canSend = !!task.teamId;
  const placeholder = !canSend
    ? 'This task never reached a team — send it as a new task instead'
    : running
      ? 'Message the worker — it reads it at its next step'
      : ['done', 'failed', 'paused'].includes(task.status)
        ? task.pair
          ? 'Ask the chair (the lead) — a question gets an answer; a change goes back to the pair'
          : task.session
          ? 'Continue this task — same conversation, it remembers'
          : 'Continue this task (starts a new run with its history)'
        : 'Add to the brief — the worker gets it when it starts';
  const sendDraft = () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    send({ type: 'task.message', taskId, text });
    setDraft('');
    pinned.current = true;
  };

  return (
    <div className="console">
      <div className="console-head">
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
          <div className="act" style={{ marginTop: 2 }}>
            <span style={{ color: status.color }}>{status.label}</span> · {team}
            {project ? ` · ${project}` : ''}
            {model ? ` · ${model}` : ''} · {formatTokens(task.tokensUsed)} tokens
          </div>
          <PairLine task={task} authorModel={model} />
        </div>
        {STOPPABLE.includes(task.status) && (
          <button className="console-btn danger" onClick={() => send({ type: 'task.stop', taskId })} title="Stop — the conversation is kept; send a message to pick it up again">
            Stop
          </button>
        )}
        {props.onPopOut && (
          <button className="console-btn" onClick={props.onPopOut} title="Open in its own window">
            Pop out
          </button>
        )}
        {props.onClose && (
          <button className="console-btn" onClick={props.onClose}>
            Close
          </button>
        )}
      </div>

      <div
        className="console-body"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {view.more && (
          <div style={{ textAlign: 'center', margin: '4px 0 10px' }}>
            <button className="console-btn" onClick={view.loadEarlier}>
              Load earlier
            </button>
          </div>
        )}
        {!view.loaded && <span className="empty-note">loading…</span>}
        {view.loaded && view.entries.length === 0 && (
          <span className="empty-note">No console history for this task (it ran before consoles existed). You can still continue it below.</span>
        )}
        {view.entries.map((entry) => (
          <Row key={entry.id} state={state} entry={entry} send={send} onOpenTask={props.onOpenTask} />
        ))}
        {running &&
          workers
            .filter((agent) => agent.status === 'working' || workers.length === 1)
            .map((agent) => (
              <div key={agent.id} className="act" style={{ margin: '8px 0', color: 'var(--accent)' }}>
                {agent.name} · {agent.activity}
              </div>
            ))}
      </div>

      <div className="console-compose">
        <textarea
          value={draft}
          disabled={!canSend}
          placeholder={placeholder}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              sendDraft();
            }
          }}
        />
        <button className="console-btn send" disabled={!draft.trim() || !canSend} onClick={sendDraft}>
          Send
        </button>
      </div>
    </div>
  );
}
