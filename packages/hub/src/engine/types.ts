import type { ModelSpec, Team } from '@agent-hq/shared';
import type { LockedDir } from '../orchestrator/util.js';

// The engine boundary. Anything that can run an agent (Claude Agent SDK
// today, a Codex adapter later) implements this and emits nothing but the
// shared event vocabulary via the callbacks.

export interface WorkerRunCallbacks {
  onActivity(message: string): void;
  onTokens(totalTokens: number): void;
  onPermission(request: {
    toolName: string;
    command: string;
    reason: string;
  }): Promise<'approve' | 'deny'>;
}

export interface WorkerRunResult {
  synopsis: string;
  tokens: number;
}

export interface OrchestratorEngine {
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
  }): Promise<WorkerRunResult>;
}
