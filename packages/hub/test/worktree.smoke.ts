// The bots' worktree + each task's Roblox Studio.
//  - policy units: in the worktree, deletes/resets/project installs run (with
//    a checkpoint first); git that reaches the owner's branches, `clean -x`,
//    .git, global installs, writes into the owner's checkout and a command
//    naming another Studio still ask
//  - hub: a git project's workers run in a worktree on agent-hq/<base> (made
//    on first need, ignored secrets/packages copied in), the owner's folder
//    and branch untouched; the run is committed; the owner's newer commits are
//    taken in before the next run; Studio calls only reach the task's window
//    (none assigned → a card); merge fast-forwards the owner's branch and
//    removes the worktree; a conflict is refused and discard throws it away
//   npx tsx test/worktree.smoke.ts   (mock engine, no usage)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type Project } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { evaluatePermission, type WorkspaceScope } from '../src/orchestrator/policy.js';

const PORT = Number(process.env['WORKTREE_SMOKE_PORT'] ?? 4671);
function fail(message: string): never {
  console.error(`WORKTREE SMOKE FAIL: ${message}`);
  process.exit(1);
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// --- policy units -------------------------------------------------------------
{
  const base = mkdtempSync(join(tmpdir(), 'agent-hq-wt-policy-'));
  const tree = join(base, 'worktrees', 'game');
  const owner = join(base, 'Game');
  mkdirSync(tree, { recursive: true });
  mkdirSync(owner, { recursive: true });
  const O = owner.replace(/\\/g, '/');
  const scope: WorkspaceScope = { cwd: tree, extraDirs: [], worktree: true, studio: 'Pranav2_Workspace' };
  const plain: WorkspaceScope = { cwd: owner, extraDirs: [] };
  const verdict = (command: string, s = scope) => evaluatePermission('Bash', command, 'auto', s);
  const silent: [string, boolean][] = [
    ['rm -f anims/*.blend1', true],
    ['rm -rf build && npm run build', true],
    ['git reset --hard HEAD~1', true],
    ['git clean -fd', true],
    ['Remove-Item -Recurse -Force dist', true],
    ['npm install three', true],
    ['pnpm add -D vitest', true],
    ['git checkout -- src/a.ts', false],
    ['git add -A && git commit -m "wip"', false],
    ['git merge main', false],
    ['python tools/studio_sync.py --studio "Pranav2_Workspace"', false],
    ['python D:/Work/Bots/tools/studio/studio_run.py Edit -e "return 1" --studio pranav2_workspace', false],
  ];
  for (const [command, checkpoint] of silent) {
    const result = verdict(command);
    if (result.decision !== 'allow') fail(`should run in the worktree: \`${command}\` → ${JSON.stringify(result)}`);
    if (!!result.checkpoint !== checkpoint) fail(`checkpoint ${checkpoint ? 'expected' : 'not expected'}: \`${command}\``);
  }
  const asks: [string, string][] = [
    ['git clean -fdx', 'destructive'],
    ['rm -rf .git', 'destructive'],
    ['rm -rf .', 'destructive'],
    ['git checkout main', 'switches the worktree off its branch'],
    ['git switch -c other', 'switches the worktree off its branch'],
    ['git branch -D NPC', 'moves or deletes a branch'],
    ['git push origin agent-hq/main', 'publishes / pushes'],
    ['git stash drop', 'deletes stashed work (the stash is shared with your checkout)'],
    ['git config user.name bot', "changes the repo's git settings"],
    ['git fetch origin main:main', 'updates one of your branches'],
    ['git worktree remove ../x', 'changes the repo outside this worktree'],
    ['git gc --prune=now', 'erases history'],
    ['npm install -g typescript', 'installs packages'],
    ['npm exec cowsay hi', 'installs packages'],
    [`rm -rf ${O}/anims`, 'destructive'],
    [`echo x > ${O}/notes.txt`, `writes outside this project (${join(owner, 'notes.txt')})`],
    ['python tools/studio_sync.py --studio Heat', 'drives another Roblox Studio ("Heat"; this task\'s is "Pranav2_Workspace")'],
  ];
  for (const [command, flag] of asks) {
    const result = verdict(command);
    if (result.decision !== 'ask' || !result.flags.includes(flag)) fail(`should ask ("${flag}"): \`${command}\` → ${JSON.stringify(result)}`);
  }
  const unassigned = verdict('python tools/studio_push.py --studio Heat', { ...scope, studio: null });
  if (unassigned.decision !== 'ask' || !unassigned.flags.some((flag) => flag.includes('no Studio is assigned'))) fail(`no-Studio command: ${JSON.stringify(unassigned)}`);
  for (const command of ['rm -f anims/*.blend1', 'npm install three']) {
    if (verdict(command, plain).decision !== 'ask') fail(`outside a worktree \`${command}\` must still ask`);
  }
  console.log(`policy ok: ${silent.length} worktree commands run (checkpoints where destructive), ${asks.length + 1} that reach past it still ask, the owner's folder keeps its cards`);
}

// --- the hub --------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-wt-hub-'));
const workRoot = join(sandbox, 'Work');
const proj = join(workRoot, 'Game');
const worktrees = join(sandbox, 'worktrees');
mkdirSync(join(proj, 'Packages'), { recursive: true });
git(proj, 'init', '-q', '-b', 'main');
git(proj, 'config', 'user.name', 'Owner');
git(proj, 'config', 'user.email', 'owner@example.com');
writeFileSync(join(proj, '.gitignore'), 'secrets.env\nPackages/\n');
writeFileSync(join(proj, 'old.txt'), 'old\n');
writeFileSync(join(proj, 'readme.md'), '# game\n');
git(proj, 'add', '-A');
git(proj, 'commit', '-q', '-m', 'start');
writeFileSync(join(proj, 'secrets.env'), 'TOKEN=abc\n');
writeFileSync(join(proj, 'Packages', 'lib.lua'), 'return {}\n');

const studios = [
  { id: 's-owner', name: 'Heat (placeId: 1)' },
  { id: 's-bot', name: 'Pranav2_Workspace (placeId: 2)' },
];
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-wt-claude-')),
  claudeConfigPath: join(sandbox, 'claude.json'),
  accessGrants: [],
  workspaceRoots: [{ key: 'work', path: workRoot, label: 'work' }],
  detectApps: () => [],
  worktreesDir: worktrees,
  studios: async () => studios,
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
send({ type: 'hello', client: 'cli', name: 'worktree-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const activitySince = (from: number) => events.slice(from).flatMap((e) => (e.type === 'activity' ? [e.entry.message] : []));
const projectNow = (): Project | undefined =>
  events.flatMap((e) => (e.type === 'project.updated' && e.project.workspaceDir === proj ? [e.project] : [])).at(-1);
// Submit an ask and wait for it to finish (or park on a card).
async function ask(text: string, until: 'done' | 'card' = 'done') {
  const from = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`task: ${text}`, (e) => e.type === 'task.updated' && e.task.ownerAsk !== undefined && !!e.task.ownerAsk && text.includes(e.task.ownerAsk.slice(0, 20)), 30000, from);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  if (until === 'card') {
    const card = await waitFor('card', (e) => e.type === 'permission.updated' && e.request.taskId === id && e.request.status === 'pending', 30000, from);
    return { id, from, card: card.type === 'permission.updated' ? card.request : null, synopsis: '' };
  }
  const done = await waitFor(`done: ${text}`, (e) => e.type === 'task.updated' && e.task.id === id && ['done', 'failed'].includes(e.task.status), 30000, from);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { id, from, card: null, synopsis: done.type === 'task.updated' ? done.task.synopsis ?? '' : '' };
}

try {
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Game', workspaceDir: proj });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === proj);

  // 1. The first ask makes the worktree; the work lands there, not in the owner's folder.
  const first = await ask('@game design: lines-done brief-echo env-echo write-file:new.txt rm-file:old.txt studio-call:s-bot studio-call:s-owner studio:Pranav2_Workspace build it');
  const tree = projectNow()?.worktree;
  if (!tree || !tree.root.startsWith(worktrees) || tree.branch !== 'agent-hq/main' || tree.base !== 'main') fail(`worktree record: ${JSON.stringify(tree)}`);
  if (!existsSync(join(tree.root, 'secrets.env')) || !existsSync(join(tree.root, 'Packages', 'lib.lua'))) fail('ignored secrets/packages were not copied into the worktree');
  const report = first.synopsis;
  for (const part of ['wrote new.txt', 'rm old.txt: approve', 'studio s-bot: allowed', 'studio s-owner: refused', 'env AGENT_HQ_STUDIO=Pranav2_Workspace']) {
    if (!report.includes(part)) fail(`report lacks "${part}": ${report}`);
  }
  if (!/Use only this task's Roblox Studio: "Pranav2_Workspace \(placeId: 2\)" \(studio_id s-bot\)/.test(report)) fail(`refusal message: ${report}`);
  if (events.slice(first.from).some((e) => e.type === 'permission.updated' && e.request.taskId === first.id)) fail('a card was raised in the worktree');
  if (existsSync(join(proj, 'new.txt')) || !existsSync(join(proj, 'old.txt'))) fail("the owner's folder changed");
  if (git(proj, 'rev-parse', 'main') !== git(proj, 'rev-list', '-n', '1', '--max-parents=0', 'main')) fail("the owner's branch moved");
  const files = git(proj, 'diff', '--name-status', 'main', 'agent-hq/main');
  if (!/A\s+new\.txt/.test(files) || !/D\s+old\.txt/.test(files)) fail(`the run wasn't committed on agent-hq/main: ${files}`);
  if (git(tree.root, 'status', '--porcelain')) fail('the worktree was left dirty');
  const brief = events
    .slice(first.from)
    .flatMap((e) => (e.type === 'task.transcript' && e.taskId === first.id ? e.entries : []))
    .map((row) => row.text)
    .find((text) => text.includes('BRIEF:')) ?? '';
  if (!brief.includes(`You work in the bots' worktree of Game: ${tree.dir}`) || !brief.includes('Roblox Studio for this task: "Pranav2_Workspace"')) fail(`brief: ${brief.slice(0, 1200)}`);
  if (!activitySince(first.from).some((line) => line.includes("saved to agent-hq/main in the bots' worktree"))) fail('no "saved to" line');
  console.log("worktree ok: made on agent-hq/main with secrets + packages copied; the run (write + delete, no card) committed there; owner's folder and main untouched");
  console.log('studio ok: the task\'s window allowed, the owner\'s refused with the right id, AGENT_HQ_STUDIO set, the brief names it');

  // 2. The owner commits on main; the next run takes it in first.
  writeFileSync(join(proj, 'owner.txt'), 'mine\n');
  git(proj, 'add', 'owner.txt');
  git(proj, 'commit', '-q', '-m', 'owner work');
  const second = await ask('@game design: lines-done write-file:second.txt more work');
  if (!activitySince(second.from).some((line) => line.includes('took in your 1 newer commit on main'))) fail(`no catch-up: ${activitySince(second.from).join(' / ')}`);
  if (!existsSync(join(tree.root, 'owner.txt')) || !existsSync(join(tree.root, 'second.txt'))) fail('catch-up / second run missing in the worktree');
  console.log("catch-up ok: the owner's newer commit merged into the worktree before the next run");

  // 3. No Studio assigned: a Studio call asks the owner.
  const third = await ask('@game design: lines-done studio-call:s-bot poke studio', 'card');
  if (!third.card?.flags.some((flag) => flag.includes('no Studio was assigned'))) fail(`no-Studio card: ${JSON.stringify(third.card)}`);
  send({ type: 'permission.respond', requestId: third.card.id, decision: 'deny', scope: 'once' });
  const thirdDone = await waitFor('third done', (e) => e.type === 'task.updated' && e.task.id === third.id && ['done', 'failed'].includes(e.task.status), 30000, third.from);
  if (thirdDone.type !== 'task.updated' || !thirdDone.task.synopsis?.includes('studio s-bot: refused (The owner said no')) fail(`denied Studio call: ${JSON.stringify(thirdDone)}`);
  console.log('no-studio ok: a Studio call with none assigned raised a card; denied, the worker was told why');

  // The open Studio windows reach HubInfo for the composer's picker.
  let from = events.length;
  send({ type: 'studios.list' });
  const info = await waitFor('studios', (e) => e.type === 'hub.updated' && (e.info.studios ?? []).length === 2, 10000, from);
  if (info.type !== 'hub.updated' || info.info.studios?.[1]?.name !== 'Pranav2_Workspace' || info.info.studios[1].placeId !== '2') fail(`studios: ${JSON.stringify(info)}`);
  console.log('studios.list ok: open windows on HubInfo');

  // 4. Merge: main fast-forwards to the bots' work; worktree + branch removed.
  from = events.length;
  send({ type: 'worktree.merge', projectId: projectNow()!.id });
  await waitFor('merged', (e) => e.type === 'activity' && /merged \d+ commits? from the bots into your main/.test(e.entry.message), 30000, from);
  if (!existsSync(join(proj, 'new.txt')) || !existsSync(join(proj, 'second.txt')) || existsSync(join(proj, 'old.txt')) || !existsSync(join(proj, 'owner.txt'))) fail("main's checkout doesn't have the bots' work");
  if (existsSync(tree.root) || git(proj, 'branch', '--list', 'agent-hq/*') || projectNow()?.worktree) fail('worktree/branch/record not removed after merge');
  if (readFileSync(join(proj, 'secrets.env'), 'utf8') !== 'TOKEN=abc\n') fail("the owner's ignored secrets changed");
  console.log("merge ok: main fast-forwarded to the bots' work; worktree, branch and record removed");

  // 5. A conflict is refused (nothing moves); discard throws the work away.
  await ask('@game design: lines-done write-file:clash.txt bots version');
  const again = projectNow()?.worktree;
  if (!again) fail('no new worktree for the next ask');
  writeFileSync(join(proj, 'clash.txt'), 'owner version\n');
  git(proj, 'add', 'clash.txt');
  git(proj, 'commit', '-q', '-m', 'owner clash');
  const mainBefore = git(proj, 'rev-parse', 'main');
  from = events.length;
  send({ type: 'worktree.merge', projectId: projectNow()!.id });
  await waitFor('conflict', (e) => e.type === 'activity' && e.entry.message.includes('both changed clash.txt'), 30000, from);
  if (git(proj, 'rev-parse', 'main') !== mainBefore || !existsSync(again.root) || git(again.root, 'status', '--porcelain')) fail('a conflicting merge moved something');
  from = events.length;
  send({ type: 'worktree.discard', projectId: projectNow()!.id });
  await waitFor('discarded', (e) => e.type === 'activity' && e.entry.message.includes("discarded the bots' work on agent-hq/main"), 30000, from);
  if (existsSync(again.root) || git(proj, 'branch', '--list', 'agent-hq/*') || projectNow()?.worktree) fail('discard left something behind');
  if (readFileSync(join(proj, 'clash.txt'), 'utf8') !== 'owner version\n') fail("discard touched the owner's file");
  console.log('conflict ok: a merge that conflicts is refused with the files named; discard removed worktree + branch');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
console.log('WORKTREE SMOKE PASS');
process.exit(0);
