// Project MCP, as Claude Code opened in the project folder loads it: a
// worker gets its team's grants PLUS the servers set up for its project
// folder — the folder's own (`claude mcp add` there → ~/.claude.json, any
// casing of the path) and the project's .mcp.json servers the owner
// approved. An unapproved or disabled .mcp.json server never starts and the
// owner is told; the team's grant wins a name clash; ${VAR} expands.
//   npx tsx test/project-mcp.smoke.ts   (mock engine, no usage)
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type ClientCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { projectMcpServers } from '../src/engine/mcp-catalog.js';

const PORT = Number(process.env['PROJECT_MCP_SMOKE_PORT'] ?? 4655);
function fail(message: string): never {
  console.error(`PROJECT MCP SMOKE FAIL: ${message}`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-projmcp-'));
const game = join(sandbox, 'RobloxGame'); // .mcp.json (one approved, one not) + its own server
const plain = join(sandbox, 'PlainProject'); // nothing set up
for (const dir of [game, plain, join(game, '.claude')]) mkdirSync(dir, { recursive: true });
const studio = { type: 'stdio', command: 'cmd.exe', args: ['/c', 'studio-mcp.bat'] };
writeFileSync(
  join(game, '.mcp.json'),
  JSON.stringify({
    mcpServers: {
      Roblox_Studio: studio,
      Sketchy: { command: 'node', args: ['steal.js'] },
      Disabled_One: { command: 'x' },
      Env_Server: { command: '${AGENT_HQ_SMOKE_TOOL:-fallback-tool}', args: ['--home', '${AGENT_HQ_SMOKE_HOME}'] },
    },
  }),
);
writeFileSync(join(game, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['Roblox_Studio', 'Disabled_One', 'Env_Server'], disabledMcpjsonServers: ['Disabled_One'] }));
const claudeConfigPath = join(sandbox, 'claude.json');
// The folder's own server, kept under a different casing of its path.
writeFileSync(
  claudeConfigPath,
  JSON.stringify({
    mcpServers: { Roblox_Studio: studio, Figma: { command: 'figma-mcp' } }, // user scope: team grants only
    projects: { [game.replace(/\\/g, '/').toUpperCase()]: { mcpServers: { Game_Logs: { command: 'logs-mcp' } } } },
  }),
);
process.env['AGENT_HQ_SMOKE_HOME'] = 'C:\\smoke-home';

// The reader alone.
{
  const { servers, unapproved } = projectMcpServers(game, claudeConfigPath);
  const names = Object.keys(servers).sort().join('|');
  if (names !== 'Env_Server|Game_Logs|Roblox_Studio') fail(`project servers: ${names}`);
  if (unapproved.join('|') !== 'Sketchy') fail(`unapproved: ${unapproved.join('|')}`);
  const env = servers['Env_Server'] as { command: string; args: string[] };
  if (env.command !== 'fallback-tool' || env.args[1] !== 'C:\\smoke-home') fail(`\${VAR} not expanded: ${JSON.stringify(env)}`);
  if (Object.keys(projectMcpServers(plain, claudeConfigPath).servers).length) fail('a plain project got servers');
  console.log('reader ok: the folder\'s own server (any casing) + approved .mcp.json; unapproved reported, disabled skipped, ${VAR} expanded; user scope not inherited');
}

const hub = await startHub({
  engine: 'mock',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-projmcp-claude-')),
  claudeConfigPath,
  accessGrants: [],
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
send({ type: 'hello', client: 'cli', name: 'project-mcp-smoke' });
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 30000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
await waitFor('snapshot', (e) => e.type === 'snapshot');
const run = async (text: string, marker: string) => {
  const mark = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`created ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && !e.task.rootTaskId, 30000, mark);
  const id = created.type === 'task.updated' ? created.task.id : '';
  await waitFor(`${marker} done`, (e) => e.type === 'task.updated' && e.task.id === id && e.task.status === 'done', 30000, mark);
  const lines = events.slice(mark).flatMap((e) => (e.type === 'activity' && e.entry.taskId === id ? [e.entry.message] : []));
  return { mcp: lines.find((m) => m.startsWith('mock: mcp ')) ?? '', lines };
};

try {
  for (const [name, dir] of [['RobloxGame', game], ['PlainProject', plain]] as const) {
    send({ type: 'project.register', name, workspaceDir: dir });
    await waitFor(`project ${name}`, (e) => e.type === 'project.updated' && e.project.workspaceDir === dir);
  }

  // A team with no grants, in the game project: the project's servers.
  let result = await run('@robloxgame design: mcp-design check the menu', 'mcp-design');
  if (result.mcp !== 'mock: mcp [Game_Logs|Roblox_Studio|Env_Server]') fail(`design in the game project: ${result.mcp}`);
  if (!result.lines.includes('MCP from this project folder: Game_Logs, Roblox_Studio, Env_Server (as in Claude Code opened there)')) fail(`no "MCP from this project" line: ${result.lines.join(' | ')}`);
  if (!result.lines.includes("not started: Sketchy from this project's .mcp.json — approve it in Claude Code there first")) fail('the unapproved server was not reported');
  console.log("worker ok: a team with no grants got the game project's servers (not the unapproved one), and you're told");

  // The same team elsewhere: nothing extra. A team grant: kept, and it wins a clash.
  result = await run('@plainproject design: mcp-plain check the docs', 'mcp-plain');
  if (result.mcp !== 'mock: mcp []') fail(`design in a plain project: ${result.mcp}`);
  send({ type: 'team.mcp.set', teamId: 'coding', servers: ['Figma', 'Roblox_Studio'] });
  await waitFor('grant', (e) => e.type === 'team.updated' && e.team.id === 'coding' && Object.keys(e.team.mcpServers ?? {}).length === 2);
  result = await run('@robloxgame coding: mcp-coding fix the shop', 'mcp-coding');
  const granted = (result.mcp.match(/\[(.*)\]/)?.[1] ?? '').split('|').sort().join('|');
  if (granted !== 'Env_Server|Figma|Game_Logs|Roblox_Studio') fail(`coding in the game project: ${result.mcp}`);
  result = await run('@plainproject coding: mcp-coding-plain tidy up', 'mcp-coding-plain');
  if ((result.mcp.match(/\[(.*)\]/)?.[1] ?? '').split('|').sort().join('|') !== 'Figma|Roblox_Studio') fail(`coding in a plain project: ${result.mcp}`);
  console.log('teams ok: no extras outside the project; team grants kept everywhere and merged with the project\'s');

  console.log('PROJECT MCP SMOKE PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
process.exit(0);
