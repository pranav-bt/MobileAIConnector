import { stepKind, type AskView, type HubState, type Task } from '@agent-hq/shared';

// One window per ask: the steps of an ask (QA, a handover, a part…) don't get
// cards of their own — this line on the ask's card says what they're doing.
export function StepLine(props: { state: HubState; task: Task & Partial<Pick<AskView, 'steps' | 'current' | 'liveSteps'>> }): JSX.Element | null {
  const { state, task } = props;
  const steps = task.steps ?? [];
  if (steps.length === 0) return null;
  const team = (step: Task) => (step.teamId && state.teams[step.teamId]?.name) || 'step';
  if (task.current) {
    const more = (task.liveSteps ?? 1) - 1;
    return (
      <div className="act" style={{ marginTop: 3, color: 'var(--accent)' }}>
        now: {team(task.current)} — {stepKind(task.current)}
        {more > 0 ? ` (+${more} more working)` : ''}
      </div>
    );
  }
  const mark = (step: Task) => (step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'paused' ? '■' : '…');
  const shown = steps.slice(-3);
  return (
    <div className="act" style={{ marginTop: 3, color: 'var(--faint)' }} title={steps.map((step) => `${team(step)} — ${step.title} (${step.status})`).join('\n')}>
      {steps.length > shown.length ? `${steps.length - shown.length} earlier · ` : ''}
      {shown.map((step) => `${stepKind(step)} ${mark(step)}`).join(' · ')}
    </div>
  );
}
