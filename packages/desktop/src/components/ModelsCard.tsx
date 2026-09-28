import type { ClientCommand, HubState, ModelOverrides, ModelTier } from '@agent-hq/shared';
import { MODEL_DEFAULTS } from '@agent-hq/shared';

// Owner's model choices. Every dropdown has a "Default" option that clears
// that one choice; "Reset all" clears them all. The hub keeps these as a
// layer over the team records, so defaults are never lost.

const TIERS: { value: ModelTier; label: string }[] = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const tierLabel = (tier: ModelTier): string => TIERS.find((t) => t.value === tier)?.label ?? tier;

function ModelSelect(props: {
  value: ModelTier | undefined;
  defaultLabel: string;
  onChange: (value: ModelTier | undefined) => void;
}): JSX.Element {
  const custom = props.value !== undefined;
  return (
    <select
      value={props.value ?? ''}
      onChange={(event) => props.onChange(event.target.value ? (event.target.value as ModelTier) : undefined)}
      title={custom ? 'custom choice: pick Default to clear it' : 'using the default'}
      style={{
        background: 'var(--panel-2)',
        border: `1px solid ${custom ? 'rgba(79,216,196,0.55)' : 'var(--line-chip)'}`,
        borderRadius: 7,
        color: custom ? 'var(--accent)' : 'var(--text-2)',
        fontSize: 12,
        padding: '6px 8px',
        minWidth: 170,
        outline: 'none',
        cursor: 'pointer',
      }}
    >
      <option value="">Default · {props.defaultLabel}</option>
      {TIERS.map((tier) => (
        <option key={tier.value} value={tier.value}>
          {tier.label}
        </option>
      ))}
    </select>
  );
}

export function ModelsCard(props: { state: HubState; send: (command: ClientCommand) => void }): JSX.Element {
  const overrides: ModelOverrides = props.state.info.modelOverrides ?? { teams: {} };
  const teams = Object.values(props.state.teams).sort((a, b) => a.createdAt - b.createdAt);

  const customCount =
    [overrides.master, overrides.checks, overrides.lead, overrides.worker].filter(Boolean).length +
    Object.values(overrides.teams).reduce((sum, choice) => sum + (choice.lead ? 1 : 0) + (choice.worker ? 1 : 0), 0);

  const apply = (next: ModelOverrides): void => {
    // Drop empty per-team entries so the stored layer stays minimal.
    const cleanTeams = Object.fromEntries(
      Object.entries(next.teams).filter(([, choice]) => choice.lead || choice.worker),
    );
    props.send({ type: 'models.set', overrides: { ...next, teams: cleanTeams } });
  };

  const setRole = (role: 'master' | 'checks' | 'lead' | 'worker', value: ModelTier | undefined): void => {
    const next: ModelOverrides = { ...overrides, teams: { ...overrides.teams } };
    if (value) next[role] = value;
    else delete next[role];
    apply(next);
  };

  const setTeam = (teamId: string, role: 'lead' | 'worker', value: ModelTier | undefined): void => {
    const choice = { ...(overrides.teams[teamId] ?? {}) };
    if (value) choice[role] = value;
    else delete choice[role];
    apply({ ...overrides, teams: { ...overrides.teams, [teamId]: choice } });
  };

  const roleRow = (label: string, hint: string, control: JSX.Element): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 10 }}>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text)' }}>{label}</div>
        <div className="act" style={{ color: 'var(--faint)' }}>{hint}</div>
      </div>
      {control}
    </div>
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
        Pick the model for each role. Default keeps the built-in choice; custom picks are highlighted and apply to
        work that starts from now (running tasks finish on the model they started with).
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 32, marginTop: 4 }}>
        <div>
          {roleRow(
            'Master',
            'routes every task to a team and project',
            <ModelSelect value={overrides.master} defaultLabel={tierLabel(MODEL_DEFAULTS.master)} onChange={(v) => setRole('master', v)} />,
          )}
          {roleRow(
            'Master: quick checks',
            'handovers between teams and QA pass/fail verdicts',
            <ModelSelect value={overrides.checks} defaultLabel={tierLabel(MODEL_DEFAULTS.checks)} onChange={(v) => setRole('checks', v)} />,
          )}
        </div>
        <div>
          {roleRow(
            'All team leads',
            'review every worker report into the synopsis',
            <ModelSelect value={overrides.lead} defaultLabel="per team" onChange={(v) => setRole('lead', v)} />,
          )}
          {roleRow(
            'All workers',
            'do the actual work',
            <ModelSelect value={overrides.worker} defaultLabel="per team" onChange={(v) => setRole('worker', v)} />,
          )}
        </div>
      </div>

      <div className="sect" style={{ marginTop: 18 }}>Per team (overrides All team leads / All workers)</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(160px, 1fr) auto auto',
          columnGap: 14,
          rowGap: 8,
          marginTop: 8,
          alignItems: 'center',
        }}
      >
        <span className="act" style={{ color: 'var(--faint)' }}>team</span>
        <span className="act" style={{ color: 'var(--faint)' }}>lead</span>
        <span className="act" style={{ color: 'var(--faint)' }}>workers</span>
        {teams.map((team) => {
          const choice = overrides.teams[team.id] ?? {};
          // What "Default" resolves to for this cell right now.
          const leadDefault = overrides.lead ? `${tierLabel(overrides.lead)} (all leads)` : tierLabel(team.leadModel);
          const workerDefault = overrides.worker
            ? `${tierLabel(overrides.worker)} (all workers)`
            : tierLabel(team.workerModel);
          return [
            <span key={`${team.id}-name`} style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{team.name}</span>,
            <ModelSelect key={`${team.id}-lead`} value={choice.lead} defaultLabel={leadDefault} onChange={(v) => setTeam(team.id, 'lead', v)} />,
            <ModelSelect key={`${team.id}-worker`} value={choice.worker} defaultLabel={workerDefault} onChange={(v) => setTeam(team.id, 'worker', v)} />,
          ];
        })}
      </div>
    </div>
  );
}
