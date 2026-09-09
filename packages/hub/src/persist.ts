import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HubEvent } from '@agent-hq/shared';
import { encodeEvent } from '@agent-hq/shared';
import type { HubBus } from './bus.js';

// Append-only JSONL event log. Deliberately dependency-free for the
// scaffold; swapping in SQLite later only changes this file, because
// everything worth persisting is already an event.
export function startEventLog(bus: HubBus, dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, 'events.jsonl');
  return bus.onEvent((event: HubEvent) => {
    try {
      appendFileSync(logPath, encodeEvent(event) + '\n');
    } catch (error) {
      console.warn('[hub] event log write failed:', error);
    }
  });
}
