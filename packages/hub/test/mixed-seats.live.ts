// LIVE: the owner's example seat mix on a real hub (own port, temp data):
// master on Fable 5.1, Coding lead on Opus 5.5, Coding workers on Codex
// GPT-6.1-Sol. A real task runs end to end in a throwaway project, a Codex
// worker's risky command raises an Agent HQ approval card (and a denial is
// honored), and the Codex plan's limits reach the usage meters.
// Spends some usage on both plans.   npx tsx test/mixed-seats.live.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = 4631;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-mixed-'));
const projectDir = join(sandbox, 'Mixproj');
mkdirSync(projectDir);
writeFileSync(join(projectDir, 'README.md'), '# Mixproj\nA scratch project for the mixed-seats live test.\n');
const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-mixed-claude-')),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const events: HubEvent[] = [];
const waiters: { test: (e: HubEvent) => boolean; resolve: (e: HubEvent) => void }[] = [];
ws.on('message', (raw) => {
  const event = decodeEvent(raw.toString());
  if (!event) return;
  events.push(event);
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 600_000): Promise<HubEvent> => {
  const already = events.find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const send = (command: Parameters<typeof encodeCommand>[0]) => ws.send(encodeCommand(command));
// Stop QA follow-ups as they appear: this test is about seats, not QA usage.
ws.on('message', (raw) => {
  const event = decodeEvent(raw.toString());
  if (event?.type === 'task.updated' && event.task.title.startsWith('[QA]') && ['queued', 'in_flight'].includes(event.task.status)) {
    send({ type: 'task.stop', taskId: event.task.id });
  }
});

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'mixed-seats-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');

  send({
    type: 'models.set',
    overrides: {
      master: { model: 'claude-fable-5-1' },
      teams: { coding: { lead: { model: 'claude-opus-5-5' }, worker: { model: 'gpt-6.1-sol', effort: 'low' } } },
    },
  });
  await waitFor('seats set', (e) => e.type === 'hub.updated' && e.info.modelOverrides.teams['coding']?.worker?.model === 'gpt-6.1-sol');
  record('master chip', !!(await waitFor('master on fable', (e) => e.type === 'agent.updated' && e.agent.id === 'master' && e.agent.modelId === 'claude-fable-5-1', 10_000)), 'Fable 5.1');
  send({ type: 'project.register', name: 'Mixproj', workspaceDir: projectDir });
  await waitFor('project registered', (e) => e.type === 'project.updated' && e.project.id === 'mixproj');

  // 1. A real task, end to end.
  const started = Date.now();
  send({ type: 'task.submit', text: '@mixproj coding: create a file named pancake.md containing a two-line poem about pancakes, then report what you wrote.' });
  const routed = await waitFor('routed', (e) => e.type === 'task.updated' && e.task.detail.includes('pancake.md') && e.task.teamId === 'coding');
  const taskId = routed.type === 'task.updated' ? routed.task.id : '';
  const worker = await waitFor('codex worker', (e) => e.type === 'agent.updated' && e.agent.taskId === taskId && e.agent.role === 'worker');
  record('worker seat', worker.type === 'agent.updated' && worker.agent.modelId === 'gpt-6.1-sol', worker.type === 'agent.updated' ? `${worker.agent.name} on ${worker.agent.modelId}` : '');
  const done = await waitFor('task finished', (e) => e.type === 'task.updated' && e.task.id === taskId && ['done', 'failed'].includes(e.task.status));
  const task = done.type === 'task.updated' ? done.task : null;
  record('task done', task?.status === 'done', `${task?.status} in ${((Date.now() - started) / 1000).toFixed(0)}s · ${task?.tokensUsed} tokens`);
  const poem = join(projectDir, 'pancake.md');
  record('file written in the project', existsSync(poem), existsSync(poem) ? readFileSync(poem, 'utf8').trim().replace(/\n/g, ' / ').slice(0, 120) : 'missing');
  record('lead synopsis', !!task?.synopsis && task.synopsis.length > 20, (task?.synopsis ?? '').split('\n')[0]!.slice(0, 120));
  const workerLines = events.filter((e) => e.type === 'activity' && e.entry.taskId === taskId && e.entry.agentId.startsWith('coding-w')).map((e) => (e.type === 'activity' ? e.entry.message : ''));
  record('worker activity streamed', workerLines.length > 0, workerLines.slice(0, 4).join(' | ').slice(0, 200));

  // 2. A risky command from the Codex worker raises an Agent HQ card; deny it.
  send({ type: 'task.submit', text: '@mixproj coding: run `npm install left-pad --no-save` in this project folder, then report whether it worked.' });
  const card = await waitFor('install card', (e) => e.type === 'permission.updated' && e.request.status === 'pending' && e.request.flags.some((flag) => /install/i.test(flag)));
  if (card.type === 'permission.updated') {
    record('codex command raised a card', true, `${card.request.flags.join(', ')} · "${(card.request.summary ?? '').slice(0, 100)}"`);
    send({ type: 'permission.respond', requestId: card.request.id, decision: 'deny', scope: 'once' });
    const after = await waitFor('install task finished', (e) => e.type === 'task.updated' && e.task.id === card.request.taskId && ['done', 'failed'].includes(e.task.status));
    const installed = existsSync(join(projectDir, 'node_modules', 'left-pad'));
    record('denial honored', !installed, `task ${after.type === 'task.updated' ? after.task.status : '?'} · left-pad installed: ${installed}`);
  }

  // 3. The Codex plan's limits reach the meters (read once a minute while Codex runs).
  const limits = await waitFor('codex limits', (e) => e.type === 'usage.updated' && !!e.usage.codex, 90_000).catch(() => null);
  record('codex limits on the meters', !!limits, limits?.type === 'usage.updated' ? JSON.stringify(limits.usage.codex) : 'none within 90s');
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nMIXED SEATS LIVE FAIL: ${failed.map((f) => f.check).join('; ')}` : '\nMIXED SEATS LIVE PASS');
process.exit(failed.length ? 1 : 0);
