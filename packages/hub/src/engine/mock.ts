import type { ModelTier, Team } from '@agent-hq/shared';
import type { OrchestratorEngine, WorkerRunCallbacks, WorkerRunResult } from './types.js';

// Deterministic engine for tests and offline development: routes by team-id
// keyword, "installs" trigger a permission request, everything resolves fast.
export class MockEngine implements OrchestratorEngine {
  async complete(args: { prompt: string; model: ModelTier }): Promise<{ text: string; tokens: number }> {
    if (args.prompt.includes('"teamId"')) {
      const ids = [...args.prompt.matchAll(/^- id: ([a-z0-9-]+)/gm)].map((match) => match[1] ?? '');
      const taskMatch = args.prompt.match(/Task: "([\s\S]*?)"\n/);
      const text = (taskMatch?.[1] ?? '').toLowerCase();
      const teamId = ids.find((id) => id && text.includes(id)) ?? ids[0] ?? 'coding';
      return {
        text: JSON.stringify({
          teamId,
          title: (taskMatch?.[1] ?? 'task').slice(0, 60),
          reason: 'mock routing by keyword',
        }),
        tokens: 12,
      };
    }
    return { text: 'Mock lead review: work checked, looks complete.', tokens: 9 };
  }

  async runWorker(args: {
    prompt: string;
    team: Team;
    model: ModelTier;
    cwd: string;
    callbacks: WorkerRunCallbacks;
  }): Promise<WorkerRunResult> {
    const { callbacks } = args;
    callbacks.onActivity('mock: examining the task');
    if (args.prompt.toLowerCase().includes('install')) {
      const decision = await callbacks.onPermission({
        toolName: 'Bash',
        command: 'npm install mock-package',
        reason: 'mock worker wants to install a package',
      });
      callbacks.onActivity(decision === 'approve' ? 'mock: package installed' : 'mock: denied — working around it');
    }
    callbacks.onTokens(42);
    return { synopsis: 'Mock worker: completed the task as described.', tokens: 42 };
  }
}
