// Team notes: what a worker had to work out goes into its team's MEMORY.md
// (its LEARNED line), and every later worker on the team gets the newest in
// its brief.
//  - units: LEARNED lines (none / several / markdown), cleanNote (one line,
//    capped at a word, key-like runs redacted), appendMemory (dated, repeats
//    skipped, the owner's own lines kept, oldest dated notes dropped past the
//    cap), readMemory (the owner's lines + the newest notes within budget)
//  - hub: a LEARNED line lands in the notes (team.updated + console line) and
//    not in the synopsis; the next worker's brief carries it; the same lesson
//    again isn't added twice; "LEARNED: none" adds nothing; the lead's note
//    stands in only when there's no LEARNED line; team.notes.set saves edits
//   npx tsx test/team-notes.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, parseReportLines, type ClientCommand, type HubEvent, type Team } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { TeamRegistry, cleanNote } from '../src/orchestrator/teams.js';

const PORT = Number(process.env['NOTES_SMOKE_PORT'] ?? 4663);
function fail(message: string): never {
  console.error(`TEAM NOTES SMOKE FAIL: ${message}`);
  process.exit(1);
}

// --- units ------------------------------------------------------------------
{
  let lines = parseReportLines('Rendered it.\nSTATUS: done\nHAND-OFFS: none\n**LEARNED:** none');
  if (lines.learned?.length !== 0 || lines.body !== 'Rendered it.') fail(`learned none: ${JSON.stringify(lines)}`);
  lines = parseReportLines('Rendered it.\n- `LEARNED: black render → add a camera`\nLearned: bpy needs the main thread → use a timer\nSTATUS: done');
  if (lines.learned?.join('|') !== 'black render → add a camera|bpy needs the main thread → use a timer' || lines.body !== 'Rendered it.') fail(`learned two: ${JSON.stringify(lines)}`);
  if (parseReportLines('No lines here.').learned !== null) fail('no LEARNED line should be null');

  const key = 'sk-proj-abc123DEF456ghi789JKL012mno345PQR';
  if (cleanNote(`use the key ${key} for uploads`).includes('abc123')) fail('a key-like run was kept');
  if (!cleanNote('see D:/PersonalWork/MobileAIConnector/packages/hub/apps/blender_bridge.py first').includes('blender_bridge.py')) fail('a path was redacted');
  const long = cleanNote(`word ${'longish '.repeat(80)}`);
  if (long.length > 401 || !long.endsWith('…') || / longi…$/.test(long)) fail(`cap: ${long.length} ${long.slice(-20)}`);
  if (cleanNote('  - multi\n  line   note about something  ') !== 'multi line note about something') fail('one line');
  if (cleanNote('ok') !== '') fail('too short to be a lesson');

  const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-notes-unit-'));
  const registry = new TeamRegistry(dataDir);
  registry.init();
  const team = registry.all()[0]!;
  registry.setNotes(team.id, `# ${team.name} — notes\nAlways say which Blender version you used.\n- my own undated note about exports`);
  if (registry.appendMemory(team.id, 'Blender -b render came out black → add a camera first') === null) fail('first note not saved');
  if (registry.appendMemory(team.id, 'blender -b render came out BLACK → add a camera first.') !== null) fail('a repeat was saved');
  for (let i = 0; i < 70; i++) registry.appendMemory(team.id, `lesson number ${i} about a different quirk of the tools`);
  const file = readFileSync(join(team.memoryDir, 'MEMORY.md'), 'utf8');
  const bullets = file.split('\n').filter((line) => line.startsWith('- '));
  if (bullets.length !== 60) fail(`kept ${bullets.length} notes, want 60`);
  if (!file.includes('Always say which Blender version') || !file.includes('my own undated note')) fail("the owner's own lines were dropped");
  if (file.includes('render came out black') || file.includes('lesson number 0 ') || !file.includes('lesson number 69 ')) fail('the oldest dated notes should go first');
  const brief = registry.readMemory(team.id);
  if (!brief.startsWith('Always say which Blender version') || !brief.includes('lesson number 69 ') || brief.includes('#')) fail(`brief: ${brief.slice(0, 200)}`);
  for (let i = 0; i < 60; i++) registry.appendMemory(team.id, `a much longer lesson ${i} ${'that keeps going about one quirk '.repeat(10)}`);
  const capped = registry.readMemory(team.id);
  if (capped.length > 6000 || !capped.includes('a much longer lesson 59 ') || capped.includes('a much longer lesson 0 ')) fail(`budget: ${capped.length}`);
  if (registry.withRules(team).notes !== readFileSync(join(team.memoryDir, 'MEMORY.md'), 'utf8')) fail('the record does not carry the notes');
  console.log('units ok: LEARNED lines, cleanNote (redact, cap, one line), dated append, repeats skipped, owner lines kept, oldest dropped at 60, brief = owner lines + newest within budget');
}

