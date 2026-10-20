// LIVE: real workers reach Roblox Studio through MCP (read-only tool only):
//   1. a team with NO grants, in a project whose approved .mcp.json sets up
//      Roblox_Studio (as Claude Code opened in that folder would have it);
//   2. a team GRANTED Roblox_Studio, in a project with nothing set up;
//   3. a team with neither: the tool isn't there.
// Uses the PC's own Roblox_Studio server config (~/.claude.json), temp
// projects and a temp hub; asks only for list_roblox_studios.
//   npx tsx test/roblox-mcp.live.ts      Spends a little usage.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = 4657;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};
const studio = (JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers?.['Roblox_Studio'];
if (!studio) {
  console.log('no Roblox_Studio MCP server configured for Claude Code on this PC — nothing to test');
  process.exit(0);
}
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-robloxmcp-live-'));
const withStudio = join(sandbox, 'StudioGame');
const plain = join(sandbox, 'PlainGame');
for (const dir of [join(withStudio, '.claude'), plain]) mkdirSync(dir, { recursive: true });
writeFileSync(join(withStudio, '.mcp.json'), JSON.stringify({ mcpServers: { Roblox_Studio: studio } }, null, 2));
writeFileSync(join(withStudio, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['Roblox_Studio'] }, null, 2));

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-robloxmcp-live-claude-')),
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
  if (event.type === 'task.updated' && event.task.title.startsWith('[QA]') && ['queued', 'in_flight'].includes(event.task.status)) {
    send({ type: 'task.stop', taskId: event.task.id });
  }
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiter ? waiters.indexOf(waiter) : 0, 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 600_000, from = 0): Promise<HubEvent> => {
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
const ASK =
  'Use the Roblox Studio MCP tool list_roblox_studios exactly once (it only lists open Studio windows — read-only) and report exactly what it returned. ' +
  "Don't run any other command and don't change any files. If you don't have that tool, just say so.";
const runAsk = async (text: string, marker: string) => {
  const mark = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`created ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && !e.task.rootTaskId, 120_000, mark);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  await waitFor(`${marker} finished`, (e) => e.type === 'task.updated' && e.task.id === id && ['done', 'failed', 'paused'].includes(e.task.status), 600_000, mark);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const calls = rows(id).filter((row) => row.kind === 'tool' && /list_roblox_studios/.test(row.tool ?? ''));
  const said = rows(id).filter((row) => row.role === 'worker' && row.kind === 'message').map((row) => row.text).join(' ').replace(/\s+/g, ' ');
  const lines = events.slice(mark).flatMap((e) => (e.type === 'activity' && e.entry.taskId === id ? [e.entry.message] : []));
  return { calls, said, lines };
};

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'roblox-mcp-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  for (const [name, dir] of [['StudioGame', withStudio], ['PlainGame', plain]] as const) {
    send({ type: 'project.register', name, workspaceDir: dir });
    await waitFor(`project ${name}`, (e) => e.type === 'project.updated' && e.project.workspaceDir === dir);
  }

  // 1. Project MCP: design has no grants; the project's approved .mcp.json sets Studio up.
  let result = await runAsk(`@studiogame design team: project-path check. ${ASK}`, 'project-path');
  record(
    'no grants, Studio set up for the project → reached Studio',
    result.calls.some((row) => row.state === 'ok') && result.lines.some((m) => m.startsWith('MCP from this project folder: Roblox_Studio')),
    `${result.calls.length} call(s): ${result.calls.map((row) => `${row.tool} ${row.state}`).join(', ')} · said: ${result.said.slice(0, 160)}`,
  );

  // 2. Team grant: coding granted Roblox_Studio, project with nothing set up.
  send({ type: 'team.mcp.set', teamId: 'coding', servers: ['Roblox_Studio'] });
  await waitFor('grant', (e) => e.type === 'team.updated' && e.team.id === 'coding' && 'Roblox_Studio' in (e.team.mcpServers ?? {}));
  result = await runAsk(`@plaingame coding team: grant-path check. ${ASK}`, 'grant-path');
  record(
    'team granted Studio, plain project → reached Studio',
    result.calls.some((row) => row.state === 'ok'),
    `${result.calls.length} call(s): ${result.calls.map((row) => `${row.tool} ${row.state}`).join(', ')} · said: ${result.said.slice(0, 160)}`,
  );

  // 3. Neither: no tool.
  result = await runAsk(`@plaingame design team: neither-path check. ${ASK}`, 'neither-path');
  record('no grant, nothing set up → no Studio tool', result.calls.length === 0, `said: ${result.said.slice(0, 200)}`);
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `ROBLOX MCP LIVE PASS (${results.length} checks)` : `ROBLOX MCP LIVE FAIL: ${failed.map((f) => f.check).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
