// Rules first, the model as the backup: what the hub now decides without a
// model call — and that every case a rule doesn't settle still goes to the
// model exactly as before.
//  - report lines (parseReportLines): STATUS / HAND-OFFS / VERDICT
//  - routing: "team:" prefix, "keywords → Team" table, team-only when the
//    project needs judgment, the model when rules don't settle it
//  - lead review skipped for short STATUS reports; long ones reviewed
//  - QA: Coding team only by default, never when nothing changed, /qa asks
//    for one, a QA rule in words goes to the model; verdict from VERDICT
//  - coordination skipped on "HAND-OFFS: none", run when hand-offs are listed
//  - the one-time routing-rules suggestion card
//   npx tsx test/rules-first.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, parseReportLines, type ClientCommand, type HubEvent, type Project, type Team, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { parseRoutingTable, qaRulesFrom, routeByRules, teamNamed, teamPrefix } from '../src/orchestrator/master.js';

const PORT = Number(process.env['RULES_SMOKE_PORT'] ?? 4659);
function fail(message: string): never {
  console.error(`RULES FIRST SMOKE FAIL: ${message}`);
  process.exit(1);
}

// --- units ------------------------------------------------------------------
{
  let lines = parseReportLines('Added the button.\n- wired to save()\n\n**STATUS:** done\nHand-offs: none');
  if (lines.status !== 'done' || lines.handoffs?.length !== 0 || lines.body !== 'Added the button.\n- wired to save()') fail(`lines 1: ${JSON.stringify(lines)}`);
  lines = parseReportLines('Could not deploy.\nSTATUS: blocked — no access to the server\nHAND-OFFS: tools: open the firewall; release: ship it');
  if (lines.status !== 'blocked' || lines.blocked !== 'no access to the server' || lines.handoffs?.join('|') !== 'tools: open the firewall|release: ship it') fail(`lines 2: ${JSON.stringify(lines)}`);
  lines = parseReportLines('Tested it.\n- `VERDICT: issues — save does nothing`\nSTATUS: done');
  if (lines.verdict !== 'issues' || lines.issues !== 'save does nothing') fail(`lines 3: ${JSON.stringify(lines)}`);
  lines = parseReportLines('All good.\nVERDICT: pass\nStatus: in progress, mostly');
  if (lines.verdict !== 'pass' || lines.status !== null || !lines.body.includes('in progress')) fail(`lines 4: ${JSON.stringify(lines)}`);
  if (parseReportLines('Just a report with no lines.').status !== null) fail('lines 5');
  console.log('report lines ok: STATUS done/blocked, HAND-OFFS none/list, VERDICT pass/issues, markdown tolerated, unknown values left alone');

  const team = (id: string, name: string): Team => ({ id, name, charter: '', allowedTools: ['read'], blockedTools: [], leadModel: 'opus', workerModel: 'sonnet', maxConcurrentWorkers: 1, quotaSharePct: 0, memoryDir: '', mcpServers: {}, createdAt: 0 }) as Team;
  const teams = [team('coding', 'Coding team'), team('art-team', 'Art team'), team('personal-assistant-team', 'Personal Assistant team'), team('qa-testing', 'QA & Testing')];
  if (teamNamed(teams, 'art')?.id !== 'art-team' || teamNamed(teams, 'Art team')?.id !== 'art-team' || teamNamed(teams, 'qa')?.id !== 'qa-testing') fail('teamNamed');
  if (teamNamed(teams, 'a') || teamNamed(teams, 'co')) fail('teamNamed matched a fragment');
  if (teamPrefix(teams, 'art: make icons')?.team.id !== 'art-team' || teamPrefix(teams, 'Note: make icons') || teamPrefix(teams, 'http://x')) fail('teamPrefix');
  const table = parseRoutingTable(
    ['[Routing] icons, sprites, blender → Art team', '[Routing] flights, hotels -> Personal Assistant team @general', '[Routing] Prefer the art team for 3D', '[Routing] gizmos → Nobody team'],
    teams,
  );
  if (table.length !== 2 || table[1]!.projectRef !== 'general' || table[0]!.keywords.join('|') !== 'icons|sprites|blender') fail(`table: ${JSON.stringify(table)}`);
  const project = (id: string): Project => ({ id, name: id, description: '', workspaceDir: `C:\\${id}`, quotaTokens: 1, usedTokens: 0, alerted75: false }) as Project;
  const [home, other, general] = [project('home'), project('other'), project('general')];
  const base = { teams, projects: [home, other, general], generalProjectId: 'general', pinned: undefined, named: [] as Project[], threadProject: home, table, pairingRules: [] as string[] };
  const full = routeByRules({ ...base, text: 'book flights to Tokyo' });
  if (!full || !('teamId' in full) || full.teamId !== 'personal-assistant-team' || full.projectId !== 'general' || full.projectBasis !== 'general' || full.tokens !== 0) fail(`rule @project: ${JSON.stringify(full)}`);
  const pinned = routeByRules({ ...base, text: 'art: new icons', pinned: other });
  if (!pinned || !('teamId' in pinned) || pinned.projectId !== 'other' || pinned.title !== 'new icons') fail(`pinned: ${JSON.stringify(pinned)}`);
  const teamOnly = routeByRules({ ...base, text: 'make sprites for the shop' });
  if (!teamOnly || 'teamId' in teamOnly || teamOnly.team.id !== 'art-team') fail(`thread needs judgment: ${JSON.stringify(teamOnly)}`);
  if (routeByRules({ ...base, text: 'icons and flights' })) fail('two teams matched but the rules routed it');
  if (routeByRules({ ...base, text: 'fix the login page' })) fail('no match but the rules routed it');
  if (routeByRules({ ...base, text: 'art: icons', pairingRules: ['[Pairing] debate designs'] })) fail('pairing rules to apply but the rules routed it');
  if (routeByRules({ ...base, text: 'book hotels in other', named: [other] })) fail('the rule @general conflicts with a named project but the rules routed it');
  const qa = qaRulesFrom(['[QA] Coding team', '[QA] Art team, QA & Testing', '[QA] anything touching payments'], teams);
  if ([...qa.teamIds].sort().join('|') !== 'art-team|coding|qa-testing' || qa.freeText.join('|') !== 'anything touching payments') fail(`qa rules: ${JSON.stringify([...qa.teamIds])} ${qa.freeText}`);
  console.log('routing units ok: strict team names, team: prefix, table with @project, full / team-only / model, QA rules by team + in words');
}

