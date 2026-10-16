// Pair mode (second opinion) end to end against a mock hub: a reviewer on
// the other engine checks the author's work read-only; blocking issues go
// back to the author's SAME conversation; agreement names a version of the
// work; the round cap asks the owner (go with it / two more rounds / stop);
// an unreadable verdict is asked again once, then goes to the owner; the
// lead chairs — a question gets an answer, a change request is re-reviewed;
// /pair, /solo, the submit flag and a team's "pair by default" decide.
//   npx tsx test/pair.smoke.ts   (mock engine, no usage)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, parseExchange, parseVerdict, type ClientCommand, type HubEvent, type PermissionRequest, type Task, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = Number(process.env['PAIR_SMOKE_PORT'] ?? 4643);
function fail(message: string): never {
  console.error(`PAIR SMOKE FAIL: ${message}`);
  process.exit(1);
}

// The verdict parser first: prose around the JSON, "agree" with blocking
// issues, nothing readable.
{
  const prose = parseVerdict('I checked the diff {not json} and: {"agree": true, "blocking": [], "minor": ["x"], "summary": "fine"} done');
  if (!prose?.agree || prose.minor[0] !== 'x') fail(`prose verdict misread: ${JSON.stringify(prose)}`);
  const contradiction = parseVerdict('{"agree": true, "blocking": ["tests fail"], "summary": "ok"}');
  if (!contradiction || contradiction.agree || contradiction.blocking[0] !== 'tests fail') fail('"agree" with blocking issues counted as agreement');
  const vague = parseVerdict('{"agree": false, "summary": "needs work"}');
  if (!vague || vague.blocking[0] !== 'needs work') fail('a disagreement without issues lost its summary');
  if (parseVerdict('looks fine to me') !== null) fail('no JSON should be no verdict');
  if (parseVerdict('{"summary": "x", "nested": {"agree": "yes"}}') !== null) fail('a non-boolean agree counted');
  const fenced = parseVerdict('Here you go:\n```json\n{"agree": false, "blocking": ["no tests"], "summary": "s"}\n```\nthanks');
  if (!fenced || fenced.agree || fenced.blocking[0] !== 'no tests') fail('a fenced verdict was misread');
  const exchange = parseExchange('{"accept": false, "critique": ["c"], "draft": "function f() { return {a: 1}; } // \\"quoted\\" }"}');
  if (!exchange || exchange.accept || !exchange.draft.includes('return {a: 1}')) fail(`braces inside a draft broke the exchange: ${JSON.stringify(exchange)}`);
  const started = Date.now();
  const hostile = parseVerdict(`${'{"x": '.repeat(8000)}${'{'.repeat(8000)}`);
  if (hostile !== null || Date.now() - started > 500) fail(`a hostile 40k reply took ${Date.now() - started} ms`);
  console.log('verdicts ok: prose-wrapped JSON, agree-with-blockers is no agreement, no JSON is no verdict');
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-pair-'));
const dataDir = join(sandbox, 'data');
const projectDir = join(sandbox, 'Pairproj');
mkdirSync(projectDir);
// A git repo, so agreement names a version of the actual work.
const git = (...args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { stdio: 'ignore' });
git('init', '-q');
writeFileSync(join(projectDir, 'loader.ts'), 'export const load = () => 1;\n');
git('add', '.');
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'init');

