// The full-access folder (Settings > Hub, access "full"; D:\Work\Bots on the
// owner's PC): workers delete and rebuild there without a card, and only
// there. Plus the two false "writes outside this project" cards it came with:
// the program a command RUNS isn't a write target, and a heredoc's script
// body isn't shell words.
//  - policy units: deletes inside (full paths, after a cd in, piped from it,
//    git -C into a repo there) run; anything unclear still asks
//  - hub: a "full" grant is validated (not a project, not a root, not the
//    data dir), joins every worker's scope, is named in the brief with the
//    scratch-space guidance, and is never offered as a project folder
//   npx tsx test/bots-folder.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { evaluatePermission, type WorkspaceScope } from '../src/orchestrator/policy.js';

const PORT = Number(process.env['BOTS_SMOKE_PORT'] ?? 4667);
function fail(message: string): never {
  console.error(`BOTS FOLDER SMOKE FAIL: ${message}`);
  process.exit(1);
}

// --- policy units -------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'agent-hq-bots-'));
const bots = join(root, 'Bots');
const project = join(root, 'Heat');
mkdirSync(join(bots, 'art', 'anim', 'frames'), { recursive: true });
mkdirSync(join(project, 'anims'), { recursive: true });
// A junction inside Bots that points back into the project can't be used to delete there.
try {
  symlinkSync(project, join(bots, 'sneaky'), 'junction');
} catch {
  // no junctions here — that case is skipped
}
const B = bots.replace(/\\/g, '/');
const P = project.replace(/\\/g, '/');
const msys = (path: string) => path.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
const scope: WorkspaceScope = { cwd: project, extraDirs: [bots], freeDirs: [bots] };
const noFree: WorkspaceScope = { cwd: project, extraDirs: [bots] };
const verdict = (command: string, s = scope) => evaluatePermission('Bash', command, 'auto', s);
const silent: string[] = [
  `rm -rf ${B}/art/anim/frames`,
  `rm -f "${B}/art/anim/frames/getting_up_*.png"; echo cleared`,
  `rm -rf ${msys(B)}/art/anim/frames/*`,
  `cd "${B}/art/anim" && rm -f ./*.blend1 && rm -rf ./__pycache__ && ls`,
  `cd ${msys(B)}/art/anim && rm -f *.blend1`,
  `Remove-Item -Recurse -Force "${bots}\\art\\anim\\frames"`,
  `Remove-Item -LiteralPath ${bots}\\art\\anim\\old.blend -ErrorAction SilentlyContinue`,
  `Get-ChildItem ${bots}\\art\\anim -Recurse -Filter *.blend1 | Remove-Item -Force`,
  `git -C ${B}/art/scratch-repo reset --hard HEAD~1`,
  `cd ${B}/art/scratch-repo && git clean -fdx`,
  // the old false alarms: running a program with a redirect, a python heredoc
  `cd ${P} && "/c/Users/me/AppData/Local/Programs/Python/Python312/python" tools/check.py > ${B}/art/out.txt`,
  `cd ${P} && python - <<'EOF'\nimport sys\nsys.path.insert(0, "x")\nopen("anims/a.txt","w").write("\\n")\nEOF`,
  'Get-ChildItem | Format-Table Name',
];
for (const command of silent) {
  const result = verdict(command);
  if (result.decision !== 'allow') fail(`should run without a card: \`${command}\` → ${JSON.stringify(result)}`);
}
const asks: [string, string][] = [
  [`rm -rf ${P}/anims`, 'destructive'], // the project
  [`rm -f *.blend1`, 'destructive'], // relative to what? no cd into Bots
  [`cd ${B}/art && rm -rf ../../Heat/anims`, 'destructive'], // climbs out
  [`rm -rf ${B}`, 'destructive'], // the folder itself
  [`rm -rf ${B}/art/x ${P}/anims`, 'destructive'], // one target outside
  [`rm -rf $DIR`, 'destructive'], // a variable
  [`Remove-Item -Recurse -Force ${project}\\anims`, 'destructive'], // switches before a project path
  [`Get-ChildItem ${project}\\anims | Remove-Item`, 'destructive'], // piped from the project
  [`rm -rf ${B}/art/x; Format-Volume -DriveLetter D`, 'destructive'], // something else destructive alongside
  [`git reset --hard`, 'destructive'], // the project's repo
  [`git -C ${B}/art/repo push --force`, 'publishes / pushes'],
  [`powershell -Command "Remove-Item -Recurse ${bots}\\art"`, 'destructive'], // a shell inside a shell
  [`bash <<'EOF'\nrm -rf ${P}/anims\nEOF`, 'destructive'], // a heredoc fed to a shell is commands
  [`cmd /c rd /s /q ${project}\\anims`, 'destructive'],
  [`rm -rf ${B}/art/anim/frames`, 'destructive'], // ...and nothing is free without the grant
];
for (const [command, flag] of asks) {
  const result = verdict(command, command === asks.at(-1)![0] ? noFree : scope);
  if (result.decision !== 'ask' || !result.flags.includes(flag)) fail(`should ask ("${flag}"): \`${command}\` → ${JSON.stringify(result)}`);
}
try {
  const result = verdict(`rm -rf ${B}/sneaky/anims`);
  if (result.decision !== 'ask') fail(`a junction from Bots into the project was used to delete there: ${JSON.stringify(result)}`);
} catch {
  // no junction made
}
const stray = verdict(`cd ${P} && "C:/Tools/thing.exe" build > D:/Elsewhere/out.txt`, noFree);
if (stray.decision !== 'ask' || !stray.flags.some((flag) => flag.startsWith('writes outside this project (D:\\Elsewhere'))) fail(`a real stray write went silent: ${JSON.stringify(stray)}`);
console.log(`policy ok: ${silent.length} deletes/runs in Bots silent (full paths, cd in, piped, git -C, program + heredoc false alarms gone), ${asks.length} unclear ones still ask`);

