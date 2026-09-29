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

// `rotateLog` is a test seam: a failing rotation is what this file has to
// survive, and Windows only produces it under conditions a test can't stage.
export function startEventLog(bus: HubBus, dataDir: string, rotateLog: typeof rotate = rotate): () => void {
  mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, 'events.jsonl');
  let bytes = existsSync(logPath) ? statSync(logPath).size : 0;

  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Size at which the next rotation is attempted. A rotation that fails
  // (Windows hands out EPERM whenever anything still has the file open) must
  // not take the append with it, and must not be retried on every flush
  // afterwards — the log keeps growing past the cap instead, which is far
  // better than losing it. The next attempt comes one full cap later.
  let rotateAt = MAX_LOG_BYTES;
  // One append at a time: the chain keeps batches in bus order and stops
  // concurrent writes from interleaving inside a line.
  let writing: Promise<void> = Promise.resolve();

  const take = (): string => {
    const chunk = buffer.join('');
    buffer = [];
    bytes += Buffer.byteLength(chunk);
    return chunk;
  };

  // Rolls the log aside if it has outgrown the cap. Never throws: the caller
  // appends either way.
  const tryRotate = (chunk: string): void => {
    if (bytes <= rotateAt || !existsSync(logPath)) return;
    try {
      rotateLog(dataDir, logPath);
      bytes = Buffer.byteLength(chunk);
      rotateAt = MAX_LOG_BYTES;
    } catch (error) {
      rotateAt = bytes + MAX_LOG_BYTES;
      console.warn('[hub] event log rotation failed; still appending:', error);
    }
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const chunk = take();
    writing = writing.then(async () => {
      tryRotate(chunk);
      // Outside the rotate guard on purpose: a failed rotation used to drop
      // this batch AND every batch after it, silently killing the log.
      try {
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
    tryRotate(chunk);
    try {
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
      return {
        ...task,
        status: 'paused',
        stoppedBy: 'restart',
        synopsis: task.synopsis ?? '(interrupted by a hub restart)',
        agentIds: [],
      };
    });
    return { tasks, usage: snapshot.usage };
  } catch {
    return null;
  }
}
