import { useState } from 'react';
import type { HubState } from '@agent-hq/shared';
import { DEFAULT_HUB_PORT } from '@agent-hq/shared';
import { HUB_URL_STORAGE_KEY, currentHubUrl } from '../hub';

export function SettingsPage(props: { state: HubState }): JSX.Element {
  const { info } = props.state;
  const [hubUrl, setHubUrl] = useState(currentHubUrl());

  const applyHubUrl = (): void => {
    try {
      localStorage.setItem(HUB_URL_STORAGE_KEY, hubUrl.trim());
    } catch {
      /* private mode etc. — reload still applies the default */
    }
    location.reload();
  };

  const row = (label: string, value: string): JSX.Element => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      <span className="mono" style={{ fontSize: 11.5, textAlign: 'right', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignContent: 'start', overflowY: 'auto' }}>
      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Hub</div>
        {row('Mode', info.mode === 'claude' ? 'claude — real agents' : info.mode === 'demo' ? 'demo — scripted, no usage' : 'mock — fake engine')}
        {row('Workspace (where tasks run)', info.workspaceDir || '—')}
        {row('Data directory', info.dataDir || '—')}
        {row('Version', info.version || '—')}
        {row(
          'Permissions',
          info.permissionMode === 'auto'
            ? 'auto — routine work runs; installs / network / pushes / destructive ask'
            : 'strict — every gated tool asks',
        )}
        {info.workspaceRoots.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="sect">Workspace roots (the only places projects live)</div>
            {info.workspaceRoots.map((root) => (
              <div key={root.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
                <span className="mono" style={{ fontSize: 11.5 }}>{root.path}</span>
                <span className="act">{root.label} · key: {root.key}</span>
              </div>
            ))}
          </div>
        )}
        {info.mode === 'demo' && (
          <div className="act" style={{ marginTop: 10, color: 'var(--amber)' }}>
            demo mode is scripted theater — restart the hub with `npm run hub:engine` for real agents
          </div>
        )}
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">This client</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>Hub address</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input
            value={hubUrl}
            onChange={(event) => setHubUrl(event.target.value)}
            style={{
              flexGrow: 1,
              background: 'var(--panel-2)',
              border: '1px solid var(--line-chip)',
              borderRadius: 7,
              padding: '8px 10px',
              color: 'var(--text)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              outline: 'none',
            }}
          />
          <button className="btn approve" style={{ flexGrow: 0, padding: '0 16px' }} onClick={applyHubUrl}>
            Apply
          </button>
        </div>
        <div className="act" style={{ marginTop: 8, color: 'var(--faint)' }}>
          default ws://127.0.0.1:{DEFAULT_HUB_PORT} — change only if the hub runs elsewhere; applying reloads the app
        </div>
      </div>
    </div>
  );
}
