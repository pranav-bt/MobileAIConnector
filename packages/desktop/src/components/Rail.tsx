import type { ClientCommand, HubState } from '@agent-hq/shared';
import type { ConnectionStatus } from '../hub';

export type View = 'office' | 'security';

const NAV_ITEMS: { label: string; view: View | null }[] = [
  { label: 'Office', view: 'office' },
  { label: 'Tasks', view: null },
  { label: 'Resources', view: null },
  { label: 'History', view: null },
  { label: 'Security', view: 'security' },
  { label: 'Settings', view: null },
];

export function Rail(props: {
  state: HubState;
  status: ConnectionStatus;
  view: View;
  onNavigate: (view: View) => void;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const { security } = props.state;
  const hubDot = props.status === 'open' ? 'var(--green)' : props.status === 'connecting' ? 'var(--amber)' : 'var(--red)';
  const deviceLine = security.pairedDevice
    ? `${security.pairedDevice.name} · ${security.deviceSessions > 0 ? 'connected' : 'not connected'}`
    : 'no phone paired';

  return (
    <aside className="rail">
      <div className="rail-logo">
        <div className="rail-mark">HQ</div>
        <div className="rail-name">AGENT&nbsp;HQ</div>
      </div>

      {NAV_ITEMS.map((item) => (
        <button
          key={item.label}
          className={`navi${item.view === props.view ? ' active' : ''}`}
          style={{ textAlign: 'left', opacity: item.view === null ? 0.55 : 1 }}
          onClick={() => item.view && props.onNavigate(item.view)}
          title={item.view === null ? 'coming in a later milestone' : undefined}
        >
          <span>{item.label}</span>
        </button>
      ))}

      <div style={{ flexGrow: 1 }} />

      <div className="rail-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="dot" style={{ background: hubDot, width: 7, height: 7 }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            {props.status === 'open' ? 'hub connected' : props.status === 'connecting' ? 'connecting…' : 'hub offline — retrying'}
          </span>
        </div>
        <div className="act" style={{ marginTop: 4 }}>{deviceLine}</div>
        {security.pairedDevice && security.deviceSessions > 0 && (
          <div className="act" style={{ color: 'var(--faint)' }}>E2E encrypted · keys pinned</div>
        )}
      </div>

      <button
        className="kill-btn"
        onClick={() => props.send({ type: 'connection.kill' })}
        title="Revoke device keys and tear down the mobile session"
      >
        Kill connection
      </button>
    </aside>
  );
}
