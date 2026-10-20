import { useEffect, useState } from 'react';
import type { ClientCommand, HubState, Team } from '@agent-hq/shared';
import { parseRules } from '@agent-hq/shared';

// The owner's RULES.md files: one per team (rules + tools, in every
// project; a project's CLAUDE.md adds on top, conflicts are asked and
// recorded here) and the master's (routing, handovers, splitting, what to
// do when a task is stuck). Teams also get their MCP connections here.

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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

type Send = (command: ClientCommand) => void;

// One line in, one bullet into a section of the file.
function QuickAdd(props: { targetId: string; section?: string; placeholder: string; send: Send }): JSX.Element {
  const [text, setText] = useState('');
  const add = (): void => {
    const rule = text.trim();
    if (!rule) return;
    props.send({ type: 'team.rules.add', teamId: props.targetId, rule, ...(props.section ? { section: props.section } : {}) });
    setText('');
  };
  return (
    <input
      style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 10 }}
      placeholder={props.placeholder}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') add();
      }}
    />
  );
}

function BulletList(props: { items: string[]; empty: string }): JSX.Element {
  if (props.items.length === 0) return <span className="empty-note" style={{ display: 'block', marginTop: 8 }}>{props.empty}</span>;
  return (
    <div style={{ marginTop: 8 }}>
      {props.items.map((text, index) => (
        <div key={index} style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, padding: '2px 0' }}>• {text}</div>
      ))}
    </div>
  );
}

