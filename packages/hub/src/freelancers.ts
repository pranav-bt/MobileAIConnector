import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { HubBus } from './bus.js';
import { codexRollouts, codexSessionFacts, codexSessionName, codexThreadNames, heldCodexThreads, type CodexSessionFacts } from './codex-sessions.js';

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
//
// CODEX — the owner's Codex sessions (VS Code panel / codex CLI) show up the
// same way ("fx-" agents; codex-sessions.ts reads them): open while Codex
// holds the thread's writer lock, or written in the last 2 minutes. An
// instruction continues the thread through Agent HQ's own Codex app-server
// (the runner the orchestrator sets: every command/edit still goes through
// the policy) — in place when no window has it open, otherwise in a fork
// (Codex allows one writer per thread); later instructions continue the fork.

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
  engine?: 'claude' | 'codex';
}

// Continues a Codex thread with an instruction (set by the orchestrator).
export type CodexFreelancerRunner = (threadId: string, cwd: string, text: string, agentId: string) => Promise<{ reply: string; threadId: string }>;

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

async function readChunksAsync(path: string, size: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const headLength = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    let tail = '';
    if (size > headLength) {
      const tailLength = Math.min(TAIL_BYTES, size - headLength);
      const buffer = Buffer.alloc(tailLength);
      await handle.read(buffer, 0, tailLength, size - tailLength);
      tail = buffer.toString('utf8');
    }
    return head.toString('utf8') + '\n' + tail;
  } finally {
    await handle.close();
  }
}

interface TranscriptFacts {
  cwd: string | null;
  activity: string;
  tiny: boolean; // a one-shot run's transcript, not a terminal session
}