const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir,
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-pair-claude-')),
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
send({ type: 'hello', client: 'cli', name: 'pair-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 20000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
await waitFor('snapshot', (e) => e.type === 'snapshot');

const taskOf = (taskId: string): Task | undefined =>
  ([...events].reverse().find((e) => e.type === 'task.updated' && e.task.id === taskId) as Extract<HubEvent, { type: 'task.updated' }> | undefined)?.task;
const created = async (marker: string) => {
  const e = await waitFor(`created ${marker}`, (ev) => ev.type === 'task.updated' && ev.task.detail.includes(marker));
  return e.type === 'task.updated' ? e.task.id : '';
};
const finished = (taskId: string, from: number, statuses = ['done', 'failed']) =>
  waitFor(`${taskId} → ${statuses.join('/')}`, (e) => e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status), 20000, from);
const card = async (prefix: string, from: number): Promise<PermissionRequest> => {
  const e = await waitFor(`card ${prefix}`, (ev) => ev.type === 'permission.updated' && ev.request.id.startsWith(prefix) && ev.request.status === 'pending', 20000, from);
  return (e as Extract<HubEvent, { type: 'permission.updated' }>).request;
};
const activities = (taskId: string, from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'activity' && e.entry.taskId === taskId ? [e.entry.message] : []));
const rowsFor = (taskId: string) => {
  const rows = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) rows.set(entry.id, entry);
  return [...rows.values()];
};
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  send({ type: 'project.register', name: 'Pairproj', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.id === 'pairproj');

  // 1. Agree on the first review: the reviewer is the other engine, read-only,
  // visible, and the lead's synopsis folds in the second opinion.
  let mark = events.length;
  send({ type: 'task.submit', text: '/pair @pairproj coding: pair-agree tidy the loader' });
  const agreeId = await created('pair-agree');
  send({ type: 'task.watch', taskId: agreeId });
  await finished(agreeId, mark);
  await settle();
  let task = taskOf(agreeId)!;
  if (task.detail.startsWith('/pair')) fail('the /pair prefix stayed in the task');
  if (task.pair?.state !== 'agreed' || task.pair.rounds.length !== 1 || !task.pair.rounds[0]?.agree) fail(`pair not agreed in one round: ${JSON.stringify(task.pair)}`);
  if (!/^[0-9a-f]{8}$/.test(task.pair.rounds[0]?.version ?? '')) fail(`agreement names no version: ${task.pair.rounds[0]?.version}`);
  if (task.pair.reviewerModel !== 'gpt-6.1-sol') fail(`a Claude author should get a Codex reviewer, got ${task.pair.reviewerModel}`);
  if (!task.pair.reviewerSession) fail('the reviewer conversation was not kept');
  const reviewer = events.find((e) => e.type === 'agent.updated' && e.agent.taskId === agreeId && /^coding-r\d+$/.test(e.agent.id));
  if (!reviewer || reviewer.type !== 'agent.updated' || !reviewer.agent.name.startsWith('Reviewer') || reviewer.agent.modelId !== 'gpt-6.1-sol') fail('no visible reviewer on the reviewer seat');
  if (!activities(agreeId, mark).some((m) => m === 'mock: read-only review · engine codex')) fail('the review did not run read-only on Codex');
  if (!/with the second opinion/.test(task.synopsis ?? '')) fail(`the lead's synopsis missed the second opinion: ${task.synopsis}`);
  if (!rowsFor(agreeId).some((r) => r.agentId === reviewer.agent.id && r.kind === 'message' && r.text.includes('"agree":true'))) fail('the reviewer\'s verdict is not in the console');
  if (!activities(agreeId, mark).some((m) => /round 1: GPT.*agrees \(version [0-9a-f]{8}\)/.test(m))) fail('no "agrees (version …)" line');
  if (!activities(agreeId, mark).some((m) => /· pair mode$/.test(m))) fail('the routed line does not say pair mode');
  console.log('agree ok: Codex reviewer (read-only, visible, own conversation), version named, lead folds in the second opinion');

  // 2. Disagree once: the author fixes in its SAME conversation, the reviewer
  // re-checks in ITS same conversation, then agrees.
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: pair-disagree-once add the cache', pair: true });
  const onceId = await created('pair-disagree-once');
  await finished(onceId, mark);
  await settle();
  task = taskOf(onceId)!;
  const authorSession = task.session?.id;
  if (task.pair?.state !== 'agreed' || task.pair.rounds.length !== 2) fail(`expected agreement on round 2: ${JSON.stringify(task.pair)}`);
  if (task.pair.rounds[0]?.agree || task.pair.rounds[0]?.blocking[0] !== 'the loader has no tests yet') fail('round 1 should carry the blocking issue');
  if (!activities(onceId, mark).includes(`mock: resumed ${authorSession}`)) fail('the author did not fix in its own conversation');
  if (!activities(onceId, mark).includes('mock: read-only review · engine codex · resumed')) fail('the reviewer did not re-check in its own conversation');
  if (!activities(onceId, mark).some((m) => /round 1: .*found 1 blocking issue — the loader has no tests yet/.test(m))) fail('no blocking-issue line');
  console.log('disagree-once ok: blocking issue → author fixes in the same session → reviewer re-checks in its session → agreed');

  // 3. Never agree: the round cap asks; "Two more rounds" → asks again at 5;
  // "Go with it as it is" finishes with the open points on record.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair @pairproj coding: pair-never-agree rename the loader' });
  const neverId = await created('pair-never-agree rename');
  let ask = await card(`pair-${neverId}-3`, mark);
  if (ask.options?.join('|') !== 'Go with it as it is|Two more rounds' || !/still disagree after 3 rounds/.test(ask.summary ?? '')) fail(`bad pair card: ${JSON.stringify(ask)}`);
  if (taskOf(neverId)?.status !== 'awaiting_permission') fail('task not waiting on the pair card');
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 1 });
  ask = await card(`pair-${neverId}-5`, mark);
  if (taskOf(neverId)?.pair?.maxRounds !== 5) fail('"Two more rounds" did not extend the cap to 5');
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 0 });
  await finished(neverId, mark);
  task = taskOf(neverId)!;
  if (task.status !== 'done' || task.pair?.state !== 'disagreed' || task.pair.rounds.length !== 5) fail(`go-with-it did not finish as disagreed after 5: ${task.status} ${JSON.stringify(task.pair)}`);
  console.log('round cap ok: card at 3 → two more → card at 5 → go with it → done, marked disagreed');

  // 4. Never agree, stop at the card: left for the owner (paused, out of the
  // thread). A message then goes through the chair: work → author resumes,
  // a fresh 3-round budget, the card comes back; Stop at the card stops it.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair @pairproj coding: pair-never-agree split the loader' });
  const leftId = await created('pair-never-agree split');
  ask = await card(`pair-${leftId}-3`, mark);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'deny', scope: 'once' });
  await finished(leftId, mark, ['paused']);
  task = taskOf(leftId)!;
  if (task.stoppedBy !== 'owner' || !/^Left for you: the author and the reviewer still disagree/.test(task.synopsis ?? '')) fail(`not left for the owner: ${task.stoppedBy} ${task.synopsis}`);
  mark = events.length;
  send({ type: 'task.message', taskId: leftId, text: 'keep the old tests and move on' });
  await waitFor('chair relays', (e) => e.type === 'activity' && e.entry.taskId === leftId && /handing it to the author: Mock chair relays/.test(e.entry.message), 20000, mark);
  ask = await card(`pair-${leftId}-6`, mark);
  if (taskOf(leftId)?.pair?.maxRounds !== 6) fail('a continued pair task did not get a fresh 3-round budget');
  send({ type: 'task.stop', taskId: leftId });
  await finished(leftId, mark, ['paused']);
  await settle();
  if (events.slice(mark).some((e) => e.type === 'task.updated' && e.task.id === leftId && e.task.status === 'done')) fail('a task stopped at its pair card finished anyway');
  const expired = [...events].reverse().find((e) => e.type === 'permission.updated' && e.request.id === ask.id);
  if (!expired || expired.type !== 'permission.updated' || expired.request.status !== 'expired') fail('the pair card was not expired by Stop');
  console.log('leave ok: deny = left for you; a message goes via the chair to the author, fresh budget, Stop at the card stops it');

  // 5. The chair on a finished pair task: a question is answered (no new
  // run); a change goes to the author and is reviewed again.
  mark = events.length;
  send({ type: 'task.message', taskId: agreeId, text: 'did both of you check the loader?' });
  await waitFor('chair answers', (e) => e.type === 'task.transcript' && e.taskId === agreeId && e.entries.some((r) => r.role === 'lead' && r.text.startsWith('Mock chair: both models looked at it')), 20000, mark);
  await settle(800);
  if (events.slice(mark).some((e) => e.type === 'task.updated' && e.task.id === agreeId && e.task.status !== 'done')) fail('answering a question re-ran the task');
  mark = events.length;
  send({ type: 'task.message', taskId: agreeId, text: 'also add a header comment' });
  await waitFor('change re-runs', (e) => e.type === 'task.updated' && e.task.id === agreeId && e.task.status === 'in_flight', 20000, mark);
  await finished(agreeId, events.length - 1);
  task = taskOf(agreeId)!;
  if (task.pair?.rounds.length !== 2 || !task.pair.rounds[1]?.agree) fail(`the change was not reviewed again: ${JSON.stringify(task.pair?.rounds)}`);
  if (!activities(agreeId, mark).some((m) => m.startsWith('mock: resumed '))) fail('the change did not continue the author\'s conversation');
  console.log('chair ok: a question is answered by the lead, a change goes to the author and is reviewed again');

  // 6. An unreadable verdict: asked once more, then the owner decides.
  mark = events.length;
  send({ type: 'task.submit', text: '/pair @pairproj coding: pair-garbled tidy imports' });
  const garbledId = await created('pair-garbled');
  ask = await card(`pair-${garbledId}-1`, mark);
  const reviews = activities(garbledId, mark).filter((m) => m.startsWith('mock: read-only review'));
  if (reviews.length !== 2) fail(`an unreadable verdict should be asked once more (2 reviews), got ${reviews.length}`);
  if (!/no readable verdict/.test(ask.summary ?? '')) fail(`card doesn't say the verdict was unreadable: ${ask.summary}`);
  send({ type: 'permission.respond', requestId: ask.id, decision: 'approve', scope: 'once', choice: 0 });
  await finished(garbledId, mark);
  console.log('garbled ok: unreadable verdict → asked again once → straight to the owner (no blind fix round)');

  // 7. Defaults: a team's "pair by default" pairs a plain ask; /solo and
  // pair:false keep one solo; no pair by default = solo.
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: default-solo check' });
  const soloDefault = await created('default-solo');
  await finished(soloDefault, mark);
  if (taskOf(soloDefault)?.pair) fail('a plain ask was paired without pair-by-default');
  send({ type: 'models.set', overrides: { teams: { coding: { pairByDefault: true } } } });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: team-default check' });
  const teamDefault = await created('team-default');
  await finished(teamDefault, mark);
  if (taskOf(teamDefault)?.pair?.state !== 'agreed') fail('pair-by-default did not pair a plain ask');
  mark = events.length;
  send({ type: 'task.submit', text: '/solo @pairproj coding: solo-prefix check' });
  const soloPrefix = await created('solo-prefix');
  await finished(soloPrefix, mark);
  if (taskOf(soloPrefix)?.pair) fail('/solo was paired');
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: solo-flag check', pair: false });
  const soloFlag = await created('solo-flag');
  await finished(soloFlag, mark);
  if (taskOf(soloFlag)?.pair) fail('pair:false was paired');
  console.log('defaults ok: solo unless asked; team pair-by-default pairs; /solo and pair:false override');

  // 8. Reviewer seat: a Codex author gets Opus 5.5 by default; the owner's
  // reviewer choice (all reviewers < per team) wins.
  send({ type: 'models.set', overrides: { teams: { coding: { worker: { model: 'gpt-6.1-sol' } } } } });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '/pair @pairproj coding: reverse-seat check' });
  const reverseId = await created('reverse-seat');
  await finished(reverseId, mark);
  if (taskOf(reverseId)?.pair?.reviewerModel !== 'claude-opus-5-5') fail(`a Codex author should get Opus 5.5, got ${taskOf(reverseId)?.pair?.reviewerModel}`);
  if (!activities(reverseId, mark).includes('mock: read-only review · engine claude')) fail('the reverse review did not run on Claude');
  send({
    type: 'models.set',
    overrides: { reviewer: { model: 'claude-sonnet-5-5' }, teams: { coding: { reviewer: { model: 'gpt-6-luna', effort: 'low' } } } },
  });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '/pair @pairproj coding: chosen-seat check' });
  const chosenId = await created('chosen-seat');
  await finished(chosenId, mark);
  if (taskOf(chosenId)?.pair?.reviewerModel !== 'gpt-6-luna') fail(`the per-team reviewer choice lost: ${taskOf(chosenId)?.pair?.reviewerModel}`);
  if (!activities(chosenId, mark).some((m) => m === 'mock: read-only review · engine codex')) fail('the chosen reviewer did not run on its engine');
  console.log('reviewer seat ok: Codex author → Opus 5.5 by default; per-team choice beats all-reviewers');

  // 9. The master picks the mode — only from "## Pairing" rules; your
  // explicit choice wins; "none" falls back to the team's default.
  send({ type: 'models.set', overrides: { teams: {} } });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: pairrule-debate before any rules' });
  const noRules = await created('before any rules');
  await finished(noRules, mark);
  if (taskOf(noRules)?.pair) fail('the master paired without a Pairing rule');
  // A general rule mentioning pairs is not a Pairing rule.
  send({ type: 'team.rules.add', teamId: 'master', rule: 'Pair programming is great; keep tasks small.' });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: pairrule-debate general rule only' });
  const generalOnly = await created('general rule only');
  await finished(generalOnly, mark);
  if (taskOf(generalOnly)?.pair) fail('a general rule turned pairing on');
  send({ type: 'team.rules.add', teamId: 'master', rule: 'Pair-review anything touching auth (pairrule-review).', section: 'pairing' });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: pairrule-review fix the auth check' });
  const byRule = await created('fix the auth check');
  await finished(byRule, mark);
  if (taskOf(byRule)?.pair?.mode !== 'review' || taskOf(byRule)?.pair?.state !== 'agreed') fail(`the Pairing rule did not pair: ${JSON.stringify(taskOf(byRule)?.pair)}`);
  if (!activities(byRule, mark).some((m) => /· pair mode — your pairing rule$/.test(m))) fail('the routed line does not say the rule picked it');
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: pairrule-debate decide the cache design' });
  const debated = await created('decide the cache design');
  await finished(debated, mark);
  if (taskOf(debated)?.pair?.mode !== 'debate') fail(`the master's debate pick was not used: ${taskOf(debated)?.pair?.mode}`);
  mark = events.length;
  send({ type: 'task.submit', text: '/solo @pairproj coding: pairrule-review solo wins' });
  const soloWins = await created('solo wins');
  await finished(soloWins, mark);
  if (taskOf(soloWins)?.pair) fail('/solo lost to the master\'s pick');
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: nothing to pair here' });
  const none = await created('nothing to pair here');
  await finished(none, mark);
  if (taskOf(none)?.pair) fail('"none" paired anyway');
  send({ type: 'models.set', overrides: { teams: { coding: { pairByDefault: true } } } });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: team default still applies' });
  const teamDefault2 = await created('team default still applies');
  await finished(teamDefault2, mark);
  if (taskOf(teamDefault2)?.pair?.mode !== 'review') fail('"none" from the master overrode the team default');
  console.log('master picks ok: only Pairing rules turn pairing on (review / debate picked), /solo wins, "none" leaves the team default');

  // 10. Failover (opt-in): a nearly-used-up plan hands its seats to the other
  // engine; off by default; both nearly out = no change; recovery switches back.
  const setUsage = (claudePct: number, codexPct: number | null) =>
    hub.bus.publish({
      type: 'usage.updated',
      usage: {
        ...hub.bus.state.usage,
        windowPct: claudePct,
        weeklyPct: 10,
        codex: codexPct === null ? null : { plan: 'test', windowPct: null, windowResetsAt: null, weeklyPct: codexPct, weeklyResetsAt: null },
      },
    });
  const engineOfWorker = (taskId: string, from: number) =>
    activities(taskId, from).find((m) => m.startsWith('mock: engine '))?.slice('mock: engine '.length);
  send({ type: 'models.set', overrides: { teams: {} } });
  setUsage(95, 20);
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: failover-off check' });
  const offCheck = await created('failover-off check');
  await finished(offCheck, mark);
  if (engineOfWorker(offCheck, mark) !== 'claude') fail('failover acted while switched off');
  send({ type: 'models.set', overrides: { failover: true, teams: {} } });
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: failover-on check' });
  const onCheck = await created('failover-on check');
  await finished(onCheck, mark);
  if (engineOfWorker(onCheck, mark) !== 'codex') fail(`a nearly-out Claude plan did not move the worker to Codex: ${engineOfWorker(onCheck, mark)}`);
  if (!events.slice(mark).some((e) => e.type === 'activity' && /^Coding team workers: Sonnet 5 → GPT-6\.1-Sol — the Claude plan is nearly used up \(≥90%\)$/.test(e.entry.message))) {
    fail('no failover line for the coding workers');
  }
  // The pair partner of a failed-over author is then the other engine again (Opus 5.5).
  mark = events.length;
  send({ type: 'task.submit', text: '/pair @pairproj coding: failover-pair check' });
  const pairCheck = await created('failover-pair check');
  await finished(pairCheck, mark);
  if (taskOf(pairCheck)?.pair?.authorModel !== 'gpt-6.1-sol') fail(`failover pair author: ${taskOf(pairCheck)?.pair?.authorModel}`);
  setUsage(95, 95);
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: failover-both check' });
  const bothCheck = await created('failover-both check');
  await finished(bothCheck, mark);
  if (engineOfWorker(bothCheck, mark) !== 'claude') fail('both plans nearly out should leave seats where they are');
  setUsage(30, 20);
  await settle(300);
  mark = events.length;
  send({ type: 'task.submit', text: '@pairproj coding: failover-recovered check' });
  const recovered = await created('failover-recovered check');
  await finished(recovered, mark);
  if (engineOfWorker(recovered, mark) !== 'claude') fail('seats did not move back after the plan recovered');
  send({ type: 'models.set', overrides: { teams: {} } });
  console.log('failover ok: off by default; nearly-out Claude → Codex seats (announced once); both out = no change; recovery moves back');

  console.log('PAIR SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
