import type { ModelTier, Team } from '@agent-hq/shared';
import type { OrchestratorEngine, WorkerRunCallbacks, WorkerRunResult } from './types.js';

// Deterministic engine for tests and offline development: routes by team-id
// keyword, "installs" trigger a permission request, everything resolves fast.
export class MockEngine implements OrchestratorEngine {
  async complete(args: { prompt: string; model: ModelTier }): Promise<{ text: string; tokens: number }> {
    if (args.prompt.includes('"teamId"')) {
      const teamIds = [...args.prompt.matchAll(/^- id: ([a-z0-9-]+)/gm)].map((match) => match[1] ?? '');
      const projectIds = [...args.prompt.matchAll(/^\* project: ([a-z0-9-]+)/gm)].map((match) => match[1] ?? '');
      const taskMatch = args.prompt.match(/Task: "([\s\S]*?)"\n/);
      const text = (taskMatch?.[1] ?? '').toLowerCase();
      const teamId = teamIds.find((id) => id && text.includes(id)) ?? teamIds[0] ?? 'coding';
      const projectId = projectIds.find((id) => id && text.includes(id)) ?? projectIds[0] ?? '';
      return {
        text: JSON.stringify({
          teamId,
          projectId,
          title: (taskMatch?.[1] ?? 'task').slice(0, 60),
          reason: 'mock routing by keyword',
        }),
        tokens: 12,
      };
    }
    // Lead-review prompts expect JSON {synopsis, memoryNote}.
    if (args.prompt.includes('"synopsis"')) {
      const memoryNote = args.prompt.toLowerCase().includes('remember') ? 'Mock lesson: remember this.' : null;
      return {
        text: JSON.stringify({ synopsis: 'Mock lead review: work checked, looks complete.', memoryNote }),
        tokens: 9,
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
    signal?: AbortSignal;
  }): Promise<WorkerRunResult> {
    const { callbacks, signal } = args;
    // Keyword triggers must fire on the task itself, not on the appended
    // background-context section (project history can mention "install").
    const taskText = (args.prompt.split('\n---\n')[0] ?? args.prompt).toLowerCase();
    callbacks.onActivity('mock: examining the task');
    // "edit-test" exercises the Edit permission path (auto-allowed by policy).
    if (taskText.includes('edit-test')) {
      const decision = await callbacks.onPermission({
        toolName: 'Edit',
        command: 'Edit mock-file.ts',
        reason: 'mock worker wants to edit a file',
      });
      callbacks.onActivity(decision === 'approve' ? 'mock: file edited' : 'mock: edit denied');
    }
    if (taskText.includes('install')) {
      const decision = await callbacks.onPermission({
        toolName: 'Bash',
        command: 'npm install mock-package',
        reason: 'mock worker wants to install a package',
      });
      if (signal?.aborted) throw new Error('aborted');
      callbacks.onActivity(decision === 'approve' ? 'mock: package installed' : 'mock: denied — working around it');
    }
    if (signal?.aborted) throw new Error('aborted');
    callbacks.onTokens(42);
    return { synopsis: 'Mock worker: completed the task as described.', tokens: 42 };
  }
}