// --- the hub --------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-rules-'));
const projectDir = join(sandbox, 'Ruleproj');
mkdirSync(projectDir, { recursive: true });
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-rules-claude-')),
  claudeConfigPath: join(sandbox, 'claude.json'),
  accessGrants: [],
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
  detectApps: () => [],
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
send({ type: 'hello', client: 'cli', name: 'rules-first-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
const rows = (taskId: string): TranscriptEntry[] => {
  const byId = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) byId.set(entry.id, entry);
  return [...byId.values()];
};
const said = (taskId: string, pattern: RegExp) => rows(taskId).some((row) => pattern.test(row.text));
const activity = (from: number, taskId: string | null = null) =>
  events.slice(from).flatMap((e) => (e.type === 'activity' && (taskId === null || e.entry.taskId === taskId) ? [e.entry.message] : []));
// Submit, watch the ask, wait for it (and its steps) to settle.
const ask = async (text: string, marker: string, done: (id: string, from: number) => Promise<unknown>) => {
  const from = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`created ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && !e.task.rootTaskId, 30000, from);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  await done(id, from);
  await settle();
  const routed = activity(from, id).find((line) => line.startsWith('routed ')) ?? '';
  return { id, from, routed };
};
const finished = (id: string, from: number, status: string[] = ['done']) =>
  waitFor(`${id} finished`, (e) => e.type === 'task.updated' && e.task.id === id && status.includes(e.task.status), 30000, from);
const qaVerdict = (from: number) => waitFor('QA verdict', (e) => e.type === 'activity' && e.entry.message.startsWith('QA verdict: pass'), 30000, from);

try {
  const snapshot = await waitFor('snapshot', (e) => e.type === 'snapshot');
  const masterRules = snapshot.type === 'snapshot' ? snapshot.snapshot.info.masterRules ?? '' : '';
  if (!/## QA\s*\n- Coding team/.test(masterRules)) fail(`the master's rules have no default "## QA - Coding team": ${masterRules.slice(-300)}`);
  send({ type: 'project.register', name: 'Ruleproj', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === projectDir);
  console.log('default ok: "## QA" with the Coding team is in the master\'s rules');

  // 1. "design:" + @pin → routed by rule, short STATUS report taken as written,
  //    no QA (design isn't under ## QA), "HAND-OFFS: none" → no coordination call.
  let run = await ask('@ruleproj design: lines-done draw a logo', 'draw a logo', (id, from) => finished(id, from));
  if (!/you named the team, no routing call/.test(run.routed)) fail(`design not routed by rule: ${run.routed}`);
  if (!said(run.id, /report taken as written \(short, STATUS: done\)/)) fail('short STATUS report still went to the lead review');
  if (!said(run.id, /no QA pass — Design team isn't under "## QA"/)) fail('design work got a QA pass');
  if (!said(run.id, /no hand-offs listed — no coordination call/)) fail('coordination ran despite HAND-OFFS: none');
  console.log('design ok: routed by "design:", report as written, no QA, no coordination call');

  // 2. Coding work that changed files → QA (your QA rules), verdict read from VERDICT.
  run = await ask('@ruleproj coding: lines-done add a save button', 'add a save button', async (id, from) => {
    await finished(id, from);
    await qaVerdict(from);
  });
  if (!activity(run.from).some((line) => /QA follow-up queued for: .*add a save button \(your QA rules\)/.test(line))) fail(`coding QA not queued by the rules: ${activity(run.from).join(' | ')}`);
  if (!said(run.id, /QA verdict read from the report \(pass\)/)) fail('the QA verdict went to the model');
  console.log('coding ok: QA by the default rule, verdict read from the report');

  // 3. Coding work that changed nothing → no QA.
  run = await ask('@ruleproj coding: lines-done no-changes check the build', 'check the build', (id, from) => finished(id, from));
  if (!said(run.id, /no QA pass — nothing was changed/)) fail('unchanged work got a QA pass');
  console.log('no changes ok: no QA pass');

  // 4. QA finds issues (VERDICT: issues) → fix round in the same task → re-QA passes.
  run = await ask('@ruleproj coding: lines-done lines-qa-issues fix the save flow', 'fix the save flow', async (id, from) => {
    await waitFor('fix round', (e) => e.type === 'activity' && /leads are meeting over QA findings/.test(e.entry.message), 30000, from);
    await qaVerdict(from);
  });
  if (!said(run.id, /QA verdict read from the report \(issues\)/)) fail('the issues verdict went to the model');
  console.log('QA issues ok: read from VERDICT, fix round, re-check passes');

  // 5. /qa on design → QA because you asked.
  run = await ask('/qa @ruleproj design: lines-done style the menu', 'style the menu', async (id, from) => {
    await finished(id, from);
    await qaVerdict(from);
  });
  if (!/QA asked/.test(run.routed) || !activity(run.from).some((line) => /QA follow-up queued for: .*style the menu \(you asked for QA\)/.test(line))) fail(`/qa ignored: ${activity(run.from).join(' | ')}`);
  console.log('/qa ok: a QA pass for a team not under ## QA');

  // 6. STATUS: blocked → stuck without a review call; a long report → the lead reviews.
  run = await ask('@ruleproj coding: lines-done lines-blocked deploy the build', 'deploy the build', (id, from) => finished(id, from, ['failed']));
  const blocked = Object.values(events).reverse().find((e) => e.type === 'task.updated' && e.task.id === run.id);
  if (blocked?.type !== 'task.updated' || !blocked.task.synopsis?.startsWith('Stuck — mock: no access to the build server')) fail(`blocked: ${JSON.stringify(blocked)}`);
  run = await ask('@ruleproj coding: lines-done lines-long no-changes write up the audit', 'write up the audit', (id, from) => finished(id, from));
  if (said(run.id, /report taken as written/)) fail('a long report skipped the lead review');
  console.log('review ok: blocked → stuck from the STATUS line; a long report gets the lead review');

  // 7. Hand-offs listed → the coordination model runs (no skip row).
  run = await ask('@ruleproj coding: lines-done lines-handoff no-changes plan the icons', 'plan the icons', (id, from) => finished(id, from));
  if (said(run.id, /no coordination call/)) fail('listed hand-offs skipped coordination');
  console.log('hand-offs ok: listed hand-offs still go to the coordination pass');

  // 8. Routing table: one team matches → that team; two teams → the master routes.
  send({ type: 'team.rules.add', teamId: 'master', section: 'routing', rule: 'wireframes, mockups → Design team' });
  send({ type: 'team.rules.add', teamId: 'master', section: 'routing', rule: 'buttons → Coding team' });
  await waitFor('table', (e) => e.type === 'hub.updated' && /buttons → Coding team/.test(e.info.masterRules ?? ''));
  run = await ask('@ruleproj lines-done no-changes sketch wireframes for the shop', 'sketch wireframes', (id, from) => finished(id, from));
  if (!/your routing rule "wireframes, mockups → Design team", no routing call/.test(run.routed) || !/→ Design team/.test(run.routed)) fail(`table route: ${run.routed}`);
  run = await ask('@ruleproj lines-done no-changes wireframes and buttons together', 'wireframes and buttons', (id, from) => finished(id, from));
  if (/routing rule|no routing call/.test(run.routed)) fail(`two teams matched but a rule routed it: ${run.routed}`);
  console.log('routing table ok: one team → by rule; two teams → the master');

  // 9. No @pin, a thread to maybe continue → the rule fixes the team, the master the project.
  run = await ask('coding: lines-done no-changes tidy the logs', 'tidy the logs', (id, from) => finished(id, from));
  if (!/team: you named the team, project by the master/.test(run.routed) || !/→ Coding team · Ruleproj/.test(run.routed)) fail(`team-only route: ${run.routed}`);
  console.log('team-only ok: the thread is never assumed — the master still picks the project');

  // 10. A QA rule in words → the checks model decides.
  send({ type: 'team.rules.add', teamId: 'master', section: 'qa', rule: 'anything that touches the shop config' });
  await waitFor('qa words', (e) => e.type === 'hub.updated' && /touches the shop config/.test(e.info.masterRules ?? ''));
  run = await ask('@ruleproj tools: lines-done qa-yes update the shop config', 'update the shop config', async (id, from) => {
    await finished(id, from);
    await qaVerdict(from);
  });
  if (!activity(run.from).some((line) => /QA follow-up queued for: .*update the shop config \(mock: QA rule check\)/.test(line))) fail(`QA rule in words not judged: ${activity(run.from).join(' | ')}`);
  console.log('QA rule in words ok: judged by the checks model');

  // 11. The one-time tool: suggestions from history → a card → added to ## Routing.
  let from = events.length;
  send({ type: 'rules.suggest' });
  const card = await waitFor('suggestion card', (e) => e.type === 'permission.updated' && e.request.id.startsWith('rules-suggest-') && e.request.status === 'pending', 30000, from);
  const request = card.type === 'permission.updated' ? card.request : fail('no card');
  // the one already in the table and the one naming no team are dropped
  if (request.command !== '- storyboards, mockups → Design team') fail(`suggested: ${request.command}`);
  from = events.length;
  send({ type: 'permission.respond', requestId: request.id, decision: 'approve', scope: 'once' });
  await waitFor('added', (e) => e.type === 'activity' && e.entry.message.startsWith('routing rules added:'), 15000, from);
  const rulesNow = [...events].reverse().find((e) => e.type === 'hub.updated');
  if (rulesNow?.type !== 'hub.updated' || !/## Routing[\s\S]*- storyboards, mockups → Design team/.test(rulesNow.info.masterRules ?? '')) fail('approved rule not under ## Routing');
  console.log('suggest ok: drafted from history, duplicates and unknown teams dropped, added under ## Routing on approve');

  console.log('RULES FIRST SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