// --- the hub --------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-bots-hub-'));
const workRoot = join(sandbox, 'Work');
const hubBots = join(workRoot, 'Bots');
const proj = join(workRoot, 'Game');
mkdirSync(hubBots, { recursive: true });
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, 'package.json'), '{}');
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-bots-claude-')),
  claudeConfigPath: join(sandbox, 'claude.json'),
  accessGrants: [],
  workspaceRoots: [{ key: 'work', path: workRoot, label: 'work' }],
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
send({ type: 'hello', client: 'cli', name: 'bots-folder-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const activitySince = (from: number) => events.slice(from).flatMap((e) => (e.type === 'activity' ? [e.entry.message] : []));
const grantsNow = () => {
  const info = events.filter((e) => e.type === 'hub.updated' || e.type === 'snapshot').at(-1);
  return info?.type === 'hub.updated' ? info.info.accessGrants ?? [] : info?.type === 'snapshot' ? info.snapshot.info.accessGrants ?? [] : [];
};

try {
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Game', workspaceDir: proj });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === proj);

  // Refused for full access: a project, a folder holding one, a workspace root.
  let from = events.length;
  send({ type: 'access.set', grants: [{ path: proj, access: 'full' }, { path: workRoot, access: 'full' }, { path: hubBots, access: 'full' }] });
  await waitFor('grants', (e) => e.type === 'hub.updated' && (e.info.accessGrants ?? []).length > 0, 10000, from);
  const refused = activitySince(from).filter((line) => line.startsWith('folder access: not added'));
  if (refused.length !== 2 || !refused.some((line) => line.includes(proj)) || !refused.some((line) => line.includes(workRoot))) fail(`refusals: ${refused.join(' / ')}`);
  if (JSON.stringify(grantsNow()) !== JSON.stringify([{ path: hubBots, access: 'full' }])) fail(`grants: ${JSON.stringify(grantsNow())}`);
  console.log('grants ok: full access refused for a project, a folder holding projects, a workspace root; Bots accepted');

  // The brief names it with the guidance; a worker's deletes there need no card.
  from = events.length;
  send({ type: 'task.submit', text: '@game design: lines-done brief-echo draw a logo' });
  const created = await waitFor('task', (e) => e.type === 'task.updated' && e.task.detail.includes('draw a logo') && !e.task.rootTaskId, 30000, from);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  const done = await waitFor('done', (e) => e.type === 'task.updated' && e.task.id === id && e.task.status === 'done', 30000, from);
  void done;
  await new Promise((resolve) => setTimeout(resolve, 800));
  const brief = events
    .slice(from)
    .flatMap((e) => (e.type === 'task.transcript' && e.taskId === id ? e.entries : []))
    .map((row) => row.text)
    .find((text) => text.includes('BRIEF:')) ?? '';
  if (!brief.includes(`full access: ${hubBots}`) || !/destructive or churny/i.test(brief) || !brief.includes(join(hubBots, '<team>'))) fail(`brief: ${brief.slice(0, 600)}`);
  console.log('brief ok: the full-access folder is named with the scratch-space guidance');

  // Never offered as a project folder (it sits under a workspace root).
  from = events.length;
  send({ type: 'task.submit', text: '@bots design: draw a badge' });
  const failed = await waitFor('pin', (e) => e.type === 'task.updated' && e.task.detail.includes('draw a badge') && ['failed', 'paused'].includes(e.task.status), 30000, from);
  if (failed.type === 'task.updated' && /Bots \(new\)/.test(JSON.stringify(events.slice(from)))) fail('Bots was offered as a new project folder');
  console.log('discovery ok: the Bots folder is not offered as a project');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
console.log('BOTS FOLDER SMOKE PASS');
process.exit(0);
