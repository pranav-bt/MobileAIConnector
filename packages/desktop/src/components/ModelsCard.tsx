import type { ClientCommand, EffortLevel, HubState, ModelChoice, ModelOverrides, Team } from '@agent-hq/shared';
import { MODEL_CATALOG, MODEL_DEFAULTS, MODEL_IDS, PAIR_REVIEWER_DEFAULT, catalogModel } from '@agent-hq/shared';

// Owner's model + effort choices. Every dropdown has a "Default" option that
// clears just that one choice; "Reset all" clears them all. The hub keeps
// these as a layer over the team records, so defaults are never lost.

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};
const ALL_EFFORTS = Object.keys(EFFORT_LABELS) as EffortLevel[];
// Both engines in one list; a seat runs on whichever engine its model is from.
const ENGINE_GROUPS = [
  { engine: 'claude', label: 'Claude' },
  { engine: 'codex', label: 'Codex · ChatGPT plan' },
] as const;
const modelLabel = (id: string): string => catalogModel(id)?.label ?? id;

type Role = 'master' | 'checks' | 'lead' | 'worker' | 'reviewer';
type Seat = 'lead' | 'worker' | 'reviewer';
const ALL_NAMES: Record<Seat, string> = { lead: 'all leads', worker: 'all workers', reviewer: 'all reviewers' };

const selectStyle = (custom: boolean, minWidth: number, disabled = false): React.CSSProperties => ({
  background: 'var(--panel-2)',
  border: `1px solid ${custom ? 'rgba(79,216,196,0.55)' : 'var(--line-chip)'}`,
  borderRadius: 7,
  color: disabled ? 'var(--faint)' : custom ? 'var(--accent)' : 'var(--text-2)',
  fontSize: 11.5,
  padding: '5px 7px',
  minWidth,
  outline: 'none',
  cursor: disabled ? 'default' : 'pointer',
});

