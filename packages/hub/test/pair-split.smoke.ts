// Pair mode "plan together, then split" end to end against a mock hub: the
// author drafts a split plan (read-only), the partner (other engine) reviews
// it until it agrees; the parts run in parallel, each on its builder's model
// and reviewed by the OTHER model; the author integrates and the partner
// reviews the whole in its plan conversation. Invalid plans go back to the
// author unreviewed; "not worth splitting", text-only teams and Agent HQ's
// own project fall back to a second opinion; the plan round cap asks.
//   npx tsx test/pair-split.smoke.ts   (mock engine, no usage)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type PermissionRequest, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['PAIR_SPLIT_SMOKE_PORT'] ?? 4645);
function fail(message: string): never {
  console.error(`PAIR SPLIT SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-pairsplit-'));
const projectDir = join(sandbox, 'Splitproj');
mkdirSync(projectDir);
const git = (...args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { stdio: 'ignore' });
git('init', '-q');
writeFileSync(join(projectDir, 'README.md'), '# splitproj\n');
git('add', '.');
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'init');

const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-pairsplit-claude-')),
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
send({ type: 'hello', client: 'cli', name: 'pair-split-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const snapshot = await waitFor('snapshot', (e) => e.type === 'snapshot');
const hubProjectId =
  snapshot.type === 'snapshot' ? snapshot.snapshot.projects.find((project) => project.workspaceDir === snapshot.snapshot.info.workspaceDir)?.id : undefined;
if (!hubProjectId) fail('no project for the hub workspace in the snapshot');

const taskOf = (taskId: string): Task | undefined =>
  ([...events].reverse().find((e) => e.type === 'task.updated' && e.task.id === taskId) as Extract<HubEvent, { type: 'task.updated' }> | undefined)?.task;
const created = async (marker: string) => {
  const e = await waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker) && !ev.task.parentTaskId);
  return e.type === 'task.updated' ? e.task.id : '';
};
const finished = (taskId: string, from: number, statuses = ['done', 'failed']) =>
  waitFor(`${taskId} → ${statuses.join('/')}`, (e) => e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status), 30000, from);
const card = async (prefix: string, from: number): Promise<PermissionRequest> => {
  const e = await waitFor(`card ${prefix}`, (ev) => ev.type === 'permission.updated' && ev.request.id.startsWith(prefix) && ev.request.status === 'pending', 30000, from);
  return (e as Extract<HubEvent, { type: 'permission.updated' }>).request;
};
const activities = (taskId: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'activity' && e.entry.taskId === taskId ? [e.entry.message] : []));
const children = (parentId: string) => [
  ...new Map(events.flatMap((e) => (e.type === 'task.updated' && e.task.parentTaskId === parentId ? [[e.task.id, e.task.id] as const] : []))).keys(),
];
const rowsFor = (taskId: string) => {
  const rows = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) rows.set(entry.id, entry);
  return [...rows.values()];
};
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));
const CLAUDE_AUTHOR = 'claude-sonnet-5'; // the coding team's worker seat (tier sonnet)
const CODEX_PARTNER = 'gpt-6.1-sol';

try {
  send({ type: 'project.register', name: 'Splitproj', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'splitproj');

  // 1. Agree first time: parts on their builders' engines, each reviewed by
  // the other model; integration by the author, whole reviewed by the partner.
  let mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj coding: pairsplit-basic build the two modules' });
  const basic = await created('pairsplit-basic');
  send({ type: 'task.watch', taskId: basic });
  await finished(basic, mark);
  await settle();
  let task = taskOf(basic)!;
  if (task.detail.startsWith('split ')) fail('the "split" word stayed in the task');
  if (task.status !== 'done' || task.pair?.mode !== 'split') fail(`basic: ${task.status} ${task.pair?.mode}`);
  const plan = task.pair.plan;
  if (!plan?.agreed || plan.rounds !== 1 || plan.parts.map((part) => part.builder).join(',') !== 'author,partner') fail(`basic plan: ${JSON.stringify(plan)}`);
  const [partA, partB] = plan.parts.map((part) => (part.taskId ? taskOf(part.taskId) : undefined));
  if (!partA || !partB) fail('the plan does not point at its part tasks');
  if (partA.seat?.model !== CLAUDE_AUTHOR || partB.seat?.model !== CODEX_PARTNER) fail(`part seats: ${partA.seat?.model} / ${partB.seat?.model}`);
  if (!activities(partA.id).includes(`mock: model ${CLAUDE_AUTHOR} · effort default`)) fail('part A did not run on the author');
  if (!activities(partB.id).some((m) => m.startsWith(`mock: model ${CODEX_PARTNER}`))) fail('part B did not run on the partner');
  if (partA.pair?.reviewerModel !== CODEX_PARTNER || partB.pair?.reviewerModel !== CLAUDE_AUTHOR) fail(`cross-review seats: ${partA.pair?.reviewerModel} / ${partB.pair?.reviewerModel}`);
  if (!activities(partA.id).includes('mock: read-only review · engine codex')) fail('part A was not reviewed by Codex');
  if (!activities(partB.id).includes('mock: read-only review · engine claude')) fail('part B was not reviewed by Claude');
  if (!/second opinion/i.test(partA.synopsis ?? '')) fail(`part A's report lacks its review: ${partA.synopsis}`);
  if (!activities(basic, mark).includes('mock: read-only review · engine codex · resumed')) fail('the partner did not review the whole in its plan conversation');
  if (task.pair.rounds.length !== 1 || task.pair.reviewerModel !== CODEX_PARTNER || task.pair.authorModel !== CLAUDE_AUTHOR) fail(`final review: ${JSON.stringify(task.pair.rounds)} ${task.pair.reviewerModel}`);
  if (!/with the second opinion/.test(task.synopsis ?? '')) fail(`the lead's synopsis missed the second opinion: ${task.synopsis}`);
  const planner = events.find((e) => e.type === 'agent.updated' && e.agent.taskId === basic && /^coding-p\d+$/.test(e.agent.id));
  if (!planner || planner.type !== 'agent.updated' || planner.agent.modelId !== CLAUDE_AUTHOR) fail('no visible planner on the author seat');
  const links = rowsFor(basic).filter((r) => r.linkTaskId).map((r) => r.linkTaskId);
  if (!links.includes(partA.id) || !links.includes(partB.id)) fail('the console has no links to the parts');
  if (!activities(basic, mark).some((m) => /plan agreed in round 1/.test(m))) fail('no "plan agreed" line');
  if (!activities(basic, mark).some((m) => /split into 2 parallel parts: Module A \(Sonnet 5\) · Module B \(GPT-6\.1-Sol\)/.test(m))) fail('the split line does not name the builders');
  console.log('split ok: plan agreed, parts on their builders (Claude A, Codex B), each reviewed by the other, partner reviewed the whole in its plan conversation');

  // 2. The partner wants changes once: the author revises in its planning conversation.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj coding: plan-disagree-once build the two modules' });
  const revised = await created('plan-disagree-once');
  await finished(revised, mark);
  task = taskOf(revised)!;
  if (!task.pair?.plan?.agreed || task.pair.plan.rounds !== 2) fail(`expected agreement in plan round 2: ${JSON.stringify(task.pair?.plan)}`);
  if (!activities(revised, mark).includes('mock: plan draft · engine claude · resumed')) fail('the author did not revise in its planning conversation');
  if (!activities(revised, mark).includes('mock: plan review · engine codex · resumed')) fail('the partner did not re-check in its conversation');
  if (!activities(revised, mark).some((m) => /plan round 1: GPT-6\.1-Sol wants changes — module B needs its own config/.test(m))) fail('no "wants changes" line');
  console.log('plan revise ok: partner wanted changes → author revised in the same session → agreed in round 2');

  // 3. An invalid plan goes straight back to the author (no partner review).
  mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj coding: pairsplit-invalid-once build the two modules' });
  const invalid = await created('pairsplit-invalid-once');
  await finished(invalid, mark);
  task = taskOf(invalid)!;
  if (!activities(invalid, mark).some((m) => /plan round 1: .*can't be used — parts did not own non-empty, disjoint file sets/.test(m))) fail('the overlapping plan was not refused');
  const planReviews = activities(invalid, mark).filter((m) => m.startsWith('mock: plan review')).length;
  if (planReviews !== 1 || task.pair?.plan?.rounds !== 2 || !task.pair.plan.agreed) fail(`invalid plan reviewed or not fixed: ${planReviews} reviews, ${JSON.stringify(task.pair?.plan)}`);
  console.log('invalid plan ok: refused without a partner review, fixed in round 2, agreed');

  // 4. "Not worth splitting": the pair still works, as a second opinion.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj coding: pairsplit-solo tweak one line' });
  const solo = await created('pairsplit-solo');
  await finished(solo, mark);
  task = taskOf(solo)!;
  if (task.pair?.mode !== 'review' || task.pair.state !== 'agreed' || children(solo).length !== 0) fail(`solo fallback: ${JSON.stringify(task.pair)} children ${children(solo).length}`);
  if (!activities(solo, mark).some((m) => /second opinion instead: Sonnet 5 judged it not worth splitting/.test(m))) fail('no fallback line for "not worth splitting"');
  console.log('not worth splitting ok: author built it, partner reviewed it');

  // 5. Plan round cap: card with three answers. "Skip the split" → second opinion;
  // "Go with this plan" → the split runs on the latest plan.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj coding: plan-never-agree skip check' });
  const skip = await created('plan-never-agree skip');
  let ask = await card(`pair-${skip}-plan3`, mark);
  if (ask.options?.join('|') !== 'Go with this plan|Two more rounds|Skip the split') fail(`plan card options: ${ask.options?.join('|')}`);
  if (!/haven't agreed how to split/.test(ask.summary ?? '') || !/Module B — GPT-6\.1-Sol/.test(ask.command)) fail(`plan card text: ${ask.summary} / ${ask.command}`);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 2 });
  await finished(skip, mark);
  if (taskOf(skip)?.pair?.mode !== 'review' || children(skip).length !== 0) fail('"Skip the split" still split');
  mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj coding: plan-never-agree go check' });
  const go = await created('plan-never-agree go');
  ask = await card(`pair-${go}-plan3`, mark);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 1 });
  ask = await card(`pair-${go}-plan5`, mark);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 0 });
  await finished(go, mark);
  task = taskOf(go)!;
  if (task.status !== 'done' || children(go).length !== 2 || task.pair?.plan?.agreed !== false || task.pair.plan.rounds !== 5) fail(`go-with-plan: ${task.status} ${children(go).length} parts ${JSON.stringify(task.pair?.plan)}`);
  console.log('plan cap ok: card at 3 (three answers) → skip = second opinion; two more → card at 5 → go with the plan = split ran');

  // 6. Stop at the plan card: nothing gets built.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj coding: plan-never-agree stop check' });
  const stopped = await created('plan-never-agree stop');
  ask = await card(`pair-${stopped}-plan3`, mark);
  send({ type: 'task.stop', taskId: stopped });
  await finished(stopped, mark, ['paused']);
  await settle();
  if (children(stopped).length !== 0) fail('a task stopped while planning built parts');
  console.log('stop ok: stopped at the plan card, nothing built');

  // 7. Fallbacks: a text-only team, and Agent HQ's own project (Codex may not build there).
  mark = events.length;
  send({ type: 'task.submit', text: '/pair split @splitproj design: textsplit write the style guide' });
  const text = await created('textsplit');
  await finished(text, mark);
  if (taskOf(text)?.pair?.mode !== 'review' || !activities(text, mark).some((m) => /can't run two builders at once/.test(m))) fail('a text team was not turned into a second opinion');
  mark = events.length;
  send({ type: 'task.submit', text: `/pair split @${hubProjectId} coding: hubsplit build the two modules` });
  const own = await created('hubsplit');
  await finished(own, mark);
  task = taskOf(own)!;
  if (task.pair?.mode !== 'review' || children(own).length !== 0) fail(`hub project split: ${JSON.stringify(task.pair)}`);
  if (!activities(own, mark).some((m) => /Codex doesn't build in Agent HQ's own project yet/.test(m))) fail('no hub-project fallback line');
  if (!activities(own, mark).includes('mock: read-only review · engine codex')) fail('Codex did not review in the hub project');
  console.log("fallbacks ok: text team and Agent HQ's own project run as a second opinion (Codex reviews, never builds there)");

  console.log('PAIR SPLIT SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
