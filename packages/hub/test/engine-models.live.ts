// LIVE check of the production ClaudeEngine with explicit model + effort
// specs (what Settings > Models produces). Spends a little usage.
//   npx tsx test/engine-models.live.ts
import { tmpdir } from 'node:os';
import { ClaudeEngine } from '../src/engine/claude.js';

const engine = new ClaudeEngine();

// 1. A one-shot call (master routing / lead review path) on Opus 5.5.
const reply = await engine.complete({
  prompt: 'Reply with exactly: OK',
  model: { id: 'claude-opus-5-5', tier: 'opus', effort: 'low' },
});
console.log(`complete on claude-opus-5-5 @ low -> "${reply.text.trim()}" (${reply.tokens} tokens)`);

// 2. A worker run: the applied effort is visible to Bash as CLAUDE_EFFORT.
// Sonnet 5 defaults to xhigh, so seeing 'max' proves the override applied.
const run = await engine.runWorker({
  prompt: 'Run this exact bash command and reply with only its output: echo "EFFORT=[$CLAUDE_EFFORT]"',
  team: { id: 'probe', name: 'Probe', charter: 'probe', allowedTools: ['bash'], blockedTools: [], leadModel: 'opus', workerModel: 'sonnet', maxConcurrentWorkers: 1, quotaSharePct: 0, memoryDir: '', mcpServers: {}, createdAt: 0 },
  model: { id: 'claude-sonnet-5', tier: 'sonnet', effort: 'max' },
  cwd: tmpdir(),
  callbacks: {
    onActivity: () => {},
    onTokens: () => {},
    onPermission: async () => 'approve',
  },
});
const applied = run.synopsis.match(/EFFORT=\[([^\]]*)\]/)?.[1] ?? '(unparsed)';
console.log(`runWorker on claude-sonnet-5 asked max -> applied "${applied}"`);
const ok = reply.text.trim().startsWith('OK') && applied === 'max';
console.log(ok ? 'ENGINE MODELS LIVE PASS' : 'ENGINE MODELS LIVE FAIL');
process.exit(ok ? 0 : 1);
