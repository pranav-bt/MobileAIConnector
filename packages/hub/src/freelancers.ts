import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { HubBus } from './bus.js';

// Freelancers: plain Claude Code terminal sessions running on this machine,
// observed read-only. Claude Code appends every live session to
// ~/.claude/projects/<cwd-slug>/<session>.jsonl — a recently-written file IS
// a live session. Each becomes a 'freelancer' agent in the office: name =
// the project folder, activity = the session's last visible action.
//
// The hub's own engine sessions write there too; they are filtered out by
// (a) cwd — a project workspace with a worker currently running — and
// (b) orchestration markers in the transcript (master/lead/worker prompts).

const POLL_MS = 5000;
const ACTIVE_WINDOW_MS = 2 * 60_000; // written recently -> shown
const WORKING_WINDOW_MS = 30_000; // written moments ago -> 'working'
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 64 * 1024;

const OWN_SESSION_MARKERS = [
  'You are the master agent',
  'You are the lead of the',
  'File locations policy: you have full READ/SEARCH access',
];

function readChunks(path: string, size: number): string {
  const fd = openSync(path, 'r');
  try {
    const headLength = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLength);
    readSync(fd, head, 0, headLength, 0);
    let tail = '';
    if (size > headLength) {
      const tailLength = Math.min(TAIL_BYTES, size - headLength);
      const buffer = Buffer.alloc(tailLength);
      readSync(fd, buffer, 0, tailLength, size - tailLength);
      tail = buffer.toString('utf8');
    }
    return head.toString('utf8') + '\n' + tail;
  } finally {
    closeSync(fd);
  }
}

function lastAssistantActivity(chunk: string): string {
  const lines = chunk.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.includes('"assistant"')) continue;
    try {
      const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue;
      for (const block of record.message.content as Record<string, unknown>[]) {
        if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
          const input = (block['input'] ?? {}) as Record<string, unknown>;
          const detail = input['command'] ?? input['file_path'] ?? input['url'] ?? input['pattern'] ?? '';
          return `${block['name']}${detail ? ` ${String(detail)}` : ''}`.slice(0, 80);
        }
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
          return block['text'].trim().slice(0, 80);
        }
      }
    } catch {
      /* partial line at the chunk boundary — keep looking */
    }
  }
  return 'session open';
}

function extractCwd(chunk: string): string | null {
  const match = chunk.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

export function startFreelancerObserver(
  bus: HubBus,
  options: { projectsDir?: string; activeCwds?: () => string[] } = {},
): { stop: () => void } {
  const projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
  const activeCwds = options.activeCwds ?? (() => []);
  const published = new Map<string, number>(); // agentId -> mtime last published

  const tick = () => {
    try {
      if (!existsSync(projectsDir)) return;
      const now = Date.now();
      const busyCwds = new Set(activeCwds().map((cwd) => cwd.toLowerCase()));
      const seen = new Set<string>();

      for (const dirName of readdirSync(projectsDir)) {
        const dir = join(projectsDir, dirName);
        let files: string[];
        try {
          files = readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
        } catch {
          continue; // not a directory
        }
        for (const file of files) {
          const path = join(dir, file);
          let stats;
          try {
            stats = statSync(path);
          } catch {
            continue;
          }
          if (now - stats.mtimeMs > ACTIVE_WINDOW_MS || stats.size === 0) continue;

          const chunk = readChunks(path, stats.size);
          if (OWN_SESSION_MARKERS.some((marker) => chunk.includes(marker))) continue; // our own engine session
          const cwd = extractCwd(chunk);
          if (cwd && busyCwds.has(cwd.toLowerCase())) continue; // a hub worker owns this dir right now

          const agentId = `fl-${file.replace(/\.jsonl$/, '').slice(0, 24)}`;
          seen.add(agentId);
          if (published.get(agentId) === stats.mtimeMs) continue; // nothing new
          published.set(agentId, stats.mtimeMs);
          bus.publish({
            type: 'agent.updated',
            agent: {
              id: agentId,
              name: cwd ? basename(cwd) : dirName.replace(/^.*-/, '') || 'terminal',
              role: 'freelancer',
              teamId: null,
              status: now - stats.mtimeMs <= WORKING_WINDOW_MS ? 'working' : 'idle',
              activity: lastAssistantActivity(chunk),
              model: 'sonnet',
              taskId: null,
              tokensUsed: 0,
              updatedAt: now,
            },
          });
        }
      }

      // Sessions that stopped writing age out of the office.
      for (const agentId of [...published.keys()]) {
        if (!seen.has(agentId)) {
          published.delete(agentId);
          bus.publish({ type: 'agent.removed', agentId });
        }
      }
    } catch {
      /* observation is best-effort; next tick retries */
    }
  };

  tick();
  const interval = setInterval(tick, POLL_MS);
  return { stop: () => clearInterval(interval) };
}
