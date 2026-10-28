// A mock hub for driving the desktop UI in a browser without touching the
// real hub: own port, temp data, one registered project "Consolproj".
//   npx tsx test/ui-mock-hub.ts [port] [--worktree]   (Ctrl+C to stop)
// --worktree: Consolproj is a git repo, workers get the bots' worktree, and
// two fake Roblox Studio windows are "open".
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encodeCommand } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const port = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) ?? 4651);
const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-ui-hub-'));
const projectDir = join(sandbox, 'Consolproj');
mkdirSync(projectDir);
const worktree = process.argv.includes('--worktree');
if (worktree) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Owner');
  git('config', 'user.email', 'owner@example.com');
  writeFileSync(join(projectDir, 'readme.md'), '# consolproj\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
}
await startHub({
  ...(worktree
    ? {
        worktreesDir: join(sandbox, 'worktrees'),
        studios: async () => [
          { id: 's-owner', name: 'Heat (placeId: 1)' },
          { id: 's-bot', name: 'Pranav2_Workspace (placeId: 2)' },
        ],
      }
    : {}),
  engine: 'mock',
  port,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-ui-hub-claude-')),
  // `--codex-home <dir>`: a fake ~/.codex, to show Codex freelancers
  ...(process.argv.includes('--codex-home') ? { codexHome: process.argv[process.argv.indexOf('--codex-home') + 1] ?? null } : {}),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
ws.on('open', () => {
  ws.send(encodeCommand({ type: 'hello', client: 'cli', name: 'ui-mock-hub' }));
  ws.send(encodeCommand({ type: 'project.register', name: 'Consolproj', workspaceDir: projectDir }));
  setTimeout(() => ws.close(), 500);
});
console.log(`UI MOCK HUB READY on ${port}`);