// --- the hub --------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-notes-'));
const projectDir = join(sandbox, 'Notesproj');
mkdirSync(projectDir, { recursive: true });
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-notes-claude-')),
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
send({ type: 'hello', client: 'cli', name: 'team-notes-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
const designNotes = (): string => {
  const updates = events.flatMap((e) => (e.type === 'team.updated' && e.team.id === 'design' ? [e.team] : []));
  const snapshot = events.find((e) => e.type === 'snapshot');
  const initial = snapshot?.type === 'snapshot' ? (Object.values(snapshot.snapshot.teams) as Team[]).find((t) => t.id === 'design') : undefined;
  return (updates.at(-1) ?? initial)?.notes ?? '';
};
const noteCount = () => designNotes().split('\n').filter((line) => line.startsWith('- ')).length;
const run = async (text: string, marker: string) => {
  const from = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`created ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && !e.task.rootTaskId, 30000, from);
  const id = created.type === 'task.updated' ? created.task.id : '';
  const done = await waitFor(`${marker} done`, (e) => e.type === 'task.updated' && e.task.id === id && e.task.status === 'done', 30000, from);
  await settle();
  const lines = events.slice(from).flatMap((e) => (e.type === 'activity' && e.entry.taskId === id ? [e.entry.message] : []));
  return { id, synopsis: done.type === 'task.updated' ? done.task.synopsis ?? '' : '', lines };
};

try {
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Notesproj', workspaceDir: projectDir });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === projectDir);
  const before = noteCount();

  // 1. A LEARNED line → the team's notes, a console line, not the synopsis.
  let result = await run('@notesproj design: lines-done learned-lesson draw a logo', 'draw a logo');
  if (!/Blender -b render came out black/.test(designNotes())) fail(`the lesson is not in the notes: ${designNotes()}`);
  if (!result.lines.some((line) => line.startsWith('noted for the team: Blender -b render'))) fail(`no "noted for the team" line: ${result.lines.join(' / ')}`);
  if (/LEARNED/.test(result.synopsis)) fail(`the LEARNED line is in the synopsis: ${result.synopsis}`);
  if (noteCount() !== before + 1) fail(`want ${before + 1} notes, got ${noteCount()}`);
  console.log('1 ok: a LEARNED line lands in the team notes (and the console), not in the synopsis');

  // 2. The next worker's brief carries it; the same lesson isn't added twice.
  result = await run('@notesproj design: lines-done learned-lesson notes-check:camera draw a banner', 'draw a banner');
  if (!/notes-check camera: yes/.test(result.synopsis)) fail(`the brief did not carry the note: ${result.synopsis}`);
  if (noteCount() !== before + 1) fail(`a repeated lesson was added: ${noteCount()}`);
  console.log("2 ok: the next worker's brief carries the note; a repeat isn't added");

  // 3. "LEARNED: none" adds nothing; with a LEARNED line the lead's note is not
  //    added (a long report gets the lead review; "remember" makes the mock
  //    lead write a note); without one, the lead's note stands in.
  await run('@notesproj design: lines-done learned-none draw a badge', 'draw a badge');
  if (noteCount() !== before + 1) fail(`"LEARNED: none" added a note: ${noteCount()}`);
  await run('@notesproj design: lines-long learned-other remember draw a poster', 'draw a poster');
  if (!/Roblox Studio upload stalls/.test(designNotes()) || /Mock lesson: remember this/.test(designNotes())) fail(`worker's line should win over the lead's: ${designNotes()}`);
  await run('@notesproj design: lines-long remember draw a flyer', 'draw a flyer');
  if (!/Mock lesson: remember this/.test(designNotes())) fail(`the lead's note did not stand in: ${designNotes()}`);
  console.log("3 ok: \"none\" adds nothing; the worker's LEARNED wins over the lead's note, which stands in when there's no line");

  // 4. The owner edits the notes from the Teams page.
  const edited = '# Design team — notes\n- 2026-01-01: an owner-curated note about logos';
  send({ type: 'team.notes.set', teamId: 'design', markdown: edited });
  await waitFor('notes saved', (e) => e.type === 'team.updated' && e.team.id === 'design' && e.team.notes === `${edited}\n`);
  console.log('4 ok: team.notes.set saves the edit and republishes the team');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
console.log('TEAM NOTES SMOKE PASS');
process.exit(0);
