import { useState } from 'react';
import type { AccessGrant, ClientCommand, HubState } from '@agent-hq/shared';

// Folders the owner opens to every worker, in every project (this PC only —
// a paired phone can't change them). Read & write: workers create and change
// files there without a card. Read: named to workers as readable (reading
// never asks anyway, except credential-like files).
export function FolderAccess(props: { state: HubState; send: (command: ClientCommand) => void }): JSX.Element {
  const grants = props.state.info.accessGrants ?? [];
  const [path, setPath] = useState('');
  const [access, setAccess] = useState<AccessGrant['access']>('write');
  const save = (next: AccessGrant[]) => props.send({ type: 'access.set', grants: next });
  const add = () => {
    const trimmed = path.trim().replace(/^"|"$/g, '');
    if (!trimmed) return;
    save([...grants.filter((grant) => grant.path.toLowerCase() !== trimmed.toLowerCase()), { path: trimmed, access }]);
    setPath('');
  };
  const select: React.CSSProperties = {
    background: 'var(--panel-2)',
    border: '1px solid var(--line-chip)',
    borderRadius: 7,
    color: 'var(--text-2)',
    fontSize: 11.5,
    padding: '4px 6px',
    outline: 'none',
  };
  const fixed = (label: string, what: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
      <span className="act" style={{ color: 'var(--text-2)' }}>{label}</span>
      <span className="act">{what} · always</span>
    </div>
  );

  return (
    <div style={{ marginTop: 14 }}>
      <div className="sect">Folder access for workers</div>
      <div className="act" style={{ color: 'var(--faint)', marginTop: 2 }}>
        Workers run in their task's project folder like Claude Code opened there. Writes anywhere else ask first — unless the
        folder is opened here. Agent HQ's own data folder stays locked whatever you add.
      </div>
      {fixed('Its own project folder', 'read & write')}
      {fixed("The project's Claude Code folder (~\\.claude\\projects\\<project> — memory, tool results)", 'read & write')}
      {fixed('The phone inbox / outbox', 'read & write')}
      {fixed('Anywhere under the workspace roots above', 'read')}
      {grants.map((grant) => (
        <div key={grant.path} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span className="mono" style={{ fontSize: 11.5, flexGrow: 1, overflowWrap: 'anywhere' }}>{grant.path}</span>
          <select
            value={grant.access}
            aria-label={`Access for ${grant.path}`}
            style={select}
            onChange={(event) => save(grants.map((entry) => (entry.path === grant.path ? { ...entry, access: event.target.value as AccessGrant['access'] } : entry)))}
          >
            <option value="write">Read &amp; write</option>
            <option value="read">Read only</option>
          </select>
          <button
            className="console-btn"
            title="Remove — workers ask again before writing here"
            aria-label={`Remove ${grant.path}`}
            onClick={() => save(grants.filter((entry) => entry.path !== grant.path))}
          >
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={path}
          placeholder="Add a folder, e.g. D:\Tools\Shared"
          aria-label="Folder to open to workers"
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
          style={{
            flexGrow: 1,
            background: 'var(--panel-2)',
            border: '1px solid var(--line-chip)',
            borderRadius: 7,
            padding: '7px 10px',
            color: 'var(--text)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            outline: 'none',
          }}
        />
        <select value={access} aria-label="Access for the new folder" style={select} onChange={(event) => setAccess(event.target.value as AccessGrant['access'])}>
          <option value="write">Read &amp; write</option>
          <option value="read">Read only</option>
        </select>
        <button className="btn approve" aria-label="Add folder" style={{ flexGrow: 0, padding: '0 14px' }} disabled={!path.trim()} onClick={add}>
          Add
        </button>
      </div>
      <div className="act" style={{ color: 'var(--faint)', marginTop: 6 }}>
        Applies to work that starts from now. A whole drive can't be opened for writing; folders that don't exist are refused (the
        activity feed says why).
      </div>
    </div>
  );
}
