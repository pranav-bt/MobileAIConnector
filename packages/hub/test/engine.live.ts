import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

// LIVE validation of the Claude engine path: real routing call, real worker,
// real lead review. Spends a small amount of usage — run manually, not in CI.

const PORT = 4603;
const TASK =
  'Write one short tagline (a single sentence) for Agent HQ, an app that visualizes AI agents as an office. This is a design/branding request. Do not use any tools, do not read files — just reply with the tagline.';

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: mkdtempSync(join(tmpdir(), 'agent-hq-live-')),
});

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

ws.on('open', () => {
  ws.send(encodeCommand({ type: 'hello', client: 'cli', name: 'live-test' }));
  ws.send(encodeCommand({ type: 'task.submit', text: TASK }));
  console.log('task submitted, waiting (up to 4 min)…');
});

const timer = setTimeout(async () => {
  console.error('LIVE TEST TIMEOUT');
  ws.close();
  await hub.close();
  process.exit(1);
}, 240_000);

ws.on('message', async (raw) => {
  const event: HubEvent | null = decodeEvent(raw.toString());
  if (!event) return;
  if (event.type === 'task.updated' && event.task.teamId && event.task.status === 'in_flight' && event.task.progressPct === 5) {
    console.log(`routed to: ${event.task.teamId} — title: ${event.task.title}`);
  }
  if (event.type === 'activity') {
    console.log(`  [${event.entry.agentId}] ${event.entry.message.slice(0, 100)}`);
  }
  if (event.type === 'task.updated' && (event.task.status === 'done' || event.task.status === 'failed')) {
    clearTimeout(timer);
    console.log(`FINAL: ${event.task.status} (${event.task.tokensUsed} worker tokens)`);
    console.log(`SYNOPSIS: ${event.task.synopsis}`);
    ws.close();
    await hub.close();
    process.exit(event.task.status === 'done' ? 0 : 1);
  }
});
