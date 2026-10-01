import { useEffect, useState } from 'react';
import type { ClientCommand, HubState, Team } from '@agent-hq/shared';
import { parseRules } from '@agent-hq/shared';

// Per-team rules (RULES.md): the owner's standing rules for every worker of
// a team, in every project. A project's CLAUDE.md adds on top; when the two
// disagree the master asks which wins and records the answer here.

const inputStyle: React.CSSProperties = {
  background: 'var(--panel-2)',
  border: '1px solid var(--line-chip)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 12,
  padding: '7px 9px',
  outline: 'none',
};

const smallBtn = (active: boolean): React.CSSProperties => ({
  background: 'transparent',
  border: `1px solid ${active ? 'rgba(79,216,196,0.55)' : 'var(--line-chip)'}`,
  borderRadius: 8,
  color: active ? 'var(--accent)' : 'var(--faint)',
  fontSize: 11.5,
  padding: '6px 14px',
  cursor: active ? 'pointer' : 'default',
});

function TeamRules(props: { team: Team; state: HubState; send: (command: ClientCommand) => void }): JSX.Element {
  const { team, send } = props;
  const saved = team.rules ?? '';
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved); // the version the draft started from
  const [rule, setRule] = useState('');
  const dirty = draft !== base;

  // Follow the file while not editing; mid-edit, keep the draft and say so.
  useEffect(() => {
    if (!dirty) {
      setDraft(saved);
      setBase(saved);
    }
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = parseRules(saved);
  const projectName = (id: string): string => props.state.projects[id]?.name ?? id;
  const decided = parsed.resolutions.map((line) => {
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    return match ? { project: projectName(match[1]!), text: match[2]! } : { project: '', text: line };
  });

  const addRule = (): void => {
    const text = rule.trim();
    if (!text) return;
    send({ type: 'team.rules.add', teamId: team.id, rule: text });
    setRule('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div className="tcard" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div className="sect" style={{ margin: 0 }}>{team.name}</div>
          <span className="act" style={{ color: parsed.rules.length > 0 ? 'var(--accent)' : 'var(--faint)' }}>
            {parsed.rules.length > 0 ? `${parsed.rules.length} rule${parsed.rules.length === 1 ? '' : 's'}` : 'no rules yet'}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 6 }}>{team.charter}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <input
            style={{ ...inputStyle, flexGrow: 1 }}
            placeholder={`add a rule for every ${team.name} worker… (Enter)`}
            value={rule}
            onChange={(event) => setRule(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addRule();
            }}
          />
        </div>
        {parsed.rules.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {parsed.rules.map((text, index) => (
              <div key={index} style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, padding: '2px 0' }}>
                • {text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect" style={{ margin: 0 }}>Decided conflicts</div>
        <div className="act" style={{ color: 'var(--faint)', marginTop: 4 }}>
          when a project's CLAUDE.md disagrees with these rules you get a card; your answer lands here. Delete a line in
          the file below to be asked again.
        </div>
        {decided.length === 0 ? (
          <span className="empty-note" style={{ display: 'block', marginTop: 8 }}>none yet</span>
        ) : (
          decided.map((entry, index) => (
            <div key={index} style={{ fontSize: 12, lineHeight: 1.5, marginTop: 6 }}>
              {entry.project && <span style={{ color: 'var(--accent)' }}>{entry.project} · </span>}
              <span style={{ color: 'var(--text-2)' }}>{entry.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="sect" style={{ margin: 0 }}>RULES.md</div>
          <span className="act mono" style={{ color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {team.memoryDir}\RULES.md
          </span>
          <div style={{ flexGrow: 1 }} />
          {dirty && saved !== base && (
            <span className="act" style={{ color: 'var(--amber)' }}>changed elsewhere since you started</span>
          )}
          <button className="btn" disabled={!dirty} style={{ ...smallBtn(dirty), flexGrow: 0 }} onClick={() => { setDraft(saved); setBase(saved); }}>
            Revert
          </button>
          <button
            className="btn"
            disabled={!dirty}
            style={{ ...smallBtn(dirty), flexGrow: 0 }}
            onClick={() => {
              send({ type: 'team.rules.set', teamId: team.id, markdown: draft });
              setBase(draft);
            }}
          >
            Save
          </button>
        </div>
        <textarea
          className="mono"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', minHeight: 280, marginTop: 10, lineHeight: 1.5, resize: 'vertical' }}
        />
        <div className="act" style={{ color: 'var(--faint)', marginTop: 6 }}>
          one rule per "- " line · group them under any "## " heading · also editable in any editor (the office picks up
          changes within a few seconds) · /rule &lt;team&gt;: &lt;text&gt; from the composer
        </div>
      </div>
    </div>
  );
}

export function TeamsPage(props: { state: HubState; send: (command: ClientCommand) => void }): JSX.Element {
  const teams = Object.values(props.state.teams).sort((a, b) => a.createdAt - b.createdAt);
  const [selected, setSelected] = useState<string | null>(null);
  const team = teams.find((candidate) => candidate.id === selected) ?? teams[0];

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14, alignContent: 'start', overflowY: 'auto' }}>
      <div className="tcard" style={{ padding: 10, alignSelf: 'start' }}>
        <div className="sect" style={{ margin: '4px 6px 8px' }}>Teams</div>
        {teams.map((candidate) => {
          const count = parseRules(candidate.rules ?? '').rules.length;
          const active = candidate.id === team?.id;
          return (
            <div
              key={candidate.id}
              onClick={() => setSelected(candidate.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 8px',
                borderRadius: 7,
                cursor: 'pointer',
                background: active ? 'var(--panel-2)' : 'transparent',
              }}
            >
              <span style={{ fontSize: 12.5, color: active ? 'var(--text)' : 'var(--text-2)', flexGrow: 1 }}>{candidate.name}</span>
              <span className="act" style={{ color: count > 0 ? 'var(--accent)' : 'var(--faint)' }}>{count}</span>
            </div>
          );
        })}
      </div>
      {team ? (
        <TeamRules key={team.id} team={team} state={props.state} send={props.send} />
      ) : (
        <span className="empty-note">no teams yet — /team add &lt;name&gt;: &lt;charter&gt;</span>
      )}
    </div>
  );
}
