import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

// LIVE proof that a worker reads and OBEYS the project's CLAUDE.md: a
// throwaway project whose CLAUDE.md demands a codeword; the worker's output
// must contain it. Spends a small amount of usage — run manually.

const PORT = 4607;
const CODEWORD = 'ZANZIBAR';

const projectDir = mkdtempSync(join(tmpdir(), 'agent-hq-claudemd-'));
writeFileSync(
  join(projectDir, 'CLAUDE.md'),
  `# Project rules\n\n- CRITICAL RULE: include the codeword ${CODEWORD} (exactly, uppercase) in every message and report you write.\n`,
);

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: mkdtempSync(join(tmpdir(), 'agent-hq-live2-')),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
});

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const seen: string[] = [];

const timer = setTimeout(async () => {
  console.error('LIVE TEST TIMEOUT');
  ws.close();
  await hub.close();
  process.exit(1);
}, 240_000);

ws.on('open', () => {
  ws.send(encodeCommand({ type: 'hello', client: 'cli', name: 'claudemd-live' }));
  ws.send(encodeCommand({ type: 'project.register', name: 'Zanzitest', workspaceDir: projectDir }));
  ws.send(
    encodeCommand({
      type: 'task.submit',
      text: '@zanzitest Say hello to the owner in one short sentence. Do not use any tools, do not read files beyond your standard context.',
    }),
  );
  console.log('task submitted, waiting (up to 4 min)…');
});

ws.on('message', async (raw) => {
  const event: HubEvent | null = decodeEvent(raw.toString());
  if (!event) return;
  if (event.type === 'activity') {
    seen.push(event.entry.message);
    console.log(`  [${event.entry.agentId}] ${event.entry.message.slice(0, 100)}`);
  }
  if (event.type === 'task.updated' && (event.task.status === 'done' || event.task.status === 'failed')) {
    clearTimeout(timer);
    if (event.task.synopsis) seen.push(event.task.synopsis);
    console.log(`FINAL: ${event.task.status} · project: ${event.task.projectId}`);
    console.log(`SYNOPSIS: ${event.task.synopsis}`);
    const obeyed = seen.some((message) => message.includes(CODEWORD));
    console.log(obeyed ? 'CLAUDE.md OBEYED — codeword found in worker output' : 'CODEWORD MISSING — CLAUDE.md not honored');
    ws.close();
    await hub.close();
    process.exit(event.task.status === 'done' && obeyed ? 0 : 1);
  }
});
