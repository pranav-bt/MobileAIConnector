import { closeSync, openSync, readSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

// The owner's own Codex sessions on this PC (VS Code panel or the codex
// CLI), for the freelancer view. Codex keeps one rollout per conversation
// under <codexHome>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl;
// the first record (session_meta) says who started it (originator), how
// (source) and where (cwd). Rollouts can be hundreds of MB: only the head
// and tail are ever read.
//
// Not freelancers: Agent HQ's own threads (originator "agent-hq"), one-shot
// `codex exec` runs (source "exec") and sub-agents (source is an object).
// Open = Codex holds the thread's writer lock (<codexHome>/thread-writer-locks/
// <id>.lock is byte-range locked: reading it fails with EBUSY).

export interface CodexSessionFacts {
  threadId: string;
  cwd: string | null;
  activity: string;
}

const THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function stringField(head: string, name: string): string | null {
  const match = head.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

// null = not one of the owner's interactive sessions.
export function codexSessionFacts(fileName: string, head: string, tail: string): CodexSessionFacts | null {
  const threadId = fileName.match(THREAD_ID)?.[1];
  if (!threadId || !head.includes('"session_meta"')) return null;
  const originator = stringField(head, 'originator');
  if (originator === 'agent-hq') return null; // our own engine's threads
  if (/"source":\{/.test(head)) return null; // a sub-agent (e.g. the guardian)
  const source = stringField(head, 'source');
  if (source === 'exec') return null; // one-shot runs, not a session someone sits in
  return { threadId, cwd: stringField(head, 'cwd'), activity: lastActivity(tail) };
}

// The newest thing said or done in the tail: an assistant message, or the
// tool it called.
export function lastActivity(tail: string): string {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      const payload = record.payload ?? {};
      if (record.type === 'response_item' && payload['type'] === 'message' && payload['role'] === 'assistant') {
        const text = ((payload['content'] as { type?: string; text?: string }[] | undefined) ?? [])
          .map((part) => (part.type === 'output_text' ? part.text ?? '' : ''))
          .join(' ')
          .trim();
        if (text) return text.replace(/\s+/g, ' ').slice(0, 80);
      }
      if (record.type === 'event_msg' && payload['type'] === 'agent_message' && typeof payload['message'] === 'string' && payload['message'].trim()) {
        return payload['message'].replace(/\s+/g, ' ').trim().slice(0, 80);
      }
      if (record.type === 'response_item' && (payload['type'] === 'function_call' || payload['type'] === 'custom_tool_call') && typeof payload['name'] === 'string') {
        let detail = '';
        try {
          const args = JSON.parse(String(payload['arguments'] ?? '{}')) as Record<string, unknown>;
          const value = args['command'] ?? args['cmd'] ?? args['path'] ?? '';
          detail = Array.isArray(value) ? value.join(' ') : String(value);
        } catch {
          // custom tools carry free-form input
        }
        return `${payload['name']}${detail ? ` ${detail}` : ''}`.replace(/\s+/g, ' ').slice(0, 80);
      }
    } catch {
      // a partial line at the chunk boundary — keep looking
    }
  }
  return 'session open';
}

// Rollout files in the day folders inside the look-back window.
export async function codexRollouts(codexHome: string, now: number, lookbackMs: number): Promise<string[]> {
  const root = join(codexHome, 'sessions');
  const list = async (dir: string) => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  };
  const files: string[] = [];
  for (const year of await list(root)) {
    for (const month of await list(join(root, year))) {
      for (const day of await list(join(root, year, month))) {
        const dayStart = Date.UTC(Number(year), Number(month) - 1, Number(day));
        if (!Number.isFinite(dayStart) || now - dayStart > lookbackMs + 86_400_000) continue;
        for (const file of await list(join(root, year, month, day))) {
          if (file.startsWith('rollout-') && file.endsWith('.jsonl')) files.push(join(root, year, month, day, file));
        }
      }
    }
  }
  return files;
}

// Thread ids whose writer lock a Codex process holds right now.
export async function heldCodexThreads(codexHome: string): Promise<Set<string>> {
  const dir = join(codexHome, 'thread-writer-locks');
  const held = new Set<string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return held;
  }
  for (const name of names) {
    if (!name.endsWith('.lock') || name.startsWith('.')) continue;
    try {
      const fd = openSync(join(dir, name), 'r');
      try {
        readSync(fd, Buffer.alloc(1), 0, 1, 0);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EBUSY') held.add(name.replace(/\.lock$/, ''));
    }
  }
  return held;
}

// The owner's names for their threads (session_index.jsonl: {id, thread_name}).
// Re-read only when the file changed since `cache`.
export async function codexThreadNames(
  codexHome: string,
  cache?: { stamp: string; names: Map<string, string> },
): Promise<{ stamp: string; names: Map<string, string> }> {
  const path = join(codexHome, 'session_index.jsonl');
  const names = new Map<string, string>();
  try {
    const stats = await stat(path);
    const stamp = `${stats.mtimeMs}:${stats.size}`;
    if (cache && cache.stamp === stamp) return cache;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      try {
        const entry = JSON.parse(line) as { id?: string; thread_name?: string };
        if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name);
      } catch {
        // a partial last line
      }
    }
    return { stamp, names };
  } catch {
    return { stamp: '', names };
  }
}

export const codexSessionName = (facts: CodexSessionFacts, names: Map<string, string>): string =>
  names.get(facts.threadId) ?? (facts.cwd ? basename(facts.cwd) : 'Codex');
