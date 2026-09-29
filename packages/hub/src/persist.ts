import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HubEvent, Snapshot, Task, Usage } from '@agent-hq/shared';
import { SnapshotSchema, encodeEvent, toSnapshot } from '@agent-hq/shared';
import type { HubBus } from './bus.js';

// Append-only JSONL event log plus a debounced state snapshot. Deliberately
// dependency-free; swapping in SQLite later only changes this file, because
// everything worth persisting is already an event.

// Roll events.jsonl over at 8 MB and keep this many rolled files — the log
// is a debugging trail, not an archive, so it stays bounded on its own.
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_ROLLED_LOGS = 3;
// Events are buffered and appended in one write per tick-ish window, so a
// busy run costs a handful of writes a second instead of one per event.
const FLUSH_INTERVAL_MS = 250;

// Renames the live log aside and drops the oldest rolled files. Rotation is
// synchronous and rare (once per 8 MB), and it runs between flushes, so no
// append is ever in flight across the rename.
function rotate(dataDir: string, logPath: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(logPath, join(dataDir, `events-${stamp}.jsonl`));
  const rolled = readdirSync(dataDir)
    .filter((name) => /^events-.+\.jsonl$/.test(name))
    .sort();
  for (const name of rolled.slice(0, Math.max(0, rolled.length - KEEP_ROLLED_LOGS))) {
    try {
      unlinkSync(join(dataDir, name));
    } catch {
      /* a log we couldn't prune is not worth failing over */
    }
  }
}

export function startEventLog(bus: HubBus, dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, 'events.jsonl');
  let bytes = existsSync(logPath) ? statSync(logPath).size : 0;

  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // One append at a time: the chain keeps batches in bus order and stops
  // concurrent writes from interleaving inside a line.
  let writing: Promise<void> = Promise.resolve();

  const take = (): string => {
    const chunk = buffer.join('');
    buffer = [];
    bytes += Buffer.byteLength(chunk);
    return chunk;
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const chunk = take();
    writing = writing.then(async () => {
      try {
        if (bytes > MAX_LOG_BYTES && existsSync(logPath)) {
          rotate(dataDir, logPath);
          bytes = Buffer.byteLength(chunk);
        }
        await appendFile(logPath, chunk);
      } catch (error) {
        console.warn('[hub] event log write failed:', error);
      }
    });
  };

  const unsubscribe = bus.onEvent((event: HubEvent) => {
    if (event.type === 'file.shared') return; // transient payloads stay out of the log
    buffer.push(encodeEvent(event) + '\n');
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  });

  return () => {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Shutdown is synchronous: write whatever is still buffered right here.
    if (buffer.length === 0) return;
    const chunk = take();
    try {
      if (bytes > MAX_LOG_BYTES && existsSync(logPath)) rotate(dataDir, logPath);
      appendFileSync(logPath, chunk);
    } catch (error) {
      console.warn('[hub] event log flush on shutdown failed:', error);
    }
  };
}

// Writes the full state to data/state.json at most once a second, so task
// history and usage survive hub restarts.
export function startSnapshotWriter(bus: HubBus, dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const snapshotPath = join(dataDir, 'state.json');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = bus.onEvent(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        writeFileSync(snapshotPath, JSON.stringify(toSnapshot(bus.state)));
      } catch (error) {
        console.warn('[hub] snapshot write failed:', error);
      }
    }, 1000);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
    try {
      writeFileSync(snapshotPath, JSON.stringify(toSnapshot(bus.state)));
    } catch {
      /* best effort on shutdown */
    }
  };
}

// What engine mode restores after a restart: finished task history (anything
// mid-flight is marked paused) and the usage counters. Agents, permissions,
// and teams are rebuilt fresh by the orchestrator.
export function loadPriorState(dataDir: string): { tasks: Task[]; usage: Usage } | null {
  const snapshotPath = join(dataDir, 'state.json');
  if (!existsSync(snapshotPath)) return null;
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(readFileSync(snapshotPath, 'utf8')));
    if (!parsed.success) return null;
    const snapshot: Snapshot = parsed.data;
    const tasks = snapshot.tasks.map((task): Task => {
      if (['done', 'failed', 'paused'].includes(task.status)) return task;
      return { ...task, status: 'paused', synopsis: task.synopsis ?? '(interrupted by a hub restart)', agentIds: [] };
    });
    return { tasks, usage: snapshot.usage };
  } catch {
    return null;
  }
}
