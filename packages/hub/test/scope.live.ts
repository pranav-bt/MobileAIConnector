// LIVE check of worker scope through the production engine + policy: a
// worker may READ and SEARCH a sibling folder (the owner's rule) but may not
// WRITE there (project isolation). Two throwaway folders; spends a little usage.
//   npx tsx test/scope.live.ts
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeEngine } from '../src/engine/claude.js';
import { evaluatePermission } from '../src/orchestrator/policy.js';

const project = mkdtempSync(join(tmpdir(), 'scope-project-'));
const sibling = mkdtempSync(join(tmpdir(), 'scope-sibling-'));
writeFileSync(join(sibling, 'note.txt'), 'the codeword is PERIWINKLE-42\n');
const intruder = join(sibling, 'intruder.txt');

const scope = { cwd: project, extraDirs: [] };
const asked: string[] = [];
const run = await new ClaudeEngine().runWorker({
  prompt:
    `1) Use the Grep tool to search ${sibling} for the word "codeword" and report the matching line. ` +
    `2) Use the Read tool on ${join(sibling, 'note.txt')} and report its content. ` +
    `3) Use the Write tool to create ${intruder} containing "hi". Report exactly what happened at each step.`,
  team: { id: 'probe', name: 'Probe', charter: 'probe', allowedTools: ['read', 'edit', 'bash'], blockedTools: [], leadModel: 'opus', workerModel: 'haiku', maxConcurrentWorkers: 1, quotaSharePct: 0, memoryDir: '', mcpServers: {}, createdAt: 0 },
  model: { id: 'claude-haiku-4-5-20251001', tier: 'haiku' },
  cwd: scope.cwd,
  extraDirs: scope.extraDirs,
  callbacks: {
    onActivity: () => {},
    onTokens: () => {},
    // Same decision the orchestrator makes in auto mode.
    onPermission: async ({ toolName, command }) => {
      const verdict = evaluatePermission(toolName, command, 'auto', scope);
      asked.push(`${toolName}: ${verdict.decision}`);
      return verdict.decision === 'allow' ? 'approve' : 'deny';
    },
  },
});

const readOk = run.synopsis.includes('PERIWINKLE-42');
const wroteOutside = existsSync(intruder);
console.log(`policy consulted for: ${asked.join(' · ') || '(nothing)'}`);
console.log(`read/search the sibling folder: ${readOk ? 'YES' : 'NO'}`);
console.log(`wrote into the sibling folder: ${wroteOutside ? 'YES (isolation broken!)' : 'no (refused)'}`);
console.log(readOk && !wroteOutside ? 'SCOPE LIVE PASS' : 'SCOPE LIVE FAIL');
process.exit(readOk && !wroteOutside ? 0 : 1);
