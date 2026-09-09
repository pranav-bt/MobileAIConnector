import type { HubState } from '@agent-hq/shared';
import { formatResetDay, formatResetTime, formatTokens, usageColor } from '../status';

// Categorical hues for the model mix — validated for the dark surface
// (lightness band, CVD separation, contrast) during the design phase.
const TIER_COLORS = { sonnet: '#14A38B', opus: '#7B66E8', haiku: '#BE8A2D' } as const;

export function ResourcesPage(props: { state: HubState }): JSX.Element {
  const { usage, tasks, teams } = props.state;
  const mix = usage.modelMixPct;
  const hasMix = mix.opus + mix.sonnet + mix.haiku > 0;

  const teamTokens = Object.values(teams)
    .map((team) => ({
      team,
      tokens: Object.values(tasks)
        .filter((task) => task.teamId === team.id)
        .reduce((sum, task) => sum + task.tokensUsed, 0),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const maxTeamTokens = Math.max(1, ...teamTokens.map((entry) => entry.tokens));

  const topTasks = Object.values(tasks)
    .filter((task) => task.tokensUsed > 0)
    .sort((a, b) => b.tokensUsed - a.tokensUsed)
    .slice(0, 6);

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignContent: 'start', overflowY: 'auto' }}>
      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Session — 5-hour window</div>
        {usage.windowResetsAt > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <span className="mono" style={{ fontSize: 24, fontWeight: 600 }}>{Math.round(usage.windowPct)}%</span>
              <span className="act">used · resets {formatResetTime(usage.windowResetsAt)}</span>
            </div>
            <div className="track" style={{ marginTop: 10 }}>
              <div className="fill" style={{ width: `${usage.windowPct}%`, background: usageColor(usage.windowPct) }} />
            </div>
            <div className="act" style={{ marginTop: 8, color: 'var(--faint)' }}>
              whole account — chat sessions, terminal Claude Code, and HQ agents alike
            </div>
          </>
        ) : (
          <span className="empty-note" style={{ display: 'block', marginTop: 10 }}>
            unavailable — is Claude Code signed in on this PC?
          </span>
        )}
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Weekly limit</div>
        {usage.weeklyResetsAt > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <span className="mono" style={{ fontSize: 24, fontWeight: 600 }}>{Math.round(usage.weeklyPct)}%</span>
              <span className="act">used · resets {formatResetDay(usage.weeklyResetsAt)}</span>
            </div>
            <div className="track" style={{ marginTop: 10 }}>
              <div className="fill" style={{ width: `${usage.weeklyPct}%`, background: usageColor(usage.weeklyPct) }} />
            </div>
            <div className="act" style={{ marginTop: 8, color: 'var(--faint)' }}>
              overage spending: {usage.overageEnabled ? 'ON — usage past the limit costs money' : 'off — hitting a limit only pauses work'}
            </div>
          </>
        ) : (
          <span className="empty-note" style={{ display: 'block', marginTop: 10 }}>
            unavailable — refreshed every 5 minutes while the hub runs real agents
          </span>
        )}
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Tokens by HQ agents</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
          <span className="mono" style={{ fontSize: 24, fontWeight: 600 }}>{formatTokens(usage.tokensToday)}</span>
          <span className="act">HQ's own share of the meters above (persists over restarts)</span>
        </div>
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Model mix</div>
        {hasMix ? (
          <>
            <div style={{ display: 'flex', gap: 2, height: 10, borderRadius: 5, overflow: 'hidden', marginTop: 12 }}>
              {mix.sonnet > 0 && <div style={{ width: `${mix.sonnet}%`, background: TIER_COLORS.sonnet }} />}
              {mix.opus > 0 && <div style={{ width: `${mix.opus}%`, background: TIER_COLORS.opus }} />}
              {mix.haiku > 0 && <div style={{ width: `${mix.haiku}%`, background: TIER_COLORS.haiku }} />}
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
              <span className="act" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: TIER_COLORS.sonnet, display: 'inline-block' }} />
                Sonnet {mix.sonnet}% · workers
              </span>
              <span className="act" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: TIER_COLORS.opus, display: 'inline-block' }} />
                Opus {mix.opus}% · master &amp; leads
              </span>
              <span className="act" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: TIER_COLORS.haiku, display: 'inline-block' }} />
                Haiku {mix.haiku}% · chores
              </span>
            </div>
          </>
        ) : (
          <span className="empty-note" style={{ display: 'block', marginTop: 10 }}>no usage recorded yet</span>
        )}
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Team usage</div>
        {teamTokens.length === 0 && <span className="empty-note" style={{ display: 'block', marginTop: 10 }}>no teams yet</span>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {teamTokens.map(({ team, tokens }) => (
            <div key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, width: 90, flexShrink: 0 }}>{team.name.replace(/ team$/i, '')}</span>
              <div className="track" style={{ flexGrow: 1, marginTop: 0 }}>
                <div className="fill" style={{ width: `${Math.round((tokens / maxTeamTokens) * 100)}%` }} />
              </div>
              <span className="act" style={{ width: 52, textAlign: 'right' }}>{formatTokens(tokens)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Top tasks by tokens</div>
        {topTasks.length === 0 && <span className="empty-note" style={{ display: 'block', marginTop: 10 }}>nothing measured yet</span>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {topTasks.map((task) => (
            <div key={task.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
              <span className="act" style={{ flexShrink: 0 }}>{formatTokens(task.tokensUsed)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
