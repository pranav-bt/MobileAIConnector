import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptEntry } from '@agent-hq/shared';

// Per-task console transcripts: data/transcripts/<taskId>.jsonl, append-only
// (a row that changes — a tool finishing — is appended again with the same
// id; readers keep the last version). Never in the global event log: only
// clients watching a task get its rows, so the office stream stays small.
// Writes are queued per task off the publish path; tool output is capped so a
// noisy build can't bloat the file.

const MAX_DETAIL = 8_000; // chars of tool output / diff kept per row
const MAX_FILE_BYTES = 6 * 1024 * 1024; // past this, rows keep their summary only
const PAGE = 300; // rows per backfill page

type Listener = (entries: TranscriptEntry[]) => void;
export type TranscriptRow = Omit<TranscriptEntry, 'taskId' | 'at'> & { at?: number };

export class TranscriptStore {
  #dir: string;
  #queues = new Map<string, Promise<void>>();
  #listeners = new Map<string, Set<Listener>>();
  #counter = 0;

  constructor(dataDir: string) {
    this.#dir = join(dataDir, 'transcripts');
  }

  #file(taskId: string): string {
    return join(this.#dir, `${taskId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
  }

  // A fresh row id (rows that update later — tools — bring their own).
  nextId(prefix = 'r'): string {
    this.#counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.#counter}`;
  }

  append(taskId: string, row: TranscriptRow): TranscriptEntry {
    const entry: TranscriptEntry = {
      ...row,
      taskId,
      at: row.at ?? Date.now(),
      ...(row.detail !== undefined ? { detail: row.detail.length > MAX_DETAIL ? `${row.detail.slice(0, MAX_DETAIL)}\n… (${row.detail.length - MAX_DETAIL} more characters)` : row.detail } : {}),
    };
    for (const listener of this.#listeners.get(taskId) ?? []) listener([entry]);
    const file = this.#file(taskId);
    const previous = this.#queues.get(taskId) ?? mkdir(this.#dir, { recursive: true }).then(() => undefined);
    const next = previous
      .then(async () => {
        let line = entry;
        const size = await stat(file).then((s) => s.size).catch(() => 0);
        if (size > MAX_FILE_BYTES && entry.detail) line = { ...entry, detail: '(output not kept — this transcript is very long)' };
        await appendFile(file, `${JSON.stringify(line)}\n`);
      })
      .catch((error) => console.warn(`[hub] transcript write failed for ${taskId}:`, error));
    this.#queues.set(taskId, next);
    void next.finally(() => {
      if (this.#queues.get(taskId) === next) this.#queues.delete(taskId);
    });
    return entry;
  }

  // The latest page (or the page before `before`), oldest first, each row at
  // its last version. `more` = older rows exist.
  async read(taskId: string, before?: number): Promise<{ entries: TranscriptEntry[]; more: boolean }> {
    await this.#queues.get(taskId);
    let raw: string;
    try {
      raw = await readFile(this.#file(taskId), 'utf8');
    } catch {
      return { entries: [], more: false };
    }
    const byId = new Map<string, TranscriptEntry>();
    const order: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      if (!byId.has(entry.id)) order.push(entry.id);
      // A row keeps its first timestamp (its place in the story).
      const first = byId.get(entry.id);
      byId.set(entry.id, first ? { ...entry, at: first.at } : entry);
    }
    const all = order.map((id) => byId.get(id)!);
    const upTo = before === undefined ? all.length : all.findIndex((entry) => entry.at >= before);
    const end = upTo < 0 ? all.length : upTo;
    const start = Math.max(0, end - PAGE);
    return { entries: all.slice(start, end), more: start > 0 };
  }

  // What the owner typed in a task's window (its steps' windows too — their
  // rows are mirrored into the ask's), oldest first, the latest `limit`.
  // Read straight from the file: only owner lines are parsed.
  ownerMessages(taskId: string, limit = 8): string[] {
    let raw: string;
    try {
      raw = readFileSync(this.#file(taskId), 'utf8');
    } catch {
      return [];
    }
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.includes('"role":"owner"')) continue;
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (entry.kind !== 'message' || entry.id === 'ask' || seen.has(entry.id)) continue;
        seen.add(entry.id);
        texts.push(entry.text);
      } catch {
        continue;
      }
    }
    return texts.slice(-limit);
  }

  watch(taskId: string, listener: Listener): () => void {
    let set = this.#listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.#listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.#listeners.delete(taskId);
    };
  }

  // Waits for queued writes (tests, shutdown).
  async flush(): Promise<void> {
    await Promise.all([...this.#queues.values()]);
  }
}
