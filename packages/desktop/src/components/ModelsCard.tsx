import type { ClientCommand, EffortLevel, HubState, ModelChoice, ModelOverrides, ModelTier } from '@agent-hq/shared';
import { MODEL_CATALOG, MODEL_DEFAULTS, MODEL_IDS, catalogModel } from '@agent-hq/shared';

// Owner's model + effort choices. Every dropdown has a "Default" option that
// clears just that one choice; "Reset all" clears them all. The hub keeps
// these as a layer over the team records, so defaults are never lost.

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const ALL_EFFORTS = Object.keys(EFFORT_LABELS) as EffortLevel[];
const modelLabel = (id: string): string => catalogModel(id)?.label ?? id;

type Role = 'master' | 'checks' | 'lead' | 'worker';
type Seat = 'lead' | 'worker';

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
      {MODEL_CATALOG.map((model) => (
        <option key={model.id} value={model.id} title={model.description}>
          {model.label}
        </option>
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
    ...Object.values(overrides.teams).flatMap((choice) => [choice.lead, choice.worker]),
  ];
  const customCount = allChoices.reduce((sum, c) => sum + (c?.model ? 1 : 0) + (c?.effort ? 1 : 0), 0);

  const apply = (next: ModelOverrides): void => {
    const cleanTeams = Object.fromEntries(Object.entries(next.teams).filter(([, choice]) => choice.lead || choice.worker));
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
  const allRoleControls = (role: 'lead' | 'worker'): JSX.Element => {
    const choice = overrides[role];
    const entry = choice?.model ? catalogModel(choice.model) : undefined;
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <ModelSelect value={choice?.model} defaultLabel="per team" onChange={(v) => setRole(role, 'model', v)} />
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
  const seatControls = (teamId: string, seat: Seat, teamDefault: ModelTier): JSX.Element[] => {
    const choice = overrides.teams[teamId]?.[seat];
    const all = overrides[seat];
    const allName = seat === 'lead' ? 'all leads' : 'all workers';
    const inheritedId = all?.model ?? MODEL_IDS[teamDefault];
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
        now (running tasks finish on what they started with).
      </div>

      <div style={{ marginTop: 4 }}>
        {roleRow('Master', 'routes every task to a team and project', fixedRoleControls('master'))}
        {roleRow('Master: quick checks', 'handovers between teams, QA pass/fail verdicts, whether a big build splits, and the plain-English explanation on every approval card', fixedRoleControls('checks'))}
        {roleRow('All team leads', 'review every finished report into the synopsis (not the parallel parts of a split)', allRoleControls('lead'))}
        {roleRow('All workers', 'do the actual work', allRoleControls('worker'))}
      </div>

      <div className="sect" style={{ marginTop: 18 }}>Per team (overrides All team leads / All workers)</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(150px, 1fr) auto auto auto auto',
          columnGap: 8,
          rowGap: 7,
          marginTop: 8,
          alignItems: 'center',
        }}
      >
        {header('team')}
        {header('lead model')}
        {header('lead effort')}
        {header('worker model')}
        {header('worker effort')}
        {teams.map((team) => [
          <span key={`${team.id}-name`} style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{team.name}</span>,
          ...seatControls(team.id, 'lead', team.leadModel),
          ...seatControls(team.id, 'worker', team.workerModel),
        ])}
      </div>
    </div>
  );
}
