import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { HubBus } from './bus.js';

// Freelancers: plain Claude Code sessions on this machine.
//
// PRESENCE — transcripts alone can't tell "idle, waiting for input" from
// "closed" (both just stop writing). The precise signal is Claude Code's own
// IDE registry: ~/.claude/ide/*.lock lists {pid, workspaceFolders} for every
// IDE-attached session; locks whose pid is alive ARE the open sessions, and
// each shows its workspace's newest transcript (written <45s ago -> working,
// otherwise idle — however old). Plain terminal/-p sessions without a lock
// are covered by a recent-writes window. Tests inject openSessions and use
// the count-based path instead.
//
// INTERACTION — an instruction to a freelancer resumes that session's
// conversation headlessly (`claude -p --resume <id>`) in its own workspace;
// the reply comes back as an activity line and a report pushed to the phone.
// (The terminal window itself can't be typed into from outside — this
// continues the same conversation next to it.)

const POLL_MS = 5000;
const PROCESS_SCAN_MS = 15_000;
const LOOKBACK_MS = 30 * 24 * 60 * 60_000; // IDE windows can idle for weeks; locks decide presence
const FALLBACK_WINDOW_MS = 2 * 60_000; // used when the process scan fails
const WORKING_WINDOW_MS = 45_000;
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 64 * 1024;
const SIDECAR_TIMEOUT_MS = 15 * 60_000;

const OWN_SESSION_MARKERS = [
  'You are the master agent',
  'You are the lead of the',
  'File locations policy: you have full READ/SEARCH access',
];

interface SessionInfo {
  sessionId: string;
  cwd: string;
  name: string;
}

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

export class FreelancerManager {
  #bus: HubBus;
  #projectsDir: string;
  #outboxDir: string;
  #activeCwds: () => string[];
  #openSessionsOverride: (() => number) | null;

