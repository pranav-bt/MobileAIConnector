// LIVE probe: what a quick check (engine.complete) and a tiny worker run
// send, and what they count. A quick check must stay small — it used to
// carry Claude Code's tool definitions, every MCP server on the PC and the
// settings + CLAUDE.md (~39k tokens for a ~1k job). Token counts include
// cache reads; the engine reports those separately too.
//   npx tsx test/probe-quick-check.ts [--model <id>]     Spends a little usage.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModel } from '@agent-hq/shared';
import { ClaudeEngine } from '../src/engine/claude.js';

const modelArg = process.argv.indexOf('--model');
const model = resolveModel('haiku', modelArg > 0 ? { model: process.argv[modelArg + 1]! } : undefined);
const engine = new ClaudeEngine();
let cacheReads = 0;
engine.observeUsage((tokens) => (cacheReads += tokens));
let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
};

const prompt =
  'Classify this request for an AI team. Reply with JSON only: {"team": "art" | "coding" | "docs"}.\n' +
  'Request: "Make 64x64 icons for every shop item."';
const started = Date.now();
const check1 = await engine.complete({ prompt, model });
check(check1.tokens > 0 && check1.tokens < 5000, `quick check on ${model.id}: ${check1.tokens} tokens in ${((Date.now() - started) / 1000).toFixed(1)} s (was ~39k) → ${check1.text.trim().slice(0, 60)}`);

const cwd = mkdtempSync(join(tmpdir(), 'agent-hq-probe-qc-'));
cacheReads = 0;
const run = await engine.runWorker({
  prompt: 'Reply with just the word ok. Do not use any tools.',
  team: { blockedTools: [], charter: 'Probe team.' },
  model: resolveModel('haiku'),
  cwd,
  maxSubagents: 0,
  callbacks: { onActivity: () => {}, onTokens: () => {}, onPermission: async () => 'deny' },
});
check(run.tokens > 10_000, `worker run: ${run.tokens} tokens counted (Claude Code's own context included)`);
console.log(`      of which re-read from the cache: ${cacheReads}`);
console.log(failures === 0 ? 'QUICK CHECK PROBE PASS' : `QUICK CHECK PROBE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
