import { useRef, useState } from 'react';
import type { ClientCommand, HubState, WorkspaceRoot } from '@agent-hq/shared';
import { isActive } from '../status';

const HELP =
  '/project new <name> [personal|work|ai] · /project add <name> <path> · /project remove <project> · /team add <name>: <charter> · /team workers <team> <n> · /team remove <team>';

function slug(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Composer slash-commands: deterministic, no model call. Everything else in
// the composer is a task for the master.
function parseSlashCommand(
  text: string,
  roots: WorkspaceRoot[],
): { command: ClientCommand; note: string } | { hint: string } | null {
  if (!text.startsWith('/')) return null;
  // "/project new BeatBox personal" creates the folder under the right root.
  const projNew = text.match(/^\/project new (\S+)(?:\s+(\S+))?$/i);
  if (projNew && projNew[1]) {
    const rootKey = (projNew[2] ?? 'ai').toLowerCase();
    const root = roots.find((candidate) => candidate.key === rootKey);
    if (!root) {
      return { hint: `unknown root "${rootKey}" — use one of: ${roots.map((candidate) => candidate.key).join(' | ')}` };
    }
    const name = projNew[1];
    return {
      command: { type: 'project.register', name, workspaceDir: `${root.path}\\${name}` },
      note: `project "${name}" → ${root.path}\\${name}`,
    };
  }
  let match = text.match(/^\/team add ([^:]+):\s*(.+)$/i);
  if (match && match[1] && match[2]) {
    const name = match[1].trim();
    return {
      command: { type: 'team.create', name, charter: match[2].trim(), allowedTools: ['read', 'edit', 'bash'], blockedTools: [] },
      note: `team "${name}" created`,
    };
  }
  match = text.match(/^\/team workers (\S+)\s+(\d+)$/i);
  if (match && match[1] && match[2]) {
    return {
      command: { type: 'team.update', teamId: slug(match[1]), maxConcurrentWorkers: Number(match[2]) },
      note: `${match[1]} capped at ${match[2]} worker(s)`,
    };
  }
  match = text.match(/^\/team remove (\S+)$/i);
  if (match && match[1]) {
    return { command: { type: 'team.remove', teamId: slug(match[1]) }, note: `removing team ${match[1]}` };
  }
  match = text.match(/^\/project add (\S+)\s+(\S+)\s*(.*)$/i);
  if (match && match[1] && match[2]) {
    return {
      command: { type: 'project.register', name: match[1], workspaceDir: match[2], description: match[3] || undefined },
      note: `project "${match[1]}" registered`,
    };
  }
  match = text.match(/^\/project remove (\S+)$/i);
  if (match && match[1]) {
    return { command: { type: 'project.remove', projectId: slug(match[1]) }, note: `removing project ${match[1]}` };
  }
  return { hint: HELP };
}

export function TopBar(props: {
  state: HubState;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCount = Object.values(props.state.agents).filter(isActive).length;
  const usage = props.state.usage;
  const limitsKnown = usage.windowResetsAt > 0 || usage.weeklyResetsAt > 0;

  const showHint = (message: string, ms = 8000) => {
    setHint(message);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), ms);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const slash = parseSlashCommand(trimmed, props.state.info.workspaceRoots);
    if (slash) {
      if ('command' in slash) {
        props.send(slash.command);
        showHint(`✓ ${slash.note}`, 4000);
        setText('');
      } else {
        showHint(slash.hint);
      }
      return;
    }
    props.send({ type: 'task.submit', text: trimmed });
    setText('');
  };

  return (
    <div className="topbar">
      <div className="composer">
        <span style={{ color: 'var(--accent)', fontSize: 14 }}>✦</span>
        <input
          value={text}
          placeholder="Give the master agent a task… (@project pins it · / for commands)"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      </div>
      {hint ? (
        <span className="act" style={{ color: 'var(--amber)', maxWidth: 520, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {hint}
        </span>
      ) : (
        <>
          <span className="pill">
            <span className="dot" style={{ background: 'var(--green)' }} />
            {activeCount} AGENTS ACTIVE
          </span>
          {limitsKnown && (
            <span className="pill">
              5H&nbsp;{Math.round(usage.windowPct)}%&nbsp;&nbsp;·&nbsp;&nbsp;WK&nbsp;{Math.round(usage.weeklyPct)}%
            </span>
          )}
        </>
      )}
    </div>
  );
}
