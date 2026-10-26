import type { EngineId, ModelSpec, Team } from '@agent-hq/shared';
import type { LockedDir } from '../orchestrator/util.js';

// The engine boundary. Anything that can run an agent (Claude Agent SDK
// today, a Codex adapter later) implements this and emits nothing but the
// shared event vocabulary via the callbacks.

// A console row as an engine reports it; the orchestrator adds the task,
// role, agent and time. Rows with the same id replace each other (a tool row
// goes 'running' → 'ok'/'error' with its output).
export interface EngineRow {
  id: string;
  kind: 'message' | 'thinking' | 'tool' | 'diff';
  text: string;
  detail?: string;
  tool?: string;
  state?: 'running' | 'ok' | 'error';
}

export interface WorkerRunCallbacks {
  onActivity(message: string): void;
  onTokens(totalTokens: number): void;
  onPermission(request: {
    toolName: string;
    command: string;
    reason: string;
  }): Promise<'approve' | 'deny'>;
  // The conversation id, as soon as it exists — so a task stopped mid-run
  // can still be continued.
  onSession?(sessionId: string): void;
  onTranscript?(row: EngineRow): void;
}

export interface WorkerRunResult {
  synopsis: string;
  tokens: number;
  // The engine's conversation id (Claude session / Codex thread), so the
  // same conversation can be continued later.
  sessionId?: string;
  // Whether the run wrote files (edits, or shell writes) — a follow-up that
  // changed nothing doesn't need another QA pass.
  filesChanged?: boolean;
}

// The owner's messages for a running worker (the task console's Send).
// Engines deliver them into the live conversation: Claude as new user
// turns, Codex by steering the active turn.
export interface WorkerInbox {
  // Next message, or null once the inbox is closed (blocks until one arrives).
  next(): Promise<string | null>;
  // Messages waiting right now (taken out of the queue).
  take(): string[];
  pending(): number;
  // Deliver live: the handler returns true if it took the message.
  subscribe(handler: (text: string) => boolean): () => void;
  close(): string[];
}

export interface OrchestratorEngine {
  // Cache reads as they happen (they're part of every token count, and
  // the Resources page shows their share).
  observeUsage?(onCacheRead: (tokens: number) => void): void;
  // Whether an engine can run on this PC at all (Codex needs its CLI).
  // Absent = every engine is.
  available?(engine: EngineId): boolean;

  // One model call, no tools — what master routing and lead reviews use.
  complete(args: { prompt: string; model: ModelSpec }): Promise<{ text: string; tokens: number }>;

  runWorker(args: {
    prompt: string;
    team: Team;
    model: ModelSpec;
    cwd: string;
    // Extra directory roots the worker's tools may roam (all subdirectories).
    extraDirs?: string[];
    // Agent HQ's own data dir: never writable except its open folders.
    locked?: LockedDir;
    // How many sub-agents the worker may run at once; 0 = none (a split part
    // is already one of several parallel workers). Defaults to the engine's.
    maxSubagents?: number;
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
    // The task's title (engines may label their conversation with it).
    title?: string;
    // Continue this conversation (same engine) instead of starting fresh;
    // `prompt` is then the owner's follow-up.
    resumeSessionId?: string;
    inbox?: WorkerInbox;
    // The owner's own conversation (a Codex freelancer's thread): left as
    // it is — not archived, no Agent HQ instructions — forked if it's open.
    foreign?: boolean;
    // A reviewer: may read and run read-only commands, never write (file
    // tools removed, shell writes refused, Codex sandbox read-only).
    readOnly?: boolean;
  }): Promise<WorkerRunResult>;
}
