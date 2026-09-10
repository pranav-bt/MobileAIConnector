import type { Agent, HubState, PermissionRequest } from '@agent-hq/shared';
import { initialsOf, isActive, ringColor } from '../status';

function AgentChip(props: { agent: Agent; dim?: boolean; pending?: PermissionRequest }): JSX.Element {
  const { agent, pending } = props;
  return (
    <>
      {pending && <div className="bubble">requesting: {pending.command}</div>}
      <div
        className={`chip${props.dim ? ' dim' : ''}`}
        style={pending ? { borderColor: 'rgba(232,180,74,0.55)' } : undefined}
      >
        <div className="av" style={{ borderColor: ringColor(agent) }}>
          {initialsOf(agent)}
        </div>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <div className="nm">{agent.name}</div>
          <div
            className="act"
            style={{
              color: agent.status === 'waiting_permission' ? 'var(--amber)' : undefined,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {agent.activity || agent.status}
          </div>
        </div>
        {agent.role === 'lead' && <span className="tag">Lead</span>}
      </div>
    </>
  );
}

export function Office(props: { state: HubState }): JSX.Element {
  const { state } = props;
  const agents = Object.values(state.agents);
  const master = agents.find((agent) => agent.role === 'master');
  const teams = Object.values(state.teams).sort((a, b) => a.createdAt - b.createdAt);
  const loungeAgents = agents.filter((agent) => agent.role === 'worker' && agent.teamId === null);
  const freelancers = agents.filter((agent) => agent.role === 'freelancer');
  // Agents whose activity is a meeting (e.g. QA + source-team leads over QA
  // findings) render in the Meeting room while it lasts.
  const meetingAgents = agents.filter((agent) => agent.activity.startsWith('meeting:'));
  const meetingTopic = meetingAgents[0]?.activity.replace(/^meeting:\s*/, '') ?? '';
  const pendingByAgent = new Map(
    Object.values(state.permissions)
      .filter((request) => request.status === 'pending')
      .map((request) => [request.agentId, request] as const),
  );

  const teamAgents = (teamId: string): Agent[] =>
    agents
      .filter((agent) => agent.teamId === teamId)
      .sort((a, b) => (a.role === 'lead' ? -1 : b.role === 'lead' ? 1 : a.name.localeCompare(b.name)));

  return (
    <div className="floor">
      {/* Master office */}
      <div className="room master">
        <div className="lbl">Master office</div>
        {master ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <div
              className="av"
              style={{
                width: 40,
                height: 40,
                fontSize: 12,
                borderColor: 'var(--accent)',
                boxShadow: '0 0 18px rgba(79,216,196,0.28)',
              }}
            >
              M
            </div>
            <div>
              <div className="nm" style={{ fontSize: 14 }}>{master.name}</div>
              <div className="act" style={{ color: 'var(--accent)' }}>{master.activity}</div>
            </div>
          </div>
        ) : (
          <div className="empty-note" style={{ marginTop: 16 }}>no master agent yet</div>
        )}
      </div>

      {/* Meeting room */}
      <div className="room">
        <div className="lbl">Meeting room</div>
        {meetingAgents.length === 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 80 }}>
              <div
                style={{
                  width: 130,
                  height: 54,
                  border: '1.5px dashed #2A3444',
                  borderRadius: 27,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span className="empty-note">empty</span>
              </div>
            </div>
            <div className="act" style={{ color: 'var(--faint)' }}>leads gather here for cross-team tasks</div>
          </>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                minHeight: 80,
                border: '1.5px solid rgba(232,180,74,0.45)',
                borderRadius: 27,
                padding: '8px 14px',
                marginTop: 8,
              }}
            >
              {meetingAgents.map((agent) => (
                <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div className="av" style={{ borderColor: 'var(--amber)' }}>
                    {initialsOf(agent)}
                  </div>
                  <span className="nm">{agent.name}</span>
                </div>
              ))}
            </div>
            <div className="act" style={{ color: 'var(--amber)', marginTop: 8 }}>{meetingTopic}</div>
          </>
        )}
      </div>

      {/* Lounge */}
      <div className="room">
        <div className="lbl">Lounge</div>
        <div className="chips">
          {loungeAgents.length === 0 && <span className="empty-note">nobody idle</span>}
          {loungeAgents.map((agent) => (
            <AgentChip key={agent.id} agent={agent} dim />
          ))}
        </div>
      </div>

      {/* Team rooms — one per config record, in creation order */}
      {teams.map((team) => {
        const members = teamAgents(team.id);
        const activeCount = members.filter(isActive).length;
        return (
          <div key={team.id} className="room">
            <div className="room-head">
              <div className="lbl">{team.name}</div>
              <div className="lbl" style={{ color: activeCount > 0 ? 'var(--green)' : undefined }}>
                {activeCount > 0 ? `${activeCount} active` : 'standby'}
              </div>
            </div>
            <div className="chips">
              {members.length === 0 && <span className="empty-note">room being furnished…</span>}
              {members.map((agent) => (
                <AgentChip key={agent.id} agent={agent} pending={pendingByAgent.get(agent.id)} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Freelancers strip */}
      <div className="room wide">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div className="lbl">Freelancers</div>
            <div className="act" style={{ color: 'var(--faint)', marginTop: 3 }}>
              observed terminal sessions · read-only
            </div>
          </div>
          {freelancers.length === 0 && (
            <span className="empty-note">terminal Claude Code sessions appear here automatically</span>
          )}
          {freelancers.map((agent) => (
            <div key={agent.id} className="chip" style={{ minWidth: 320 }}>
              <div className="av" style={{ borderColor: ringColor(agent), borderRadius: 6 }}>
                {'>_'}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="nm">{agent.name}</div>
                <div className="act" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent.activity}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
