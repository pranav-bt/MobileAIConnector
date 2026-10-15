import { useRef, useState } from 'react';
import type { ClientCommand, HubState, WorkspaceRoot } from '@agent-hq/shared';
import { isActive } from '../status';

const HELP =
  '/pair <task> · /solo <task> · /project new <name> [personal|work|ai] · /project add|remove · /team add <name>: <charter> · /team workers <team> <n> · /team remove <team> · /rule <team>[/<section>]: <rule> · /rule master/stuck: <rule> · /permissions auto|strict · /todo <text> · /note <text> · /remind <when> <text> · /event <when> <title> · /pa on|off · /tasks pause|resume|killall';

export const WHEN_HELP = '<when>: "in 20m|2h|3d", "17:30", "tomorrow 09:00", or "2026-09-14 18:00"';

// Deterministic time parsing (zero tokens): returns epoch ms or null.
export function parseWhen(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  const now = new Date();
  let match = text.match(/^in\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/);
  if (match) {
    const n = Number(match[1]);
    const unit = match[2]![0];
    return now.getTime() + n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
  }
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (match) {
    const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
    return at.getTime();
  }
  match = text.match(/^(tomorrow\s+)?(\d{1,2}):(\d{2})$/);
  if (match) {
    const at = new Date(now);
    at.setHours(Number(match[2]), Number(match[3]), 0, 0);
    if (match[1]) at.setDate(at.getDate() + 1);
    else if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1); // past today -> tomorrow
    return at.getTime();
  }
  return null;
}

// "/remind in 20m take the build out" -> {atMs, text: "take the build out"}.
// The <when> part is everything before the first token that stops parsing.
function splitWhen(rest: string): { atMs: number; text: string } | null {
  const words = rest.trim().split(/\s+/);
  for (let take = Math.min(3, words.length - 1); take >= 1; take--) {
    const atMs = parseWhen(words.slice(0, take).join(' '));
    if (atMs !== null) return { atMs, text: words.slice(take).join(' ') };
  }
  return null;
}

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
  // "/pair <task>": both engines — the worker does it, a second model reviews
  // it until they agree. "/solo <task>": one worker even if the team pairs by
  // default. (The hub strips the prefix; it reads the same from any client.)
  const pairMatch = text.match(/^\/(pair|solo)\s+([\s\S]+)$/i);
  if (pairMatch && pairMatch[1] && pairMatch[2]) {
    const pair = pairMatch[1].toLowerCase() === 'pair';
    return { command: { type: 'task.submit', text: pairMatch[2].trim(), pair }, note: pair ? 'sent in pair mode' : 'sent solo' };
  }
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
  // "/rule coding: never force-push" appends to that team's RULES.md (the hub
  // matches the team by id or name; "master" is the master's own file).
  // "/rule art/tools: magick: resize images" or "/rule master/stuck: …"
  // targets a section.
  match = text.match(/^\/rules? ([^:/]+)(?:\/([^:]+))?:\s*(.+)$/i);
  if (match && match[1] && match[3]) {
    const section = match[2]?.trim();
    return {
      command: { type: 'team.rules.add', teamId: match[1].trim(), rule: match[3].trim(), ...(section ? { section } : {}) },
      note: `${section ? `${section} ` : ''}rule added for ${match[1].trim()}`,
    };
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
  // PA desk: deterministic capture + the master switch.
  match = text.match(/^\/tasks (pause|resume|killall)$/i);
  if (match && match[1]) {
    const action = match[1].toLowerCase() as 'pause' | 'resume' | 'killall';
    return { command: { type: 'tasks.control', action }, note: `tasks: ${action}` };
  }
  match = text.match(/^\/pa (on|off)$/i);
  if (match && match[1]) {
    const enabled = match[1].toLowerCase() === 'on';
    return { command: { type: 'pa.set', enabled }, note: `PA desk ${enabled ? 'on' : 'off'}` };
  }
  match = text.match(/^\/todo (.+)$/i);
  if (match && match[1]) {
    return { command: { type: 'pa.add', kind: 'todo', text: match[1].trim() }, note: 'todo added' };
  }
  match = text.match(/^\/note (.+)$/i);
  if (match && match[1]) {
    return { command: { type: 'pa.add', kind: 'note', text: match[1].trim() }, note: 'noted' };
  }
  match = text.match(/^\/(remind|event) (.+)$/i);
  if (match && match[1] && match[2]) {
    const kind = match[1].toLowerCase() === 'remind' ? 'reminder' : 'event';
    const parsed = splitWhen(match[2]);
    if (!parsed || !parsed.text) return { hint: `couldn't read the time — ${WHEN_HELP}` };
    return {
      command: { type: 'pa.add', kind, text: parsed.text, atMs: parsed.atMs },
      note: `${kind} set for ${new Date(parsed.atMs).toLocaleString()}`,
    };
  }

  match = text.match(/^\/permissions (auto|strict)$/i);
  if (match && match[1]) {
    const mode = match[1].toLowerCase() as 'auto' | 'strict';
    return {
      command: { type: 'permissions.set', mode },
      note: mode === 'auto' ? 'permissions: auto — only risky commands ask' : 'permissions: strict — everything asks',
    };
  }
  return { hint: HELP };
}

export function TopBar(props: {
  state: HubState;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  // One-shot: the next task runs in pair mode (a second model reviews it).
  const [pair, setPair] = useState(false);
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
    props.send({ type: 'task.submit', text: trimmed, ...(pair ? { pair: true } : {}) });
    setText('');
    setPair(false);
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
        <button
          type="button"
          className={`pair-toggle${pair ? ' on' : ''}`}
          aria-pressed={pair}
          title="Pair mode for the next task: the worker does it, a second model (the other engine) reviews the actual result until they agree"
          onClick={() => setPair((on) => !on)}
        >
          Pair
        </button>
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
