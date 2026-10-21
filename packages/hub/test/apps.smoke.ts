// Apps (Settings > Apps): desktop programs teams can be granted like an MCP
// connection, served by Agent HQ's app bridge. No real apps, no usage:
//  - the bridge with a generic app (Node itself as "the program"): run as a
//    command-line tool, open/status/close, idle close, close when the session
//    ends, and a reviewer's read-only bridge (no run);
//  - the bridge with a fake Blender speaking the bridge's socket protocol:
//    python / render (the image comes back) / scene / close, and the app
//    quitting by itself when the bridge is killed;
//  - the hub: app.add/update/remove, refusals, suggestions, the catalog, a
//    grant reaching the worker (told about it), a reviewer seat getting the
//    read-only bridge, and removal taking the grant off the team.
//   npx tsx test/apps.smoke.ts   (mock engine, no usage)
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { APP_BRIDGE } from '../src/apps.js';

const PORT = Number(process.env['APPS_SMOKE_PORT'] ?? 4657);
function fail(message: string): never {
  console.error(`APPS SMOKE FAIL: ${message}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitUntil = async (test: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await sleep(100);
  return test();
};

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-apps-'));
const appsFile = join(sandbox, 'apps.json');

// A fake Blender: the bridge starts it as `<exe> <app.args> [-b] --python
// blender_bridge.py -- --port N --token T --parent PID`, like the real one.
const fakeBlender = join(sandbox, 'fake-blender.mjs');
writeFileSync(
  fakeBlender,
  `import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(process.argv.indexOf('--') + 1);
const get = (name) => argv[argv.indexOf('--' + name) + 1];
const token = get('token');
const parent = Number(get('parent'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const server = createServer((socket) => {
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data;
    if (!buffer.includes('\\n')) return;
    const request = JSON.parse(buffer.split('\\n')[0]);
    const reply = (value) => socket.end(JSON.stringify(value) + '\\n');
    if (request.token !== token) return reply({ ok: false, error: 'refused: bad token' });
    if (request.op === 'ping') return reply({ ok: true, version: '9.9 fake', background: true });
    if (request.op === 'exec') return reply({ ok: !request.code.includes('boom'), output: 'ran ' + request.code.length + ' chars\\n', result: request.code.includes('result') ? 7 : null, error: request.code.includes('boom') ? 'Traceback: boom' : null });
    if (request.op === 'render') { writeFileSync(request.path, PNG); return reply({ ok: true, path: request.path, engine: 'BLENDER_WORKBENCH', width: 1, height: 1, camera: 'Camera', seconds: 0.01 }); }
    if (request.op === 'scene') return reply({ ok: true, scene: { objects: [{ name: 'Cube' }] } });
    if (request.op === 'quit') { reply({ ok: true }); setTimeout(() => process.exit(0), 50); return; }
    reply({ ok: false, error: 'unknown op' });
  });
});
server.listen(Number(get('port')), '127.0.0.1');
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 300);
`,
);
writeFileSync(
  appsFile,
  JSON.stringify([
    { id: 'nodeapp', name: 'Node', exePath: process.execPath, args: [], kind: 'generic', visible: false, idleMinutes: 10, notes: 'a test program', createdAt: 1 },
    { id: 'blender', name: 'Fake Blender', exePath: process.execPath, args: [fakeBlender], kind: 'blender', visible: false, idleMinutes: 10, notes: '', createdAt: 1 },
  ]),
);

type Content = { type: string; text?: string; data?: string; mimeType?: string };
function bridge(appId: string, extra: string[] = [], env: Record<string, string> = {}) {
  const proc: ChildProcess = spawn(process.execPath, [APP_BRIDGE, '--app', appId, '--apps-file', appsFile, ...extra], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  let next = 1;
  const waiting = new Map<number, (message: any) => void>();
  createInterface({ input: proc.stdout! }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const request = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request('tools/call', { name, arguments: args });
    const content: Content[] = reply.result?.content ?? [];
    return { content, text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!reply.result?.isError };
  };
  const tools = async () => ((await request('tools/list')).result?.tools ?? []).map((tool: { name: string }) => tool.name).join(',');
  return { proc, request, call, tools };
}
const pidOf = (text: string) => Number(text.match(/pid (\d+)/)?.[1] ?? 0);

// --- the bridge, a generic app ---------------------------------------------
{
  const app = bridge('nodeapp', [], { AGENT_HQ_APP_IDLE_MS: '1500' });
  const init = await app.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  if (init.result?.protocolVersion !== '2025-03-26') fail(`initialize: ${JSON.stringify(init)}`);
  if (!String(init.result?.instructions).includes('a test program')) fail('the owner\'s notes are not in the server instructions');
  if ((await app.tools()) !== 'status,open,close,run') fail(`generic tools: ${await app.tools()}`);
  let result = await app.call('run', { args: ['-e', 'console.log(40 + 2)'] });
  if (result.isError || !result.text.includes('exit code 0') || !result.text.includes('42')) fail(`run: ${result.text}`);
  result = await app.call('run', { args: ['-e', 'process.exit(3)'] });
  if (!result.isError || !result.text.includes('exit code 3')) fail(`a failing run: ${result.text}`);
  result = await app.call('python', { code: 'x' });
  if (!result.isError) fail('a generic app offered python');
  result = await app.call('open', { args: ['-e', 'setInterval(() => {}, 1000)'] });
  const pid = pidOf(result.text);
  if (!pid || !alive(pid)) fail(`open: ${result.text}`);
  if (!(await app.call('status')).text.includes('is open')) fail('status after open');
  result = await app.call('close');
  if (!result.text.includes('closed (asked)') || !(await waitUntil(() => !alive(pid), 10_000))) fail(`close: ${result.text}`);
  console.log('generic app ok: run (output + exit code), open → status → close (process gone), no Blender tools');

  // Idle close (1.5 s here), then the session ending closes what it opened.
  result = await app.call('open', { args: ['-e', 'setInterval(() => {}, 1000)'] });
  const idlePid = pidOf(result.text);
  if (!(await waitUntil(() => !alive(idlePid), 8000))) fail('the app did not close when idle');
  if (!(await app.call('status')).text.includes("isn't open")) fail('status after the idle close');
  result = await app.call('open', { args: ['-e', 'setInterval(() => {}, 1000)'] });
  const endPid = pidOf(result.text);
  app.proc.stdin!.end();
  if (!(await waitUntil(() => !alive(endPid), 10_000))) fail('the app outlived the session');
  if (!(await waitUntil(() => app.proc.exitCode !== null, 5000))) fail('the bridge did not exit when the session ended');
  console.log('lifecycle ok: closes when idle, and when the worker\'s session ends');

  const reviewer = bridge('nodeapp', ['--read-only']);
  await reviewer.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  if ((await reviewer.tools()) !== 'status,open,close') fail(`read-only tools: ${await reviewer.tools()}`);
  result = await reviewer.call('run', { args: ['-e', '1'] });
  if (!result.isError || !result.text.includes('read-only')) fail(`read-only run: ${result.text}`);
  reviewer.proc.kill();
  console.log('read-only ok: a reviewer\'s bridge has no run');
}

// --- the bridge, (fake) Blender ----------------------------------------------
{
  const blender = bridge('blender');
  await blender.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  if ((await blender.tools()) !== 'status,open,close,run,python,render,scene') fail(`blender tools: ${await blender.tools()}`);
  let result = await blender.call('python', { code: 'result = 1' });
  if (result.isError || !result.text.includes('ran 10 chars') || !result.text.includes('result: 7')) fail(`python (opens Blender first): ${result.text}`);
  const pid = pidOf((await blender.call('status')).text);
  if (!pid) fail('status after python');
  result = await blender.call('python', { code: 'boom' });
  if (!result.isError || !result.text.includes('boom')) fail(`python error: ${result.text}`);
  const png = join(sandbox, 'out', 'shot.png');
  mkdirSync(join(sandbox, 'out'), { recursive: true });
  result = await blender.call('render', { path: png });
  const image = result.content.find((c) => c.type === 'image');
  if (result.isError || !existsSync(png) || image?.mimeType !== 'image/png' || !image.data) fail(`render: ${result.text}`);
  result = await blender.call('scene');
  if (!result.text.includes('Cube')) fail(`scene: ${result.text}`);
  result = await blender.call('close');
  if (!result.text.includes('closed') || !(await waitUntil(() => !alive(pid), 10_000))) fail(`close: ${result.text}`);
  result = await blender.call('open');
  const second = pidOf((await blender.call('status')).text);
  if (!result.text.includes('9.9 fake') || !second) fail(`reopen: ${result.text}`);
  blender.proc.kill('SIGKILL');
  if (!(await waitUntil(() => !alive(second), 10_000))) fail('Blender outlived a killed bridge');
  console.log('blender ok: python (opens it when needed), errors, render (image returned), scene, close, quits when the bridge is killed');

  const reviewer = bridge('blender', ['--read-only']);
  await reviewer.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  if ((await reviewer.tools()) !== 'status,open,close,render,scene') fail(`read-only blender tools: ${await reviewer.tools()}`);
  reviewer.proc.kill();
  console.log('read-only blender ok: render + scene, no python, no run');
}

// --- the hub ---------------------------------------------------------------------
const project = join(sandbox, 'ArtProject');
mkdirSync(project, { recursive: true });
const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-apps-claude-')),
  claudeConfigPath: join(sandbox, 'claude.json'),
  accessGrants: [],
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
  detectApps: () => [process.execPath],
});
writeFileSync(join(sandbox, 'claude.json'), JSON.stringify({ mcpServers: { 'node-tool': { command: 'clash' } } }));
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
send({ type: 'hello', client: 'cli', name: 'apps-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const activity = (from: number, pattern: RegExp) =>
  waitFor(`activity ${pattern}`, (e) => e.type === 'activity' && pattern.test(e.entry.message), 15000, from);
const info = () => {
  const last = [...events].reverse().find((e) => e.type === 'hub.updated' || e.type === 'snapshot');
  return last?.type === 'hub.updated' ? last.info : last?.type === 'snapshot' ? last.snapshot.info : null;
};
const run = async (command: ClientCommand, marker: string) => {
  const mark = events.length;
  send(command);
  const created = await waitFor(`created ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && !e.task.rootTaskId, 30000, mark);
  const id = created.type === 'task.updated' ? created.task.id : '';
  await waitFor(`${marker} done`, (e) => e.type === 'task.updated' && e.task.id === id && e.task.status === 'done', 30000, mark);
  return events.slice(mark).flatMap((e) => (e.type === 'activity' && e.entry.taskId === id ? [e.entry.message] : []));
};

try {
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  if (info()?.appSuggestions?.[0]?.exePath !== process.execPath) fail(`suggestions: ${JSON.stringify(info()?.appSuggestions)}`);

  // Refusals: relative path, a script (not a program), nothing there.
  let mark = events.length;
  send({ type: 'app.add', name: 'Relative', exePath: 'tools\\thing.exe' });
  await activity(mark, /^apps: couldn't add Relative — use the program's full path/);
  mark = events.length;
  const script = join(sandbox, 'tool.cmd');
  writeFileSync(script, '@echo off');
  send({ type: 'app.add', name: 'Script', exePath: script });
  if (process.platform === 'win32') await activity(mark, /^apps: couldn't add Script — tool\.cmd isn't a program/);
  mark = events.length;
  send({ type: 'app.add', name: 'Missing', exePath: join(sandbox, 'missing.exe') });
  await activity(mark, /^apps: couldn't add Missing — nothing at/);
  console.log('refusals ok: relative paths, scripts and missing programs are not added (the feed says why)');

  // Add: an id that doesn't clash with a Claude Code server of the same name.
  mark = events.length;
  send({ type: 'app.add', name: 'Node Tool', exePath: `"${process.execPath}"`, notes: 'Use it for scripts.', visible: false });
  const added = await waitFor('app added', (e) => e.type === 'hub.updated' && (e.info.apps?.length ?? 0) === 1, 15000, mark);
  const app = added.type === 'hub.updated' ? added.info.apps![0]! : fail('no app');
  if (app.id !== 'node-tool-2' || app.kind !== 'generic' || app.exePath !== process.execPath || app.visible || app.idleMinutes !== 10) fail(`added: ${JSON.stringify(app)}`);
  if (!added.type || !(added.type === 'hub.updated' && added.info.mcpCatalog?.includes('node-tool-2'))) fail('the app is not in the catalog');
  if (added.type === 'hub.updated' && added.info.appSuggestions?.length) fail('an added install is still suggested');
  mark = events.length;
  send({ type: 'app.add', name: 'node tool', exePath: process.execPath });
  await activity(mark, /^apps: couldn't add node tool — there is already an app called/);
  console.log('add ok: listed, in the catalog (id avoids a same-named MCP server), no longer suggested; duplicate names refused');

  // Grant it to a team; a worker gets the bridge and is told about the app.
  send({ type: 'project.register', name: 'ArtProject', workspaceDir: project });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === project);
  send({ type: 'team.mcp.set', teamId: 'design', servers: ['node-tool-2'] });
  const granted = await waitFor('grant', (e) => e.type === 'team.updated' && e.team.id === 'design' && 'node-tool-2' in (e.team.mcpServers ?? {}));
  const config = granted.type === 'team.updated' ? (granted.team.mcpServers['node-tool-2'] as { args: string[] }) : null;
  if (!config?.args.includes('--apps-file') || !/app-bridge\.mjs$/.test(config.args[0] ?? '')) fail(`grant config: ${JSON.stringify(config)}`);
  let lines = await run({ type: 'task.submit', text: '@artproject design: apps-worker draw the logo' }, 'apps-worker');
  if (!lines.includes('mock: apps [node-tool-2] · told')) fail(`worker: ${lines.filter((l) => l.startsWith('mock:')).join(' | ')}`);
  console.log('grant ok: the worker runs the bridge for the app and its brief names it');

  // Editing the app needs no re-grant (the bridge reads the record when it starts).
  mark = events.length;
  send({ type: 'app.update', appId: 'Node Tool', notes: 'Prefer short scripts.', idleMinutes: 3 });
  const updated = await waitFor('updated', (e) => e.type === 'hub.updated' && e.info.apps?.[0]?.notes === 'Prefer short scripts.', 15000, mark);
  if (updated.type === 'hub.updated' && updated.info.apps?.[0]?.idleMinutes !== 3) fail('idle minutes not updated');
  console.log('update ok: notes and idle minutes changed in place');

  // A pair reviewer gets the read-only bridge.
  lines = await run({ type: 'task.submit', text: '@artproject design: apps-pair review the poster', pair: true }, 'apps-pair');
  if (!lines.includes('mock: apps [node-tool-2 read-only]')) fail(`reviewer: ${lines.filter((l) => l.startsWith('mock:')).join(' | ')}`);
  console.log('reviewer ok: a pair reviewer gets the app read-only');

  // Removing the app takes the grant off the team.
  mark = events.length;
  send({ type: 'app.remove', appId: 'node-tool-2' });
  await waitFor('grant removed', (e) => e.type === 'team.updated' && e.team.id === 'design' && !('node-tool-2' in (e.team.mcpServers ?? {})), 15000, mark);
  await activity(mark, /^apps: removed Node Tool \(and from Design team\)/);
  await waitFor('app gone', (e) => e.type === 'hub.updated' && (e.info.apps?.length ?? 0) === 0 && !e.info.mcpCatalog?.includes('node-tool-2') && e.info.appSuggestions?.length === 1, 15000, mark);
  console.log('remove ok: the app and its grant are gone, the install is suggested again');

  console.log('APPS SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