// null = one of the hub's own engine sessions. Own-session check: our engine
// prompts are the FIRST record of their transcript. Only look there — a
// terminal session's tail can legitimately quote these strings (editing this
// very codebase), and a file that STARTS with a compaction summary is always
// a real interactive session (SDK one-shots never compact).
function transcriptFacts(chunk: string, size: number): TranscriptFacts | null {
  const firstLines = chunk.split('\n').slice(0, 3).join('\n');
  const isOwnEngineSession =
    !firstLines.includes('"type":"summary"') && OWN_SESSION_MARKERS.some((marker) => firstLines.includes(marker));
  if (isOwnEngineSession) return null;
  return {
    cwd: extractCwd(chunk),
    activity: lastAssistantActivity(chunk),
    tiny: size < 32 * 1024 && chunk.split('\n').filter((line) => line.trim()).length < 8,
  };
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
  #children = new Map<string, { kill: () => void }>(); // live sidecar processes
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
      runner?: (sessionId: string, cwd: string, text: string) => Promise<string>; // tests inject; real spawns claude
      codexHome?: string | null; // tests inject; null = don't look; real ~/.codex
    },
  ) {
    this.#codexHome = options.codexHome === null ? null : (options.codexHome ?? join(homedir(), '.codex'));
    this.#bus = bus;
    this.#projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
    this.#outboxDir = options.outboxDir;
    this.#activeCwds = options.activeCwds ?? (() => []);
    this.#openSessionsOverride = options.openSessions ?? null;
    this.#runnerOverride = options.runner ?? null;
  }

  #runnerOverride: ((sessionId: string, cwd: string, text: string) => Promise<string>) | null = null;
  #codexHome: string | null;
  #codexRunner: CodexFreelancerRunner | null = null;
  // Rollout facts by path (re-read only when the file moves), thread names,
  // and the forks hub instructions continued in (agentId -> fork thread).
  #codexFacts = new Map<string, { mtimeMs: number; size: number; facts: CodexSessionFacts | null }>();
  #codexNames: { stamp: string; names: Map<string, string> } | undefined;
  #codexForks = new Map<string, string>();

  setCodexRunner(runner: CodexFreelancerRunner): void {
    this.#codexRunner = runner;
  }

  // The owner's open (or just-written) Codex sessions, newest first.
  async #codexCandidates(now: number, busyCwds: Set<string>): Promise<{ agentId: string; mtime: number; info: SessionInfo; activity: string; open: boolean }[]> {
    const home = this.#codexHome;
    if (!home) return [];
    const files = await codexRollouts(home, now, LOOKBACK_MS);
    if (files.length === 0) return [];
    const [held, names] = await Promise.all([heldCodexThreads(home), codexThreadNames(home, this.#codexNames)]);
    this.#codexNames = names;
    const seen = new Set<string>();
    const found: { agentId: string; mtime: number; info: SessionInfo; activity: string; open: boolean }[] = [];
    for (const path of files) {
      let stats;
      try {
        stats = await stat(path);
      } catch {
        continue;
      }
      seen.add(path);
      let cached = this.#codexFacts.get(path);
      if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
        let facts: CodexSessionFacts | null;
        try {
          const chunk = await readChunksAsync(path, stats.size);
          const split = chunk.indexOf('\n');
          facts = codexSessionFacts(basename(path), chunk.slice(0, Math.min(HEAD_BYTES, chunk.length)), split >= 0 ? chunk.slice(split) : chunk);
        } catch {
          continue; // mid-write or vanished; next tick retries
        }
        cached = { mtimeMs: stats.mtimeMs, size: stats.size, facts };
        this.#codexFacts.set(path, cached);
      }
      const facts = cached.facts;
      if (!facts) continue;
      const open = held.has(facts.threadId);
      if (!open && now - stats.mtimeMs > FALLBACK_WINDOW_MS) continue;
      if (facts.cwd && busyCwds.has(facts.cwd.toLowerCase())) continue; // a hub worker owns this dir right now
      found.push({
        agentId: `fx-${facts.threadId}`, // full id: Codex ids are time-ordered, prefixes collide
        mtime: stats.mtimeMs,
        info: { sessionId: facts.threadId, cwd: facts.cwd ?? '', name: codexSessionName(facts, names.names), engine: 'codex' },
        activity: facts.activity,
        open,
      });
    }
    for (const path of [...this.#codexFacts.keys()]) if (!seen.has(path)) this.#codexFacts.delete(path);
    return found.sort((a, b) => b.mtime - a.mtime);
  }

  describe(agentId: string): { name: string; cwd: string } | null {
    const info = this.#registry.get(agentId);
    return info ? { name: info.name, cwd: info.cwd } : null;
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

  #ticking = false;
  // Transcript facts by path, re-read only when a file's size or mtime moves:
  // a steady-state tick is a directory walk plus stats, never a re-read of
  // every transcript (the hub writes one per task, so they pile up fast).
  #transcripts = new Map<string, { mtimeMs: number; size: number; facts: TranscriptFacts | null }>();

  // Never overlaps and never blocks the event loop — the scan is async.
  #tick(): void {
    if (this.#ticking) return;
    this.#ticking = true;
    void this.#scan().finally(() => {
      this.#ticking = false;
    });
  }

  async #scan(): Promise<void> {
    try {
      this.#scanSessions();
      if (!existsSync(this.#projectsDir)) return;
      const now = Date.now();
      const busyCwds = new Set(this.#activeCwds().map((cwd) => cwd.toLowerCase()));

      // Gather candidate sessions, newest first.
      const candidates: { agentId: string; mtime: number; info: SessionInfo; activity: string }[] = [];
      const seenPaths = new Set<string>();
      let dirNames: string[];
      try {
        dirNames = await readdir(this.#projectsDir);
      } catch {
        return;
      }
      for (const dirName of dirNames) {
        const dir = join(this.#projectsDir, dirName);
        let files: string[];
        try {
          files = (await readdir(dir)).filter((file) => file.endsWith('.jsonl'));
        } catch {
          continue; // not a directory
        }
        for (const file of files) {
          const path = join(dir, file);
          let stats;
          try {
            stats = await stat(path);
          } catch {
            continue;
          }
          if (now - stats.mtimeMs > LOOKBACK_MS || stats.size === 0) continue;
          seenPaths.add(path);

          let cached = this.#transcripts.get(path);
          if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
            let facts: TranscriptFacts | null;
            try {
              facts = transcriptFacts(await readChunksAsync(path, stats.size), stats.size);
            } catch {
              continue; // mid-write or vanished; next tick retries
            }
            cached = { mtimeMs: stats.mtimeMs, size: stats.size, facts };
            this.#transcripts.set(path, cached);
          }
          const facts = cached.facts;
          if (!facts) continue; // our own engine session
          // Old AND tiny -> a finished one-shot run, not an open terminal.
          if (now - stats.mtimeMs > 60 * 60_000 && facts.tiny) continue;
          const cwd = facts.cwd;
          if (cwd && /\\Temp\\claude\\|\/tmp\/claude\//i.test(cwd)) continue; // scratchpad sessions, not real projects
          if (cwd && busyCwds.has(cwd.toLowerCase())) continue; // a hub worker owns this dir right now

          const sessionId = file.replace(/\.jsonl$/, '');
          candidates.push({
            agentId: `fl-${sessionId.slice(0, 24)}`,
            mtime: stats.mtimeMs,
            info: { sessionId, cwd: cwd ?? '', name: cwd ? basename(cwd) : dirName.replace(/^.*-/, '') || 'terminal' },
            activity: facts.activity,
          });
        }
      }
      for (const path of [...this.#transcripts.keys()]) {
        if (!seenPaths.has(path)) this.#transcripts.delete(path);
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
      // The owner's Codex sessions: open (writer lock held) or just written.
      visible = [...visible, ...(await this.#codexCandidates(now, busyCwds))];

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
            model: candidate.info.engine === 'codex' ? 'codex' : 'sonnet',
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
        model: this.#registry.get(agentId)?.engine === 'codex' ? 'codex' : 'sonnet',
        taskId: null,
        tokensUsed: 0,
        updatedAt: Date.now(),
      },
    });
  }

  // The owner's "kill all": stop every running sidecar instruction now.
  killAll(): void {
    for (const child of this.#children.values()) child.kill();
    this.#children.clear();
    this.#busy.clear();
  }

  // Continue the freelancer's conversation with an instruction. Resolves
  // with the session's reply (also pushed to the phone in full); the CALLER
  // (orchestrator) owns the task lifecycle, review, and QA around it.
  runInstruction(agentId: string, text: string): Promise<{ ok: true; name: string; reply: string } | { ok: false; name: string; error: string }> {
    const info = this.#registry.get(agentId);
    if (!info) return Promise.resolve({ ok: false, name: agentId, error: 'session not found' });
    if (!info.sessionId) {
      return Promise.resolve({ ok: false, name: info.name, error: 'no conversation yet — start one in that window first' });
    }
    if (this.#busy.has(agentId)) {
      return Promise.resolve({ ok: false, name: info.name, error: 'still working on the previous instruction' });
    }
    this.#busy.add(agentId);
    this.#patch(agentId, info.name, 'working', `HQ instruction: ${text.slice(0, 60)}`);

    const deliver = (reply: string) => {
      try {
        const fileName = `freelancer-${info.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-reply.md`;
        writeFileSync(
          join(this.#outboxDir, fileName),
          `# Freelancer ${info.name} — reply\n\n**Instruction:** ${text}\n\n---\n\n${reply}\n`,
        );
      } catch {
        /* full-text delivery is best-effort; the synopsis still lands on the task */
      }
    };

    if (info.engine === 'codex') {
      const runner = this.#codexRunner;
      if (!runner) {
        this.#busy.delete(agentId);
        this.#patch(agentId, info.name, 'idle', 'instruction failed');
        return Promise.resolve({ ok: false as const, name: info.name, error: 'Codex is not available on this hub' });
      }
      // A fork made earlier (their window had the thread open) carries the
      // hub's part of the conversation: continue that.
      const thread = this.#codexForks.get(agentId) ?? info.sessionId;
      return runner(thread, info.cwd, text, agentId).then(
        ({ reply, threadId }) => {
          this.#busy.delete(agentId);
          if (threadId !== info.sessionId) this.#codexForks.set(agentId, threadId);
          const note = threadId !== info.sessionId ? '(Continued in a fork of your Codex conversation — your Codex window has the original open.)\n\n' : '';
          this.#patch(agentId, info.name, 'idle', reply.replace(/\s+/g, ' ').slice(0, 80));
          deliver(note + reply);
          return { ok: true as const, name: info.name, reply: note + reply };
        },
        (error: Error) => {
          this.#busy.delete(agentId);
          this.#patch(agentId, info.name, 'idle', 'instruction failed');
          return { ok: false as const, name: info.name, error: error.message };
        },
      );
    }

    if (this.#runnerOverride) {
      return this.#runnerOverride(info.sessionId, info.cwd, text).then(
        (reply) => {
          this.#busy.delete(agentId);
          this.#patch(agentId, info.name, 'idle', reply.replace(/\s+/g, ' ').slice(0, 80));
          deliver(reply);
          return { ok: true as const, name: info.name, reply };
        },
        (error: Error) => {
          this.#busy.delete(agentId);
          this.#patch(agentId, info.name, 'idle', 'instruction failed');
          return { ok: false as const, name: info.name, error: error.message };
        },
      );
    }

    return new Promise((resolvePromise) => {
      const child = spawn('claude', ['-p', '--resume', info.sessionId, text], {
        cwd: info.cwd || undefined,
        shell: true,
        windowsHide: true,
      });
      this.#children.set(agentId, { kill: () => { try { child.kill(); } catch {} } });
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
        this.#children.delete(agentId);
        const reply = out.trim();
        if (code === 0 && reply) {
          deliver(reply);
          this.#patch(agentId, info.name, 'idle', reply.replace(/\s+/g, ' ').slice(0, 80));
          resolvePromise({ ok: true, name: info.name, reply });
        } else {
          this.#patch(agentId, info.name, 'idle', 'instruction failed');
          resolvePromise({
            ok: false,
            name: info.name,
            error: `${code ? `exit ${code}: ` : ''}${(err || reply || 'no output').slice(0, 160)}`,
          });
        }
      };
      child.on('close', settle);
      child.on('error', (error) => {
        out = '';
        err = error.message;
        settle(-1);
      });
    });
  }
}
