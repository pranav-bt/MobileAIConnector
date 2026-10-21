// LIVE: a real worker uses Blender through an app grant. A temp hub (own
// port, temp data) adds the Blender found on this PC as an app, grants it to
// an Art team that has NO shell (so Blender's tools are the only way to
// model), and asks for a small model saved + rendered into a temp project.
// Checks the worker called the app's tools, the .blend and .png exist, it
// looked at its render, and no Blender this run opened is left running.
//   npx tsx test/apps-worker.live.ts [--visible] [--model gpt-6.1-sol]   Spends a little usage.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { detectBlender } from '../src/apps.js';

const PORT = 4658;
const visible = process.argv.includes('--visible');
const modelArg = process.argv.indexOf('--model');
const workerModel = modelArg > 0 ? process.argv[modelArg + 1] : undefined;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};
const exePath = detectBlender()[0];
if (!exePath) {
  console.log('SKIP: no Blender on this PC');
  process.exit(0);
}
const blenderPids = (): number[] => {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return [...out.matchAll(/"blender\.exe","(\d+)"/g)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
};
const before = new Set(blenderPids());

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-apps-live-'));
const project = join(sandbox, 'ArtProj');
mkdirSync(project, { recursive: true });
const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-apps-live-claude-')),
  claudeConfigPath: join(sandbox, 'no-claude.json'),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const events: HubEvent[] = [];
const waiters: { test: (e: HubEvent) => boolean; resolve: (e: HubEvent) => void }[] = [];
const send = (command: ClientCommand) => ws.send(encodeCommand(command));
ws.on('message', (raw) => {
  const event = decodeEvent(raw.toString());
  if (!event) return;
  events.push(event);
  // Only the art worker's run is under test: no QA rounds.
  if (event.type === 'task.updated' && event.task.title.startsWith('[QA]') && ['queued', 'in_flight'].includes(event.task.status)) {
    send({ type: 'task.stop', taskId: event.task.id });
  }
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 900_000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const rows = (taskId: string) => {
  const byId = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) byId.set(entry.id, entry);
  return [...byId.values()];
};

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'apps-worker-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'ArtProj', workspaceDir: project });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === project);
  send({ type: 'app.add', name: 'Blender', exePath, visible, notes: 'Units are metres. Keep models low-poly.' });
  await waitFor('app', (e) => e.type === 'hub.updated' && (e.info.apps ?? []).some((app) => app.id === 'blender'));
  send({
    type: 'team.create',
    name: 'Art team',
    charter: 'Makes 3D models, materials and animations for games. Works in Blender.',
    allowedTools: ['read', 'edit'],
    blockedTools: ['bash'],
  });
  const team = await waitFor('team', (e) => e.type === 'team.updated' && e.team.name === 'Art team');
  const teamId = team.type === 'team.updated' ? team.team.id : '';
  send({ type: 'team.mcp.set', teamId, servers: ['blender'] });
  await waitFor('grant', (e) => e.type === 'team.updated' && e.team.id === teamId && 'blender' in (e.team.mcpServers ?? {}));
  if (workerModel) {
    send({ type: 'models.set', overrides: { teams: { [teamId]: { worker: { model: workerModel } } } } });
    await waitFor('model', (e) => e.type === 'hub.updated' && e.info.modelOverrides.teams[teamId]?.worker?.model === workerModel);
  }

  const blend = join(project, 'tree.blend');
  const png = join(project, 'tree.png');
  const mark = events.length;
  send({
    type: 'task.submit',
    text:
      '@artproj art team: blender-live Make a simple low-poly tree in Blender: a brown cylinder trunk and a green cone for the leaves, ' +
      `each with its own material. Save it as ${blend}, render a preview to ${png} and look at it, then close Blender. ` +
      'Report the objects you made.',
  });
  const created = await waitFor('created', (e) => e.type === 'task.updated' && e.task.detail.includes('blender-live') && !e.task.rootTaskId, 120_000, mark);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  const finished = await waitFor('finished', (e) => e.type === 'task.updated' && e.task.id === id && ['done', 'failed', 'paused'].includes(e.task.status), 900_000, mark);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const task = finished.type === 'task.updated' ? finished.task : null;
  const tools = rows(id).filter((row) => row.kind === 'tool' && /blender/.test(row.tool ?? ''));
  const used = (name: string) => tools.filter((row) => row.tool?.endsWith(`__${name}`) || row.tool?.endsWith(`.${name}`));
  const lines = events.slice(mark).flatMap((e) => (e.type === 'activity' && e.entry.taskId === id ? [e.entry.message] : []));

  record('task done', task?.status === 'done', `${task?.status} · ${lines.filter((l) => /blocked|asked|failed/i.test(l)).join(' | ').slice(0, 200)}`);
  record('modelled with Blender Python', used('python').some((row) => row.state === 'ok'), `${used('python').length} python call(s)`);
  record('rendered (and got the image back)', used('render').some((row) => row.state === 'ok'), used('render').map((row) => (row.detail ?? '').slice(0, 120)).join(' | '));
  record('saved tree.blend in the project', existsSync(blend) && statSync(blend).size > 1000, existsSync(blend) ? `${statSync(blend).size} bytes` : 'missing');
  record('rendered tree.png in the project', existsSync(png) && statSync(png).size > 500, existsSync(png) ? `${statSync(png).size} bytes` : 'missing');
  record('closed Blender itself', used('close').length > 0, `${used('close').length} close call(s)`);
  const left = blenderPids().filter((pid) => !before.has(pid));
  record('no Blender left running', left.length === 0, left.length ? `still running: ${left.join(', ')}` : 'none');
  record('report names the trunk and the leaves', /trunk/i.test(task?.synopsis ?? '') && /(leaves|cone|foliage|canopy)/i.test(task?.synopsis ?? ''), (task?.synopsis ?? '').replace(/\s+/g, ' ').slice(0, 200));
  console.log(`worker model: ${workerModel ?? 'team default'}`);
  console.log(`tools: ${tools.map((row) => `${row.tool?.replace(/^mcp__/, '')} ${row.state}`).join(', ')}`);
  console.log(`files: ${png}`);
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `APPS WORKER LIVE PASS (${results.length} checks)` : `APPS WORKER LIVE FAIL: ${failed.map((f) => f.check).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
