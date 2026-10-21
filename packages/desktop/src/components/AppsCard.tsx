import { useEffect, useState } from 'react';
import type { App, ClientCommand, HubState } from '@agent-hq/shared';

type Send = (command: ClientCommand) => void;

const input: React.CSSProperties = {
  background: 'var(--panel-2)',
  border: '1px solid var(--line-chip)',
  borderRadius: 7,
  padding: '7px 10px',
  color: 'var(--text)',
  fontSize: 11.5,
  outline: 'none',
  minWidth: 0,
};

// Desktop programs teams can use (this PC only — a paired phone can't add
// one: an app is a program the hub starts). Granted per team on the Teams
// page like an MCP connection; Agent HQ's app bridge serves it to workers.
export function AppsCard(props: { state: HubState; send: Send }): JSX.Element {
  const apps = props.state.info.apps ?? [];
  const suggestions = props.state.info.appSuggestions ?? [];
  const [name, setName] = useState('');
  const [exePath, setExePath] = useState('');
  const [since, setSince] = useState(0);
  // The hub explains refusals in the feed; show the latest one about apps.
  const feedback = since
    ? [...props.state.activityLog].reverse().find((entry) => entry.at >= since && entry.message.startsWith('apps: '))?.message.slice(6)
    : undefined;
  const send = (command: ClientCommand) => {
    setSince(Date.now() - 2000);
    props.send(command);
  };
  const add = () => {
    if (!name.trim() || !exePath.trim()) return;
    send({ type: 'app.add', name: name.trim(), exePath: exePath.trim() });
    setName('');
    setExePath('');
  };
  const teamsWith = (id: string) =>
    Object.values(props.state.teams)
      .filter((team) => id in (team.mcpServers ?? {}))
      .map((team) => team.name);

  return (
    <div className="tcard" style={{ padding: 16, gridColumn: '1 / -1' }}>
      <div className="sect">Apps for workers</div>
      <div className="act" style={{ color: 'var(--faint)', marginTop: 2 }}>
        Programs on this PC a team can use — tick one under Connections on the Teams page. It opens when a worker needs it and
        closes when the worker is done, after its idle minutes, or when the worker's session ends (only what it opened — never a
        window you opened). Blender gets a live Python session (modelling, materials, animation), renders the worker can look
        at, and a scene summary; any other program can be opened with a file or run as a command-line tool.
      </div>
      <div className="act" style={{ color: 'var(--amber)', marginTop: 6 }}>
        Apps run without cards: Blender's Python and command-line runs can do anything a program can. Grant them to teams you'd
        trust with a shell.
      </div>

      {apps.length === 0 && <div className="empty-note" style={{ marginTop: 10 }}>no apps yet</div>}
      {apps.map((app) => (
        <AppRow key={app.id} app={app} teams={teamsWith(app.id)} send={send} />
      ))}

      {suggestions.map((found) => (
        <div key={found.exePath} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span className="act" style={{ color: 'var(--text-2)' }}>Found on this PC:</span>
          <span style={{ fontSize: 12 }}>{found.name}</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', flexGrow: 1, overflowWrap: 'anywhere' }}>{found.exePath}</span>
          <button className="btn approve" aria-label={`Add ${found.name}`} style={{ flexGrow: 0, padding: '0 14px' }} onClick={() => send({ type: 'app.add', name: found.name, exePath: found.exePath })}>
            Add
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input value={name} placeholder="Name, e.g. Krita" aria-label="App name" style={{ ...input, width: 160 }} onChange={(event) => setName(event.target.value)} />
        <input
          value={exePath}
          placeholder="Program, e.g. C:\Program Files\Krita (x64)\bin\krita.exe"
          aria-label="App program path"
          style={{ ...input, flexGrow: 1, fontFamily: 'var(--font-mono)' }}
          onChange={(event) => setExePath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
        <button className="btn approve" aria-label="Add app" style={{ flexGrow: 0, padding: '0 14px' }} disabled={!name.trim() || !exePath.trim()} onClick={add}>
          Add
        </button>
      </div>
      {feedback && (
        <div className="act" style={{ marginTop: 6, color: feedback.startsWith("couldn't") ? 'var(--amber)' : 'var(--text-2)' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}

function AppRow(props: { app: App; teams: string[]; send: Send }): JSX.Element {
  const { app, send } = props;
  const [notes, setNotes] = useState(app.notes);
  const [idle, setIdle] = useState(String(app.idleMinutes));
  const [args, setArgs] = useState(app.args.join(' '));
  useEffect(() => setNotes(app.notes), [app.notes]);
  useEffect(() => setIdle(String(app.idleMinutes)), [app.idleMinutes]);
  useEffect(() => setArgs(app.args.join(' ')), [app.args]);
  const update = (patch: Omit<Extract<ClientCommand, { type: 'app.update' }>, 'type' | 'appId'>) => send({ type: 'app.update', appId: app.id, ...patch });
  const saveIdle = () => {
    const minutes = Math.round(Number(idle));
    if (minutes >= 1 && minutes <= 240 && minutes !== app.idleMinutes) update({ idleMinutes: minutes });
    else setIdle(String(app.idleMinutes));
  };
  const saveArgs = () => {
    const next = args.match(/"[^"]*"|\S+/g)?.map((part) => part.replace(/^"(.*)"$/, '$1')) ?? [];
    if (next.join('\u0000') !== app.args.join('\u0000')) update({ args: next });
  };
  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 13, color: 'var(--text)' }}>{app.name}</span>
        <span className="act" style={{ color: 'var(--accent)' }}>{app.kind === 'blender' ? 'Blender · Python, render, scene' : 'program · open, run'}</span>
        <span className="act">connection "{app.id}"</span>
        <span className="act" style={{ flexGrow: 1, textAlign: 'right', color: props.teams.length ? 'var(--text-2)' : 'var(--faint)' }}>
          {props.teams.length ? `used by ${props.teams.join(', ')}` : 'no team yet — grant it on the Teams page'}
        </span>
        <button className="console-btn" aria-label={`Remove ${app.name}`} title="Remove — teams lose it too" onClick={() => send({ type: 'app.remove', appId: app.id })}>
          Remove
        </button>
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginTop: 4, overflowWrap: 'anywhere' }}>{app.exePath}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={app.visible} aria-label={`Show ${app.name}'s window`} onChange={() => update({ visible: !app.visible })} />
          show its window{app.kind === 'blender' ? ' (off = runs in the background)' : ''}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          closes after
          <input
            value={idle}
            inputMode="numeric"
            aria-label={`${app.name} idle minutes`}
            style={{ ...input, width: 48, padding: '4px 6px', textAlign: 'right' }}
            onChange={(event) => setIdle(event.target.value)}
            onBlur={saveIdle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveIdle();
            }}
          />
          idle minutes
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flexGrow: 1, minWidth: 220 }}>
          arguments
          <input
            value={args}
            placeholder="always passed first (optional)"
            aria-label={`${app.name} arguments`}
            style={{ ...input, flexGrow: 1, padding: '4px 8px', fontFamily: 'var(--font-mono)' }}
            onChange={(event) => setArgs(event.target.value)}
            onBlur={saveArgs}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveArgs();
            }}
          />
        </label>
      </div>
      <input
        value={notes}
        placeholder="Notes for workers, e.g. units are metres; export glTF to assets/models"
        aria-label={`${app.name} notes`}
        style={{ ...input, width: '100%', marginTop: 8, boxSizing: 'border-box' }}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={() => notes.trim() !== app.notes && update({ notes })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && notes.trim() !== app.notes) update({ notes });
        }}
      />
    </div>
  );
}
