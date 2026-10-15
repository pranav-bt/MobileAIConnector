// A mock hub for driving the desktop UI in a browser without touching the
// real hub: own port, temp data, one registered project "Consolproj".
//   npx tsx test/ui-mock-hub.ts [port]   (Ctrl+C to stop)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encodeCommand } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const port = Number(process.argv[2] ?? 4651);
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-ui-hub-'));
const projectDir = join(sandbox, 'Consolproj');
mkdirSync(projectDir);
await startHub({
  engine: 'mock',
  port,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-ui-hub-claude-')),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
ws.on('open', () => {
  ws.send(encodeCommand({ type: 'hello', client: 'cli', name: 'ui-mock-hub' }));
  ws.send(encodeCommand({ type: 'project.register', name: 'Consolproj', workspaceDir: projectDir }));
  setTimeout(() => ws.close(), 500);
});
console.log(`UI MOCK HUB READY on ${port}`);
