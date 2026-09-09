import type { ClientCommand } from '@agent-hq/shared';
import type { ConnectionStatus } from '../hub';

const NAV_ITEMS = ['Office', 'Tasks', 'Resources', 'History', 'Security', 'Settings'] as const;

export function Rail(props: {
  status: ConnectionStatus;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const hubDot = props.status === 'open' ? 'var(--green)' : props.status === 'connecting' ? 'var(--amber)' : 'var(--red)';
  const hubLabel = props.status === 'open' ? 'hub connected' : props.status === 'connecting' ? 'connecting…' : 'hub offline — retrying';

  return (
    <aside className="rail">
      <div className="rail-logo">
        <div className="rail-mark">HQ</div>
        <div className="rail-name">AGENT&nbsp;HQ</div>
      </div>

      {NAV_ITEMS.map((item) => (
        <div key={item} className={`navi${item === 'Office' ? ' active' : ''}`}>
          <span>{item}</span>
        </div>
      ))}

      <div style={{ flexGrow: 1 }} />

      <div className="rail-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="dot" style={{ background: hubDot, width: 7, height: 7 }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{hubLabel}</span>
        </div>
        <div className="act" style={{ marginTop: 4, color: 'var(--faint)' }}>
          no phone paired yet — pairing lands with the security milestone
        </div>
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
