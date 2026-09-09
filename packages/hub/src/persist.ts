import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HubEvent, Snapshot, Task, Usage } from '@agent-hq/shared';
import { SnapshotSchema, encodeEvent, toSnapshot } from '@agent-hq/shared';
import type { HubBus } from './bus.js';

// Append-only JSONL event log plus a debounced state snapshot. Deliberately
// dependency-free; swapping in SQLite later only changes this file, because
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
