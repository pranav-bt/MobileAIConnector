import { useState } from 'react';
import type { ClientCommand, HubState } from '@agent-hq/shared';
import { isActive } from '../status';

export function TopBar(props: {
  state: HubState;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const activeCount = Object.values(props.state.agents).filter(isActive).length;
  const weeklyPct = Math.round(props.state.usage.weeklyPct);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    props.send({ type: 'task.submit', text: trimmed });
    setText('');
  };

  return (
    <div className="topbar">
      <div className="composer">
        <span style={{ color: 'var(--accent)', fontSize: 14 }}>✦</span>
        <input
          value={text}
          placeholder="Give the master agent a task…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      </div>
      <span className="pill">
        <span className="dot" style={{ background: 'var(--green)' }} />
        {activeCount} AGENTS ACTIVE
      </span>
      <span className="pill">WEEKLY&nbsp;&nbsp;{weeklyPct}%</span>
    </div>
  );
}
