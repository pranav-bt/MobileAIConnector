// Measures the effort each model ACTUALLY runs at when the hub passes no
// effort (Claude Code exports the applied level to Bash as CLAUDE_EFFORT),
// and confirms an explicit effort is honored. Spends a little usage.
//   npx tsx test/probe-effort-defaults.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const ids = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const runs: { id: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }[] = [
  ...ids.map((id) => ({ id })),
  { id: 'claude-sonnet-5', effort: 'max' }, // explicit override is honored?
];

for (const run of runs) {
  let observed = '(none)';
  let outcome = 'no result';
  try {
    const stream = query({
      prompt: 'Run this exact bash command and reply with only its output: echo "EFFORT=[$CLAUDE_EFFORT]"',
      options: {
        model: run.id,
        maxTurns: 3,
        allowedTools: ['Bash'],
        ...(run.effort ? { effort: run.effort } : {}),
      },
    });
    for await (const message of stream) {
      const m = message as unknown as Record<string, unknown>;
      if (m['type'] === 'result') {
        const text = String(m['result'] ?? '');
        const match = text.match(/EFFORT=\[([^\]]*)\]/);
        observed = match ? match[1] || '(empty — no effort sent)' : `(unparsed: ${text.slice(0, 60)})`;
        outcome = m['is_error'] ? 'ERROR' : 'ok';
      }
    }
  } catch (error) {
    outcome = `THREW ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
  }
  console.log(JSON.stringify({ id: run.id, passedEffort: run.effort ?? null, appliedEffort: observed, outcome }));
}
process.exit(0);
