import type { ModelTier, Team } from '@agent-hq/shared';

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
  complete(args: { prompt: string; model: ModelTier }): Promise<{ text: string; tokens: number }>;

  runWorker(args: {
    prompt: string;
    team: Team;
    model: ModelTier;
    cwd: string;
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
  }): Promise<WorkerRunResult>;
}