// The whole file, editable. Follows the file while not editing; mid-edit it
// keeps the draft and says when the file changed underneath.
function RulesEditor(props: { targetId: string; path: string; saved: string; hint: string; send: Send }): JSX.Element {
  const { saved } = props;
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  const dirty = draft !== base;

  useEffect(() => {
    if (!dirty) {
      setDraft(saved);
      setBase(saved);
    }
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tcard" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="sect" style={{ margin: 0 }}>RULES.md</div>
        <span className="act mono" style={{ color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {props.path}
        </span>
        <div style={{ flexGrow: 1 }} />
        {dirty && saved !== base && <span className="act" style={{ color: 'var(--amber)' }}>changed elsewhere since you started</span>}
        <button
          className="btn"
          disabled={!dirty}
          style={{ ...smallBtn(dirty), flexGrow: 0 }}
          onClick={() => {
            setDraft(saved);
            setBase(saved);
          }}
        >
          Revert
        </button>
        <button
          className="btn"
          disabled={!dirty}
          style={{ ...smallBtn(dirty), flexGrow: 0 }}
          onClick={() => {
            props.send({ type: 'team.rules.set', teamId: props.targetId, markdown: draft });
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
      <div className="act" style={{ color: 'var(--faint)', marginTop: 6 }}>{props.hint}</div>
    </div>
  );
}

function MasterRules(props: { state: HubState; send: Send }): JSX.Element {
  const saved = props.state.info.masterRules ?? '';
  const parsed = parseRules(saved);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div className="tcard" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div className="sect" style={{ margin: 0 }}>Master</div>
          <span className="act" style={{ color: parsed.rules.length > 0 ? 'var(--accent)' : 'var(--faint)' }}>
            {parsed.rules.length > 0 ? plural(parsed.rules.length, 'rule') : 'no rules yet'}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 6 }}>
          How the master picks teams, hands work between them, splits big tasks, and what it does when a task gets
          stuck (a run fails, the lead says the worker couldn't finish, or QA still fails after two fixes). When stuck it
          proposes a retry, a handover or a split and asks you — unless a rule under "When a task is stuck" lets it go
          ahead. Rules never move a task to another project.
        </div>
        <BulletList items={parsed.rules} empty="none yet — the master uses its defaults" />
        <QuickAdd targetId="master" placeholder="add a rule for every master decision… (Enter)" send={props.send} />
        <QuickAdd targetId="master" section="stuck" placeholder="add a rule for when a task is stuck… (Enter)" send={props.send} />
      </div>
      <RulesEditor
        key="master"
        targetId="master"
        path={`${props.state.info.dataDir}\\master\\RULES.md`}
        saved={saved}
        hint='one rule per "- " line, under ## Rules (every decision), ## Routing, ## Handover, ## Splitting or ## When a task is stuck · /rule master/stuck: <text> from the composer'
        send={props.send}
      />
    </div>
  );
}

function Connections(props: { team: Team; catalog: string[]; send: Send }): JSX.Element {
  const granted = Object.keys(props.team.mcpServers ?? {});
  const names = [...new Set([...props.catalog, ...granted])].sort();
  const toggle = (name: string): void => {
    const next = granted.includes(name) ? granted.filter((entry) => entry !== name) : [...granted, name];
    props.send({ type: 'team.mcp.set', teamId: props.team.id, servers: next });
  };
  return (
    <div className="tcard" style={{ padding: 16 }}>
      <div className="sect" style={{ margin: 0 }}>Connections (MCP)</div>
      <div className="act" style={{ color: 'var(--faint)', marginTop: 4 }}>
        servers set up for Claude Code on this PC. {props.team.name} workers get the ones ticked, in every project — plus,
        like Claude Code opened in that folder, the servers set up for the project they're working in (its own, and its
        .mcp.json ones you approved).
      </div>
      {names.length === 0 ? (
        <span className="empty-note" style={{ display: 'block', marginTop: 8 }}>none configured on this PC</span>
      ) : (
        names.map((name) => (
          <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={granted.includes(name)} onChange={() => toggle(name)} />
            <span style={{ color: granted.includes(name) ? 'var(--text)' : 'var(--text-2)' }}>{name}</span>
            {!props.catalog.includes(name) && <span className="act" style={{ color: 'var(--amber)' }}>not configured on this PC</span>}
          </label>
        ))
      )}
    </div>
  );
}

function TeamRules(props: { team: Team; state: HubState; send: Send }): JSX.Element {
  const { team, send } = props;
  const saved = team.rules ?? '';
  const parsed = parseRules(saved);
  const projectName = (id: string): string => props.state.projects[id]?.name ?? id;
  const decided = parsed.resolutions.map((line) => {
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    return match ? { project: projectName(match[1]!), text: match[2]! } : { project: '', text: line };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div className="tcard" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div className="sect" style={{ margin: 0 }}>{team.name}</div>
          <span className="act" style={{ color: parsed.rules.length > 0 ? 'var(--accent)' : 'var(--faint)' }}>
            {parsed.rules.length > 0 ? plural(parsed.rules.length, 'rule') : 'no rules yet'}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 6 }}>{team.charter}</div>
        <BulletList items={parsed.rules} empty="no rules yet" />
        <QuickAdd targetId={team.id} placeholder={`add a rule for every ${team.name} worker… (Enter)`} send={send} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className="tcard" style={{ padding: 16 }}>
          <div className="sect" style={{ margin: 0 }}>Tools</div>
          <div className="act" style={{ color: 'var(--faint)', marginTop: 4 }}>
            what this team has and what each is for — workers use them for those jobs (commands still go through the
            normal permission checks)
          </div>
          <BulletList items={parsed.tools} empty="none listed" />
          <QuickAdd targetId={team.id} section="tools" placeholder="magick (ImageMagick CLI): resize and convert images" send={send} />
        </div>
        <Connections team={team} catalog={props.state.info.mcpCatalog ?? []} send={send} />
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

      <RulesEditor
        key={team.id}
        targetId={team.id}
        path={`${team.memoryDir}\\RULES.md`}
        saved={saved}
        hint='one rule per "- " line · group them under any "## " heading · tools under "## Tools" · also editable in any editor (picked up within a few seconds) · /rule <team>: <text> or /rule <team>/tools: <tool> from the composer'
        send={send}
      />
    </div>
  );
}

export function TeamsPage(props: { state: HubState; send: Send }): JSX.Element {
  const teams = Object.values(props.state.teams).sort((a, b) => a.createdAt - b.createdAt);
  const [selected, setSelected] = useState<string>('master');
  const team = selected === 'master' ? undefined : teams.find((candidate) => candidate.id === selected);
  const masterCount = parseRules(props.state.info.masterRules ?? '').rules.length;

  const row = (id: string, name: string, count: number, tools = 0): JSX.Element => {
    const active = id === (team?.id ?? 'master');
    return (
      <div
        key={id}
        onClick={() => setSelected(id)}
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
        <span style={{ fontSize: 12.5, color: active ? 'var(--text)' : 'var(--text-2)', flexGrow: 1 }}>{name}</span>
        <span className="act" style={{ color: count + tools > 0 ? 'var(--accent)' : 'var(--faint)' }} title={`${plural(count, 'rule')}, ${plural(tools, 'tool')}`}>
          {count}{tools > 0 ? ` · ${tools}t` : ''}
        </span>
      </div>
    );
  };

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14, alignContent: 'start', overflowY: 'auto' }}>
      <div className="tcard" style={{ padding: 10, alignSelf: 'start' }}>
        <div className="sect" style={{ margin: '4px 6px 8px' }}>Rules</div>
        {row('master', 'Master', masterCount)}
        <div style={{ height: 1, background: 'var(--line-chip)', margin: '6px 4px' }} />
        {teams.map((candidate) => {
          const parsed = parseRules(candidate.rules ?? '');
          return row(candidate.id, candidate.name, parsed.rules.length, parsed.tools.length);
        })}
      </div>
      {team ? (
        <TeamRules key={team.id} team={team} state={props.state} send={props.send} />
      ) : (
        <MasterRules state={props.state} send={props.send} />
      )}
    </div>
  );
}
