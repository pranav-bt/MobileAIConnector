// Codex freelancers against a mock hub and a FAKE ~/.codex: the owner's
// open Codex sessions appear in the office (named from session_index, last
// activity from the rollout's tail, Codex chip); Agent HQ's own threads,
// one-shot `codex exec` runs, sub-agents and old closed sessions don't; a
// session held open (writer lock) shows however old; an instruction becomes
// a freelancer task that continues that thread through the hub's engine.
//   npx tsx test/codex-freelancers.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type Agent, type ClientCommand, type HubEvent, type Task } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { codexSessionFacts, lastActivity } from '../src/codex-sessions.js';

const PORT = Number(process.env['CODEX_FL_SMOKE_PORT'] ?? 4649);
function fail(message: string): never {
  console.error(`CODEX FREELANCERS SMOKE FAIL: ${message}`);
  process.exit(1);
}

// The reader alone first.
{
  const head = '{"timestamp":"t","type":"session_meta","payload":{"id":"x","cwd":"D:\\\\Work\\\\Heat","originator":"codex_vscode","source":"vscode"}}';
  const facts = codexSessionFacts('rollout-2026-10-15T10-00-00-01a140b0-03bb-72c1-bab2-9e94f5f5d2be.jsonl', head, '');
  if (facts?.threadId !== '01a140b0-03bb-72c1-bab2-9e94f5f5d2be' || facts.cwd !== 'D:\\Work\\Heat') fail(`facts: ${JSON.stringify(facts)}`);
  if (codexSessionFacts('rollout-x-01a140b0-03bb-72c1-bab2-9e94f5f5d2be.jsonl', head.replace('codex_vscode', 'agent-hq'), '')) fail('our own thread counted');
  if (codexSessionFacts('rollout-x-01a140b0-03bb-72c1-bab2-9e94f5f5d2be.jsonl', head.replace('"vscode"', '"exec"'), '')) fail('an exec run counted');
  if (codexSessionFacts('rollout-x-01a140b0-03bb-72c1-bab2-9e94f5f5d2be.jsonl', head.replace('"source":"vscode"', '"source":{"subagent":{"other":"guardian"}}'), '')) fail('a sub-agent counted');
  const tail = [
    '{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\\"command\\":[\\"npm\\",\\"test\\"]}"}}',
    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed the pooling bug."}]}}',
    '{"type":"event_msg","payload":{"type":"token_count"}}',
  ].join('\n');
  if (lastActivity(tail) !== 'Fixed the pooling bug.') fail(`activity: ${lastActivity(tail)}`);
  if (lastActivity(tail.split('\n')[0]!) !== 'shell npm test') fail(`tool activity: ${lastActivity(tail.split('\n')[0]!)}`);
  console.log('reader ok: owner sessions only (not ours / exec / sub-agents), last message or tool as activity');
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-codexfl-'));
const projectDir = join(sandbox, 'Wyvern');
mkdirSync(projectDir);
const codexHome = join(sandbox, 'codex-home');
const now = new Date();
const dayDir = join(codexHome, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
mkdirSync(dayDir, { recursive: true });
mkdirSync(join(codexHome, 'thread-writer-locks'), { recursive: true });
const ids = {
  owner: '01a14300-0000-7000-8000-000000000001',
  ours: '01a14300-0000-7000-8000-000000000002',
  exec: '01a14300-0000-7000-8000-000000000003',
  sub: '01a14300-0000-7000-8000-000000000004',
  stale: '01a14300-0000-7000-8000-000000000005',
};
const rollout = (id: string, originator: string, source: string, text: string) => {
  const path = join(dayDir, `rollout-2026-10-15T10-00-00-${id}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id, cwd: projectDir, originator, source: source.startsWith('{') ? JSON.parse(source) : source } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
      '',
    ].join('\n'),
  );
  return path;
};
rollout(ids.owner, 'codex_vscode', 'vscode', 'Found the wyvern pooling leak.');
rollout(ids.ours, 'agent-hq', 'vscode', 'hub work');
rollout(ids.exec, 'codex_exec', 'exec', 'one-shot');
rollout(ids.sub, 'codex_vscode', '{"subagent":{"other":"guardian"}}', 'guardian');
const stalePath = rollout(ids.stale, 'codex_vscode', 'vscode', 'old chat');
const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
utimesSync(stalePath, tenMinutesAgo, tenMinutesAgo);
writeFileSync(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: ids.owner, thread_name: 'Find wyvern pooling bug', updated_at: 'x' })}\n`);

const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-codexfl-claude-')),
  codexHome,
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
await new Promise<void>((resolve) => ws.on('open', () => resolve()));
const send = (command: ClientCommand) => ws.send(encodeCommand(command));
send({ type: 'hello', client: 'cli', name: 'codex-fl-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 20000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const agentEvent = (prefix: string) => (e: HubEvent) =>
  (e.type === 'agent.updated' && e.agent.id.startsWith(`fx-${prefix}`)) ||
  (e.type === 'snapshot' && e.snapshot.agents.some((agent) => agent.id.startsWith(`fx-${prefix}`)));
const freelancer = (id: string): Agent | undefined => {
  for (const e of [...events].reverse()) {
    if (e.type === 'agent.updated' && e.agent.id === `fx-${id}`) return e.agent;
    if (e.type === 'snapshot') return e.snapshot.agents.find((agent) => agent.id === `fx-${id}`);
  }
  return undefined;
};

try {
  await waitFor('owner session appears', agentEvent(ids.owner));
  await new Promise((resolve) => setTimeout(resolve, 6000)); // one more scan
  const owner = freelancer(ids.owner)!;
  if (owner.name !== 'Find wyvern pooling bug' || owner.role !== 'freelancer' || owner.model !== 'codex') fail(`owner session: ${JSON.stringify(owner)}`);
  if (owner.activity !== 'Found the wyvern pooling leak.' || owner.status !== 'working') fail(`owner activity/status: ${owner.activity} / ${owner.status}`);
  for (const [label, id] of [['ours', ids.ours], ['exec', ids.exec], ['sub-agent', ids.sub], ['stale', ids.stale]] as const) {
    if (freelancer(id)) fail(`${label} session showed up as a freelancer`);
  }
  console.log('office ok: the owner\'s open Codex session shows (name, activity, Codex chip); ours / exec / sub-agent / old ones don\'t');

  // An instruction: a freelancer task that continues that thread through the hub's engine.
  const mark = events.length;
  send({ type: 'freelancer.send', agentId: `fx-${ids.owner}`, text: 'add a regression test for the leak' });
  const done = await waitFor(
    'freelancer task done',
    (e) => e.type === 'task.updated' && e.task.title.startsWith('[FL Find wyvern pooling bug]') && ['done', 'failed'].includes(e.task.status),
    30000,
    mark,
  );
  const task = (done as Extract<HubEvent, { type: 'task.updated' }>).task as Task;
  if (task.status !== 'done') fail(`freelancer task: ${task.status} ${task.synopsis}`);
  const lines = events.slice(mark).flatMap((e) => (e.type === 'activity' && e.entry.taskId === task.id ? [e.entry.message] : []));
  if (!lines.some((m) => m === 'mock: engine codex')) fail(`not run on the Codex engine: ${lines.join(' | ')}`);
  if (!lines.some((m) => m.startsWith('mock: resumed'))) fail('the thread was not continued');
  console.log('instruction ok: became a freelancer task, continued the thread on the Codex engine, reviewed');

  // (Held writer locks — open sessions however old — need a real Codex
  // process: test/codex-freelancer.live.ts covers them.)
  console.log('CODEX FREELANCERS SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