  #published = new Map<string, number>(); // agentId -> mtime last published
  #registry = new Map<string, SessionInfo>();
  #busy = new Set<string>(); // sidecar instruction in flight
  #openCount = -1; // test/fallback path only
  #openWorkspaces: string[] = []; // lowercased folders from live IDE locks
  #locksSeen = false;
  #lastScan = 0;
  #interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    bus: HubBus,
    options: {
      projectsDir?: string;
      outboxDir: string;
      activeCwds?: () => string[];
      openSessions?: () => number; // tests inject; real scans processes
    },
  ) {
    this.#bus = bus;
    this.#projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
    this.#outboxDir = options.outboxDir;
    this.#activeCwds = options.activeCwds ?? (() => []);
    this.#openSessionsOverride = options.openSessions ?? null;
  }

  start(): void {
    this.#tick();
    this.#interval = setInterval(() => this.#tick(), POLL_MS);
  }

  stop(): void {
    if (this.#interval) clearInterval(this.#interval);
  }

  // Refresh the open-session registry from ~/.claude/ide/*.lock: each lock
  // names {pid, workspaceFolders}; a lock with a live pid is an open session.
  // Stale locks (crashed/closed windows) fail the pid check and drop out.
  #scanSessions(): void {
    if (this.#openSessionsOverride) {
      this.#openCount = this.#openSessionsOverride();
      return;
    }
    const now = Date.now();
    if (now - this.#lastScan < PROCESS_SCAN_MS) return;
    this.#lastScan = now;

    const ideDir = join(homedir(), '.claude', 'ide');
    const locks: { pid: number; folders: string[] }[] = [];
    try {
      for (const file of readdirSync(ideDir)) {
        if (!file.endsWith('.lock')) continue;
        try {
          const parsed = JSON.parse(readChunks(join(ideDir, file), statSync(join(ideDir, file)).size)) as {
            pid?: number;
            workspaceFolders?: string[];
          };
          if (typeof parsed.pid === 'number' && Array.isArray(parsed.workspaceFolders)) {
            locks.push({ pid: parsed.pid, folders: parsed.workspaceFolders.filter((f) => typeof f === 'string') });
          }
        } catch {
          /* unreadable lock — skip */
        }
      }
    } catch {
      /* no ide dir — terminal-only machine */
    }
    if (locks.length === 0) {
      this.#locksSeen = false;
      return;
    }

    const pids = [...new Set(locks.map((lock) => lock.pid))];
    const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object Id`;
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        // PS 5.1 exits non-zero when ANY of the pids is gone, even with
        // SilentlyContinue — the alive ones are still on stdout, so parse
        // that and only treat empty-output-with-error as a real failure.
        const alive = new Set(
          (stdout ?? '')
            .split(/\r?\n/)
            .map((line) => Number(line.trim()))
            .filter((pid) => Number.isFinite(pid) && pid > 0),
        );
        if (alive.size === 0 && error) return; // keep last known registry
        const folders = new Set<string>();
        for (const lock of locks) {
          if (!alive.has(lock.pid)) continue;
          for (const folder of lock.folders) folders.add(folder.toLowerCase());
        }
        this.#openWorkspaces = [...folders];
        this.#locksSeen = true;
      },
    );
  }

  #tick(): void {
    try {
      this.#scanSessions();
      if (!existsSync(this.#projectsDir)) return;
      const now = Date.now();
      const busyCwds = new Set(this.#activeCwds().map((cwd) => cwd.toLowerCase()));

      // Gather candidate sessions, newest first.
      const candidates: { agentId: string; mtime: number; info: SessionInfo; activity: string }[] = [];
      for (const dirName of readdirSync(this.#projectsDir)) {
        const dir = join(this.#projectsDir, dirName);
        let files: string[];
        try {
          files = readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const file of files) {
          const path = join(dir, file);
          let stats;
          try {
            stats = statSync(path);
          } catch {
            continue;
          }
          if (now - stats.mtimeMs > LOOKBACK_MS || stats.size === 0) continue;

          const chunk = readChunks(path, stats.size);
          // Own-session check: our engine prompts are the FIRST record of
          // their transcript. Only look there — a terminal session's tail can
          // legitimately quote these strings (editing this very codebase), and
          // a file that STARTS with a compaction summary is always a real
          // interactive session (SDK one-shots never compact).
          const firstLines = chunk.split('\n').slice(0, 3).join('\n');
          const isOwnEngineSession =
            !firstLines.includes('"type":"summary"') &&
            OWN_SESSION_MARKERS.some((marker) => firstLines.includes(marker));
          if (isOwnEngineSession) continue;
          // One-shot runs (claude -p, old engine sessions) leave tiny
          // transcripts; a real terminal session accumulates records fast.
          // Old AND tiny -> not an open terminal.
          const age = now - stats.mtimeMs;
          if (age > 60 * 60_000 && stats.size < 32 * 1024 && chunk.split('\n').filter((l) => l.trim()).length < 8) {
            continue;
          }
          const cwd = extractCwd(chunk);
          if (cwd && /\\Temp\\|\/tmp\//i.test(cwd)) continue; // scratch sessions, not real projects
          if (cwd && busyCwds.has(cwd.toLowerCase())) continue; // a hub worker owns this dir right now

          const sessionId = file.replace(/\.jsonl$/, '');
          candidates.push({
            agentId: `fl-${sessionId.slice(0, 24)}`,
            mtime: stats.mtimeMs,
            info: { sessionId, cwd: cwd ?? '', name: cwd ? basename(cwd) : dirName.replace(/^.*-/, '') || 'terminal' },
            activity: lastAssistantActivity(chunk),
          });
        }
      }
      candidates.sort((a, b) => b.mtime - a.mtime);

      // Presence. Test/override path: top-N by count. Real path: one entry
      // per live IDE lock's workspace (its newest transcript, however old),
      // plus anything written in the last 2 minutes (plain terminal or -p
      // runs that have no lock). No locks at all -> recent-writes only.
      let visible: typeof candidates;
      if (this.#openCount >= 0) {
        visible = candidates.slice(0, this.#openCount);
      } else {
        const recent = candidates.filter((candidate) => now - candidate.mtime <= FALLBACK_WINDOW_MS);
        const byWorkspace: typeof candidates = [];
        if (this.#locksSeen) {
          for (const workspace of this.#openWorkspaces) {
            const newest = candidates.find((candidate) => candidate.info.cwd.toLowerCase() === workspace);
            if (newest) {
              byWorkspace.push(newest); // candidates are mtime-desc
            } else {
              // Open session, but nothing said in it yet (or only long ago):
              // still present in the office.
              byWorkspace.push({
                agentId: `fl-ws-${workspace.replace(/[^a-z0-9]+/g, '-').slice(-24)}`,
                mtime: 0,
                info: { sessionId: '', cwd: workspace, name: basename(workspace) },
                activity: 'no conversation yet',
              });
            }
          }
        }
        const merged = new Map<string, (typeof candidates)[number]>();
        for (const candidate of [...byWorkspace, ...recent]) merged.set(candidate.agentId, candidate);
        visible = [...merged.values()];
      }

      const seen = new Set<string>();
      for (const candidate of visible) {
        seen.add(candidate.agentId);
        this.#registry.set(candidate.agentId, candidate.info);
        if (this.#busy.has(candidate.agentId)) continue; // sidecar owns its status right now
        if (this.#published.get(candidate.agentId) === candidate.mtime) continue;
        this.#published.set(candidate.agentId, candidate.mtime);
        this.#bus.publish({
          type: 'agent.updated',
          agent: {
            id: candidate.agentId,
            name: candidate.info.name,
            role: 'freelancer',
            teamId: null,
            status: now - candidate.mtime <= WORKING_WINDOW_MS ? 'working' : 'idle',
            activity: candidate.activity,
            model: 'sonnet',
            taskId: null,
            tokensUsed: 0,
            updatedAt: now,
          },
        });
      }

      // Sessions that are no longer open leave the office (unless a sidecar
      // instruction is still running against them).
      for (const agentId of [...this.#published.keys()]) {
        if (!seen.has(agentId) && !this.#busy.has(agentId)) {
          this.#published.delete(agentId);
          this.#registry.delete(agentId);
          this.#bus.publish({ type: 'agent.removed', agentId });
        }
      }
    } catch {
      /* observation is best-effort; next tick retries */
    }
  }

  #activity(agentId: string, message: string): void {
    this.#bus.publish({ type: 'activity', entry: { agentId, taskId: null, message, at: Date.now() } });
  }

  #patch(agentId: string, name: string, status: 'working' | 'idle', activity: string): void {
    this.#bus.publish({
      type: 'agent.updated',
      agent: {
        id: agentId,
        name,
        role: 'freelancer',
        teamId: null,
        status,
        activity,
        model: 'sonnet',
        taskId: null,
        tokensUsed: 0,
        updatedAt: Date.now(),
      },
    });
  }

  // Continue the freelancer's conversation with an instruction from the
  // owner; the reply lands in the activity feed and (in full) on the phone.
  sendInstruction(agentId: string, text: string): void {
    const info = this.#registry.get(agentId);
    if (!info) {
      this.#activity('master', `freelancer message failed — session not found (${agentId})`);
      return;
    }
    if (!info.sessionId) {
      this.#activity(agentId, `freelancer ${info.name} has no conversation yet — start one in that window first`);
      return;
    }
    if (this.#busy.has(agentId)) {
      this.#activity(agentId, `freelancer ${info.name} is still working on the previous instruction`);
      return;
    }
    this.#busy.add(agentId);
    this.#patch(agentId, info.name, 'working', `HQ instruction: ${text.slice(0, 60)}`);
    this.#activity(agentId, `instruction sent to freelancer ${info.name}: ${text.slice(0, 45)}`);

    const child = spawn('claude', ['-p', '--resume', info.sessionId, text], {
      cwd: info.cwd || undefined,
      shell: true,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => {
      out += String(data);
      if (out.length > 400_000) out = out.slice(-400_000);
    });
    child.stderr.on('data', (data) => {
      err = (err + String(data)).slice(0, 2000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, SIDECAR_TIMEOUT_MS);

    const settle = (code: number | null) => {
      clearTimeout(timer);
      this.#busy.delete(agentId);
      const reply = out.trim();
      if (code === 0 && reply) {
        try {
          const fileName = `freelancer-${info.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-reply.md`;
          writeFileSync(
            join(this.#outboxDir, fileName),
            `# Freelancer ${info.name} — reply\n\n**Instruction:** ${text}\n\n---\n\n${reply}\n`,
          );
          this.#activity(agentId, `freelancer ${info.name} replied — full reply sent to your phone`);
        } catch {
          this.#activity(agentId, `freelancer ${info.name} replied (report delivery failed)`);
        }
        this.#patch(agentId, info.name, 'idle', reply.replace(/\s+/g, ' ').slice(0, 80));
      } else {
        this.#activity(
          agentId,
          `freelancer ${info.name} instruction failed${code ? ` (exit ${code})` : ''}: ${(err || reply || 'no output').slice(0, 80)}`,
        );
        this.#patch(agentId, info.name, 'idle', 'instruction failed');
      }
    };
    child.on('close', settle);
    child.on('error', () => settle(-1));
  }
}
