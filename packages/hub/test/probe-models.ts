// Model catalog probes for the Settings > Models dropdowns.
//   npx tsx test/probe-models.ts            -> the account's catalog (no usage)
//   npx tsx test/probe-models.ts --live     -> also runs one tiny prompt per
//                                              candidate id with an effort set,
//                                              reporting the model/effort the
//                                              session actually applied
import { query } from '@anthropic-ai/claude-agent-sdk';

async function* idle(): AsyncGenerator<never> {
  await new Promise(() => {}); // never yields a user message
}

const catalogSession = query({ prompt: idle(), options: {} });
for (const model of await catalogSession.supportedModels()) {
  console.log(
    'catalog',
    JSON.stringify({ value: model.value, resolved: model.resolvedModel, efforts: model.supportedEffortLevels ?? null, description: model.description }),
  );
}
await catalogSession.interrupt().catch(() => {});

if (process.argv.includes('--live')) {
  const candidates: { id: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }[] = [
    { id: 'claude-opus-5-5', effort: 'low' },
    { id: 'claude-opus-5', effort: 'low' },
    { id: 'claude-opus-5[1m]', effort: 'low' },
    { id: 'claude-fable-5-1', effort: 'low' },
    { id: 'claude-sonnet-5', effort: 'low' },
    { id: 'claude-haiku-5-5', effort: 'low' },
    { id: 'claude-haiku-4-5-20251001' },
  ];
  for (const candidate of candidates) {
    let initModel = '?';
    let initEffort: unknown = '?';
    let outcome = 'no result';
    try {
      const stream = query({
        prompt: 'Reply with exactly: OK',
        options: {
          model: candidate.id,
          maxTurns: 1,
          allowedTools: [],
          ...(candidate.effort ? { effort: candidate.effort } : {}),
        },
      });
      for await (const message of stream) {
        const m = message as unknown as Record<string, unknown>;
        if (m['type'] === 'system' && m['subtype'] === 'init') {
          initModel = String(m['model']);
          initEffort = m['effort'] ?? '(not reported)';
        }
        if (m['type'] === 'result') {
          outcome = m['is_error'] ? `ERROR ${String(m['result'] ?? m['subtype']).slice(0, 120)}` : `ok: ${String(m['result']).slice(0, 20)}`;
        }
      }
    } catch (error) {
      outcome = `THREW ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
    }
    console.log('live', JSON.stringify({ id: candidate.id, askedEffort: candidate.effort ?? null, initModel, initEffort, outcome }));
  }
}
process.exit(0);