function ModelSelect(props: { value?: string; defaultLabel: string; onChange: (value?: string) => void }): JSX.Element {
  return (
    <select
      value={props.value ?? ''}
      onChange={(event) => props.onChange(event.target.value || undefined)}
      title={props.value ? `${catalogModel(props.value)?.description ?? ''} · pick Default to clear` : 'using the default model'}
      style={selectStyle(props.value !== undefined, 150)}
    >
      <option value="">Default · {props.defaultLabel}</option>
      {ENGINE_GROUPS.map((group) => (
        <optgroup key={group.engine} label={group.label}>
          {MODEL_CATALOG.filter((model) => model.engine === group.engine).map((model) => (
            <option key={model.id} value={model.id} title={model.description}>
              {model.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function EffortSelect(props: {
  value?: EffortLevel;
  efforts: EffortLevel[];
  defaultLabel: string;
  noEffortFor?: string; // model label when that model has no effort control
  onChange: (value?: EffortLevel) => void;
}): JSX.Element {
  if (props.noEffortFor) {
    return (
      <select disabled value="" style={selectStyle(false, 124, true)} title={`${props.noEffortFor} has no effort control`}>
        <option value="">effort n/a</option>
      </select>
    );
  }
  return (
    <select
      value={props.value ?? ''}
      onChange={(event) => props.onChange((event.target.value || undefined) as EffortLevel | undefined)}
      title={props.value ? 'custom effort · pick Default to clear' : 'the effort this model runs at when none is set'}
      style={selectStyle(props.value !== undefined, 124)}
    >
      <option value="">Default · {props.defaultLabel}</option>
      {props.efforts.map((effort) => (
        <option key={effort} value={effort}>
          {EFFORT_LABELS[effort]}
        </option>
      ))}
    </select>
  );
}

// Returns the choice with one field set or cleared (undefined when empty).
function withField(choice: ModelChoice | undefined, field: 'model' | 'effort', value?: string): ModelChoice | undefined {
  const next: ModelChoice = { ...(choice ?? {}) };
  if (field === 'model') {
    if (value) next.model = value;
    else delete next.model;
  } else {
    if (value) next.effort = value as EffortLevel;
    else delete next.effort;
  }
  return next.model || next.effort ? next : undefined;
}

export function ModelsCard(props: { state: HubState; send: (command: ClientCommand) => void }): JSX.Element {
  const overrides: ModelOverrides = props.state.info.modelOverrides ?? { teams: {} };
  const teams = Object.values(props.state.teams).sort((a, b) => a.createdAt - b.createdAt);

  const allChoices = [
    overrides.master,
    overrides.checks,
    overrides.lead,
    overrides.worker,
    overrides.reviewer,
    ...Object.values(overrides.teams).flatMap((choice) => [choice.lead, choice.worker, choice.reviewer]),
  ];
  const pairDefaults = Object.values(overrides.teams).filter((choice) => choice.pairByDefault).length;
  const customCount = allChoices.reduce((sum, c) => sum + (c?.model ? 1 : 0) + (c?.effort ? 1 : 0), 0) + pairDefaults + (overrides.failover ? 1 : 0);

  const apply = (next: ModelOverrides): void => {
    const cleanTeams = Object.fromEntries(
      Object.entries(next.teams).filter(([, choice]) => choice.lead || choice.worker || choice.reviewer || choice.pairByDefault),
    );
    props.send({ type: 'models.set', overrides: { ...next, teams: cleanTeams } });
  };

  const setRole = (role: Role, field: 'model' | 'effort', value?: string): void => {
    const next: ModelOverrides = { ...overrides, teams: { ...overrides.teams } };
    const choice = withField(overrides[role], field, value);
    if (choice) next[role] = choice;
    else delete next[role];
    apply(next);
  };

  const setTeam = (teamId: string, seat: Seat, field: 'model' | 'effort', value?: string): void => {
    const entry = { ...(overrides.teams[teamId] ?? {}) };
    const choice = withField(entry[seat], field, value);
    if (choice) entry[seat] = choice;
    else delete entry[seat];
    apply({ ...overrides, teams: { ...overrides.teams, [teamId]: entry } });
  };

  const setPairDefault = (teamId: string, on: boolean): void => {
    const entry = { ...(overrides.teams[teamId] ?? {}) };
    if (on) entry.pairByDefault = true;
    else delete entry.pairByDefault;
    apply({ ...overrides, teams: { ...overrides.teams, [teamId]: entry } });
  };

  // What a team's seat runs on when nothing is picked for it: the team's own
  // tier for lead/worker; for the pair reviewer, the other engine's flagship
  // from whatever the worker resolves to.
  const seatFallback = (team: Team, seat: Seat): string => {
    if (seat === 'lead') return MODEL_IDS[team.leadModel];
    if (seat === 'worker') return MODEL_IDS[team.workerModel];
    const workerId = overrides.teams[team.id]?.worker?.model ?? overrides.worker?.model ?? MODEL_IDS[team.workerModel];
    return PAIR_REVIEWER_DEFAULT[catalogModel(workerId)?.engine ?? 'claude'];
  };

  // Master / quick checks: fixed built-in default model.
  const fixedRoleControls = (role: 'master' | 'checks'): JSX.Element => {
    const choice = overrides[role];
    const defaultId = MODEL_IDS[MODEL_DEFAULTS[role]];
    const entry = catalogModel(choice?.model ?? defaultId);
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <ModelSelect value={choice?.model} defaultLabel={modelLabel(defaultId)} onChange={(v) => setRole(role, 'model', v)} />
        <EffortSelect
          value={choice?.effort}
          efforts={entry?.efforts ?? ALL_EFFORTS}
          defaultLabel={entry?.defaultEffort ? EFFORT_LABELS[entry.defaultEffort] : 'model default'}
          noEffortFor={entry && entry.efforts.length === 0 ? entry.label : undefined}
          onChange={(v) => setRole(role, 'effort', v)}
        />
      </div>
    );
  };

  // All leads / all workers: defaults vary per team.
  const allRoleControls = (role: Seat): JSX.Element => {
    const choice = overrides[role];
    const entry = choice?.model ? catalogModel(choice.model) : undefined;
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <ModelSelect value={choice?.model} defaultLabel={role === 'reviewer' ? 'the other engine' : 'per team'} onChange={(v) => setRole(role, 'model', v)} />
        <EffortSelect
          value={choice?.effort}
          efforts={entry?.efforts ?? ALL_EFFORTS}
          defaultLabel={entry?.defaultEffort ? EFFORT_LABELS[entry.defaultEffort] : 'per model'}
          noEffortFor={entry && entry.efforts.length === 0 ? entry.label : undefined}
          onChange={(v) => setRole(role, 'effort', v)}
        />
      </div>
    );
  };

  // One per-team seat: "Default" shows what it resolves to right now.
  const seatControls = (team: Team, seat: Seat): JSX.Element[] => {
    const teamId = team.id;
    const choice = overrides.teams[teamId]?.[seat];
    const all = overrides[seat];
    const allName = ALL_NAMES[seat];
    const inheritedId = all?.model ?? seatFallback(team, seat);
    const entry = catalogModel(choice?.model ?? inheritedId);
    const effortDefault =
      all?.effort && entry?.efforts.includes(all.effort)
        ? `${EFFORT_LABELS[all.effort]} (${allName})`
        : entry?.defaultEffort
          ? EFFORT_LABELS[entry.defaultEffort]
          : 'model default';
    return [
      <ModelSelect
        key={`${teamId}-${seat}-model`}
        value={choice?.model}
        defaultLabel={all?.model ? `${modelLabel(all.model)} (${allName})` : modelLabel(inheritedId)}
        onChange={(v) => setTeam(teamId, seat, 'model', v)}
      />,
      <EffortSelect
        key={`${teamId}-${seat}-effort`}
        value={choice?.effort}
        efforts={entry?.efforts ?? ALL_EFFORTS}
        defaultLabel={effortDefault}
        noEffortFor={entry && entry.efforts.length === 0 ? entry.label : undefined}
        onChange={(v) => setTeam(teamId, seat, 'effort', v)}
      />,
    ];
  };

  const roleRow = (label: string, hint: string, controls: JSX.Element): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10 }}>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text)' }}>{label}</div>
        <div className="act" style={{ color: 'var(--faint)' }}>{hint}</div>
      </div>
      {controls}
    </div>
  );

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(150px, 1fr) auto auto auto auto',
    columnGap: 8,
    rowGap: 7,
    marginTop: 8,
    alignItems: 'center',
  };

  const header = (text: string): JSX.Element => (
    <span className="act" style={{ color: 'var(--faint)' }}>{text}</span>
  );

  return (
    <div className="tcard" style={{ padding: 16, gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="sect" style={{ margin: 0 }}>Models</div>
        <span className="act" style={{ color: customCount > 0 ? 'var(--accent)' : 'var(--faint)' }}>
          {customCount > 0 ? `${customCount} custom` : 'all default'}
        </span>
        <div style={{ flexGrow: 1 }} />
        <button
          className="btn"
          disabled={customCount === 0}
          style={{
            flexGrow: 0,
            padding: '6px 14px',
            background: 'transparent',
            border: `1px solid ${customCount > 0 ? 'rgba(79,216,196,0.55)' : 'var(--line-chip)'}`,
            borderRadius: 8,
            color: customCount > 0 ? 'var(--accent)' : 'var(--faint)',
            fontSize: 11.5,
            cursor: customCount > 0 ? 'pointer' : 'default',
          }}
          onClick={() => apply({ teams: {} })}
        >
          Reset all to defaults
        </button>
      </div>
      <div className="act" style={{ marginTop: 6, color: 'var(--faint)' }}>
        Model and effort are set independently. A Default model keeps the built-in choice; a Default effort is the
        level that model runs at when none is set. Custom picks are highlighted and apply to work that starts from
        now (running tasks finish on what they started with). Any seat can be a Claude or a Codex model; Codex runs
        on your ChatGPT plan (its limits are on the Resources page). Codex workers don't run in Agent HQ's own
        project yet — there they use the team's Claude model. Pair mode (the Pair button, /pair, or a team's Pair
        box below): the worker does the task, a reviewer on the other engine checks the actual result read-only, and
        they go round until it agrees — the team lead chairs and answers you for both.
      </div>

      <div style={{ marginTop: 4 }}>
        {roleRow('Master', 'routes every task to a team and project', fixedRoleControls('master'))}
        {roleRow('Master: quick checks', 'handovers between teams, QA pass/fail verdicts, whether a big build splits, and the plain-English explanation on every approval card', fixedRoleControls('checks'))}
        {roleRow('All team leads', 'review every finished report into the synopsis (not the parallel parts of a split)', allRoleControls('lead'))}
        {roleRow('All workers', 'do the actual work', allRoleControls('worker'))}
        {roleRow('All pair reviewers', 'pair mode: check the worker\'s actual result (read-only) until they agree — default is the other engine from the worker', allRoleControls('reviewer'))}
        {roleRow(
          'When a plan is nearly used up',
          "at 90% of its 5-hour or weekly window, that engine's seats move to the other engine's flagship (Opus 5.5 / GPT-6.1-Sol) until it recovers; Agent HQ's own project keeps Claude workers",
          <label className="act" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: overrides.failover ? 'var(--accent)' : 'var(--text-2)' }}>
            <input
              type="checkbox"
              checked={!!overrides.failover}
              aria-label="Move work to the other engine when a plan is nearly used up"
              onChange={(event) => {
                const next: ModelOverrides = { ...overrides, teams: { ...overrides.teams } };
                if (event.target.checked) next.failover = true;
                else delete next.failover;
                apply(next);
              }}
            />
            {overrides.failover ? 'switch engines' : 'off'}
          </label>,
        )}
      </div>

      <div className="sect" style={{ marginTop: 18 }}>Per team (overrides All team leads / All workers)</div>
      <div style={gridStyle}>
        {header('team')}
        {header('lead model')}
        {header('lead effort')}
        {header('worker model')}
        {header('worker effort')}
        {teams.map((team) => [
          <span key={`${team.id}-name`} style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{team.name}</span>,
          ...seatControls(team, 'lead'),
          ...seatControls(team, 'worker'),
        ])}
      </div>

      <div className="sect" style={{ marginTop: 18 }}>Pair mode per team (overrides All pair reviewers)</div>
      <div style={{ ...gridStyle, gridTemplateColumns: 'minmax(150px, 1fr) auto auto auto' }}>
        {header('team')}
        {header('reviewer model')}
        {header('reviewer effort')}
        {header('pair by default')}
        {teams.map((team) => [
          <span key={`${team.id}-pname`} style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{team.name}</span>,
          ...seatControls(team, 'reviewer'),
          <label key={`${team.id}-pair`} className="act" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text-2)' }}>
            <input
              type="checkbox"
              checked={!!overrides.teams[team.id]?.pairByDefault}
              title={`Pair by default: every ${team.name} task gets a second-opinion reviewer (/solo skips it for one task)`}
              aria-label={`${team.name}: pair by default`}
              onChange={(event) => setPairDefault(team.id, event.target.checked)}
            />
            {overrides.teams[team.id]?.pairByDefault ? 'on' : 'off'}
          </label>,
        ])}
      </div>
    </div>
  );
}
